import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// DOUBLE-COUNT CONFIRMATION — discriminating out-of-sample test.
//
// r5_boundary2 found: a usage_limit rule's cumulative counts SETTLED HISTORY
// 2x (engine believed 26 calls when 13 happened; every txn carries 2
// authorizationRequests -> join fan-out). That was inferred from ONE boundary
// (max_tokens=4000, limit=$0.005 -> denied call 14).
//
// This run tests a DIFFERENT (max_tokens, limit) point from a COLD START:
//   max_tokens=400 (hold $0.000243, settle $0.0001), limit=$0.004, fresh agent+rule.
//
// Two hypotheses make FAR-APART predictions -> discriminating, not a fit:
//   BUG (2x history):      engine = 2*(K-1)*0.0001 + 0.000243  -> denies call 20
//   NO BUG (correct sum):  engine =   (K-1)*0.0001 + 0.000243  -> denies call 39
// Denial ~20 confirms the doubling; ~39 refutes it (retract the bug).
//
// MONEY SAFETY: balance pre-check (abort < $2.75); sequential (4.5s gaps, no
// TOCTOU); MAX_CALLS=30 hard stop; expected settle ~20 x $0.0001 = $0.002;
// one denied hold $0.000243 frozen. measurementScope:"rule". Rule paused in finally.
// Full response bodies + headers captured per capture-policy.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) { console.error('SAPIOM_API_KEY not set'); process.exit(1); }

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 400;                 // hold $0.000243 (cap_experiment baseline)
const PROMPT = 'In exactly one sentence, define "reconciliation" in payments.';
const AGENT_NAME = 'doublecount-confirm-agent';
const AGENT_LABEL = 'Double-count Confirm Agent';
const RULE_NAME = 'doublecount-confirm-rule';
const LIMIT_USD = '0.004';
const PREDICT_BUG_DENIAL_CALL = 20;
const PREDICT_NOBUG_DENIAL_CALL = 39;
const MAX_CALLS = 30;                    // hard stop between the two predictions
const BALANCE_FLOOR = 2.75;
const GAP_MS = 4500;
const LLM_TIMEOUT_MS = 35000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gov(path, opts = {}) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0',
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function availableBalance() {
  const { body } = await gov('/v1/accounts');
  return parseFloat((body?.data || [])[0]?.availableBalance);
}

async function main() {
  const bal0 = await availableBalance();
  console.log(`[dc] availableBalance pre-run: $${bal0}`);
  if (!Number.isFinite(bal0) || bal0 < BALANCE_FLOOR) {
    console.error(`[dc] ABORT: ${bal0} < ${BALANCE_FLOOR}`); process.exit(1);
  }

  // fresh agent
  const created = await gov('/v1/agents', {
    method: 'POST',
    body: JSON.stringify({ label: AGENT_LABEL, name: AGENT_NAME,
      description: 'Cold-start agent for double-count confirmation; scoped rule only; safe to ignore.' }),
  });
  if (created.status !== 201) { console.error('[dc] agent create failed', created.status, JSON.stringify(created.body)); process.exit(1); }
  const agentId = created.body.id;
  console.log(`[dc] fresh agent ${agentId}`);

  // fresh rule
  const ruleRes = await gov('/v1/spending-rules', {
    method: 'POST',
    body: JSON.stringify({
      name: RULE_NAME, ruleType: 'usage_limit', agentIds: [agentId],
      parameters: [{ limitValue: LIMIT_USD, measurementType: 'sum_transaction_costs',
        intervalValue: 1, intervalUnit: 'days', isRolling: true, measurementScope: 'rule' }],
    }),
  });
  if (ruleRes.status !== 201) { console.error('[dc] rule create failed', ruleRes.status, JSON.stringify(ruleRes.body)); process.exit(1); }
  const ruleId = ruleRes.body.id;
  const ruleVersion = ruleRes.body.version;
  console.log(`[dc] fresh rule ${ruleId} limit $${LIMIT_USD} scope=${ruleRes.body.parameters?.[0]?.measurementScope}`);

  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const calls = [];
  let denialCall = null, denialViolation = null;

  try {
    for (let i = 1; i <= MAX_CALLS; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      let status = null, body = null, headers = null, err = null;
      try {
        const res = await sapiomFetch(ROUTER_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS }),
          signal: controller.signal,
        });
        status = res.status;
        headers = Object.fromEntries(res.headers.entries());
        body = await res.json().catch(() => null);
      } catch (e) { err = e?.message || String(e); }
      finally { clearTimeout(timeout); }
      const denied = status === 402;
      console.log(`[dc] call ${i}: HTTP ${status}${denied ? ' DENIED' : ''}`);
      calls.push({ i, http_status: status, denied, error: err, response_headers: headers, raw_response_body: body });
      if (denied) { denialCall = i; denialViolation = body; break; }
      const bal = await availableBalance();
      if (bal < BALANCE_FLOOR) { console.error('[dc] floor hit mid-run'); break; }
      await sleep(GAP_MS);
    }

    // pull the denied txn's engine currentValue
    await sleep(6000);
    const tx = await gov('/v1/transactions?page[limit]=100&sort=-created_at');
    const mine = (tx.body?.data || []).filter((t) => (t.agent?.name) === AGENT_NAME);
    const deniedTxn = mine.find((t) => (t.authorizationRequests || []).some((a) => a.status === 'denied'));
    let engineCurrentValue = null, engineReason = null;
    if (deniedTxn) {
      for (const ar of deniedTxn.authorizationRequests || []) {
        for (const re of ar.ruleExecutions || []) {
          const od = re.outputData || {};
          if (od.decision === 'DENIED') {
            engineReason = od.reason;
            for (const v of (od.metadata?.violations || [])) if (v.currentValue != null) engineCurrentValue = v.currentValue;
          }
        }
      }
    }
    const nAllowed = mine.filter((t) => (t.authorizationRequests || [])[0]?.status === 'authorized').length;

    const verdict =
      denialCall === null ? `NO DENIAL by call ${MAX_CALLS} — both hypotheses refuted, investigate`
      : Math.abs(denialCall - PREDICT_BUG_DENIAL_CALL) <= 1 ? `BUG CONFIRMED — denied call ${denialCall} ≈ predicted ${PREDICT_BUG_DENIAL_CALL} (2x-history)`
      : Math.abs(denialCall - PREDICT_NOBUG_DENIAL_CALL) <= 1 ? `BUG REFUTED — denied call ${denialCall} ≈ predicted ${PREDICT_NOBUG_DENIAL_CALL} (correct counting)`
      : `AMBIGUOUS — denied call ${denialCall}, between predictions ${PREDICT_BUG_DENIAL_CALL}/${PREDICT_NOBUG_DENIAL_CALL}`;

    const result = {
      fetched_at: new Date().toISOString(),
      agent_id: agentId, rule_id: ruleId,
      max_tokens: MAX_TOKENS, hold_usd_expected: 0.000243, settle_usd_expected: 0.0001, limit_usd: parseFloat(LIMIT_USD),
      predict_bug_denial_call: PREDICT_BUG_DENIAL_CALL,
      predict_nobug_denial_call: PREDICT_NOBUG_DENIAL_CALL,
      observed_denial_call: denialCall,
      n_allowed: nAllowed,
      engine_current_value: engineCurrentValue,
      engine_reason: engineReason,
      true_settled_history_at_denial: denialCall ? (denialCall - 1) * 0.0001 : null,
      verdict,
      calls,
    };
    await writeFile(new URL('./r5_doublecount_confirm_result.json', import.meta.url), JSON.stringify(result, null, 2));
    console.log(`[dc] wrote result — ${verdict}`);
    console.log(`[dc] engine currentValue=${engineCurrentValue} reason="${engineReason}"`);
  } finally {
    const cur = await gov(`/v1/spending-rules/${ruleId}`);
    const v = cur.body?.version ?? ruleVersion;
    const pause = await gov(`/v1/spending-rules/${ruleId}`, { method: 'PUT', body: JSON.stringify({ status: 'paused', version: v }) });
    console.log(`[dc] rule pause: HTTP ${pause.status} status=${pause.body?.status}`);
    if (pause.body?.status !== 'paused') console.error('[dc] WARNING: rule may still be active — pause manually!');
  }
}

main().catch((e) => { console.error('Fatal:', e?.stack || e); process.exit(1); });
