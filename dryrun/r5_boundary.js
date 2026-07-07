import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// R5 — rule-boundary drain + BLAST RADIUS + CAP UTILIZATION measurement.
// Creates a $0.005/day usage_limit rule scoped to a throwaway agent, then
// fires SEQUENTIAL LLM calls (max_tokens=4000 -> hold $0.002403, settle
// $0.0001) until denied. Sequential (4s+ gaps) so no TOCTOU contamination.
//
// Discriminates how the cumulative ledger counts history:
//   - denial at call 3  -> history counted at HOLD values (2x0.002403 +
//     0.002403 = $0.007209 > $0.005)
//   - no denial by call 8 -> history counted at LIVE/SETTLED values
//     (settles shrink the cumulative after supersession)
// Either way: blast radius $ = cumulative authorized before stop;
// cap utilization = cumulative / limit at each step.
//
// MONEY SAFETY: balance pre-check (abort < $2.75), MAX_CALLS=8, worst-case
// exposure 8 x $0.002403 = $0.0192 transient holds / ~$0.0008 settled.
// Rule paused in finally.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 4000; // hold = $0.002403 (measured, hvs baseline)
const EXPECTED_HOLD = 0.002403;
const PROMPT = 'In exactly one sentence, define "budget" in payments.';
const AGENT_NAME = 'r5-boundary-agent';
const AGENT_LABEL = 'R5 Boundary Agent';
const RULE_NAME = 'r5-boundary-rule';
const LIMIT_USD = '0.005';
const MAX_CALLS = 8;
const BALANCE_FLOOR = 2.75;
const GAP_MS = 4500; // let settlement + cumulative ledger update between calls
const LLM_TIMEOUT_MS = 35000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gov(path, opts = {}) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'curl/8.6.0',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function availableBalance() {
  const { body } = await gov('/v1/accounts');
  const acct = (body?.data || [])[0] || {};
  return parseFloat(acct.availableBalance);
}

async function main() {
  // --- 1. balance pre-check -------------------------------------------------
  const bal0 = await availableBalance();
  console.log(`[r5] availableBalance pre-run: $${bal0}`);
  if (!Number.isFinite(bal0) || bal0 < BALANCE_FLOOR) {
    console.error(`[r5] ABORT: balance ${bal0} < floor ${BALANCE_FLOOR}`);
    process.exit(1);
  }

  // --- 2. find-or-create throwaway agent ------------------------------------
  let agentId = null;
  const agents = await gov('/v1/agents?page[limit]=100');
  const existing = (agents.body?.data || []).find(
    (a) => (a.attributes?.name || a.name) === AGENT_NAME
  );
  if (existing) {
    agentId = existing.id;
    console.log(`[r5] reusing agent ${AGENT_NAME} id=${agentId}`);
  } else {
    const created = await gov('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        label: AGENT_LABEL,
        name: AGENT_NAME,
        description:
          'Throwaway agent for R5 rule-boundary experiment; scoped rule only; safe to ignore.',
      }),
    });
    if (created.status !== 201) {
      console.error('[r5] agent create failed:', created.status, JSON.stringify(created.body));
      process.exit(1);
    }
    agentId = created.body.id;
    console.log(`[r5] created agent id=${agentId}`);
  }

  // --- 3. create the boundary rule (scoped, measurementScope=rule) ----------
  const ruleRes = await gov('/v1/spending-rules', {
    method: 'POST',
    body: JSON.stringify({
      name: RULE_NAME,
      ruleType: 'usage_limit',
      agentIds: [agentId],
      parameters: [
        {
          limitValue: LIMIT_USD,
          measurementType: 'sum_transaction_costs',
          intervalValue: 1,
          intervalUnit: 'days',
          isRolling: true,
          measurementScope: 'rule',
        },
      ],
    }),
  });
  if (ruleRes.status !== 201) {
    console.error('[r5] rule create failed:', ruleRes.status, JSON.stringify(ruleRes.body));
    process.exit(1);
  }
  const ruleId = ruleRes.body.id;
  let ruleVersion = ruleRes.body.version;
  const scopeEcho = ruleRes.body.parameters?.[0]?.measurementScope;
  console.log(`[r5] rule ${ruleId} created (version=${ruleVersion}, measurementScope=${scopeEcho})`);

  const calls = [];
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });

  try {
    // --- 4. sequential calls until denial -----------------------------------
    for (let i = 1; i <= MAX_CALLS; i++) {
      const projected = i * EXPECTED_HOLD;
      if (projected > 0.02) {
        console.log('[r5] cost guard tripped, stopping');
        break;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      const started = new Date().toISOString();
      let status = null;
      let body = null;
      let errorMsg = null;
      try {
        const res = await sapiomFetch(ROUTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'user', content: PROMPT }],
            max_tokens: MAX_TOKENS,
          }),
          signal: controller.signal,
        });
        status = res.status;
        body = await res.json().catch(() => null);
      } catch (err) {
        errorMsg = err?.message || String(err);
      } finally {
        clearTimeout(timeout);
      }
      const denied = status === 402;
      console.log(`[r5] call ${i}: HTTP ${status}${denied ? ' DENIED' : ''}${errorMsg ? ` err=${errorMsg}` : ''}`);
      calls.push({ i, started, http_status: status, denied, error: errorMsg, body_excerpt: JSON.stringify(body)?.slice(0, 400) });
      if (denied) break;
      const bal = await availableBalance();
      if (bal < BALANCE_FLOOR) {
        console.error('[r5] mid-run balance floor hit, stopping');
        break;
      }
      await sleep(GAP_MS);
    }

    // --- 5. settle wait + pull ledger truth ----------------------------------
    await sleep(6000);
    const txRes = await gov('/v1/transactions?page[limit]=100&sort=-created_at');
    const txns = (txRes.body?.data || txRes.body?.transactions || []).filter((t) => {
      const an = t.agent?.name || t.agentName;
      return an === AGENT_NAME;
    });
    const perTxn = txns.map((t) => {
      const costs = (t.costs || []).map((c) => ({
        fiat: parseFloat(c.fiatAmount),
        active: c.isActive,
        supersededAt: c.supersededAt,
      }));
      const hold = costs.find((c) => c.supersededAt) ?? costs[0] ?? null;
      const live = costs.find((c) => c.active) ?? null;
      const ar = (t.authorizationRequests || [])[0] || {};
      return {
        id: t.id,
        createdAt: t.createdAt,
        status: t.status,
        outcome: t.outcome,
        auth_status: ar.status,
        hold_usd: hold ? hold.fiat : null,
        live_usd: live ? live.fiat : null,
        n_cost_rows: costs.length,
        rule_current_value:
          ar.ruleExecutions?.[0]?.violations?.[0]?.currentValue ??
          ar.ruleExecutions?.[0]?.currentValue ??
          null,
      };
    });

    const allowed = perTxn.filter((t) => t.auth_status === 'authorized');
    const deniedTx = perTxn.filter((t) => t.auth_status === 'denied' || t.status === 'denied');
    const blastHold = allowed.reduce((s, t) => s + (t.hold_usd ?? t.live_usd ?? 0), 0);
    const blastSettled = allowed.reduce((s, t) => s + (t.live_usd ?? 0), 0);

    const result = {
      fetched_at: new Date().toISOString(),
      agent_name: AGENT_NAME,
      agent_id: agentId,
      rule_id: ruleId,
      limit_usd: parseFloat(LIMIT_USD),
      max_tokens: MAX_TOKENS,
      expected_hold_usd: EXPECTED_HOLD,
      calls,
      ledger_txns: perTxn,
      n_allowed: allowed.length,
      n_denied: deniedTx.length,
      blast_radius_hold_usd: blastHold,
      blast_radius_settled_usd: blastSettled,
      cap_utilization_hold_based: blastHold / parseFloat(LIMIT_USD),
      cap_utilization_settle_based: blastSettled / parseFloat(LIMIT_USD),
      denial_call_index: calls.find((c) => c.denied)?.i ?? null,
      interpretation:
        'denial at call 3 => cumulative counted at HOLD values; no denial by call 8 => cumulative counted at LIVE/SETTLED values',
    };
    await writeFile(new URL('./r5_boundary_result.json', import.meta.url), JSON.stringify(result, null, 2));
    console.log(`[r5] wrote r5_boundary_result.json — allowed=${allowed.length} denied=${deniedTx.length} blast(hold)=$${blastHold.toFixed(6)} blast(settled)=$${blastSettled.toFixed(6)}`);
  } finally {
    // --- 6. cleanup: pause the rule (no hard delete exists) -----------------
    const pause = await gov(`/v1/spending-rules/${ruleId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'paused', version: ruleVersion }),
    });
    console.log(`[r5] rule pause: HTTP ${pause.status} status=${pause.body?.status}`);
    if (pause.status !== 200 || pause.body?.status !== 'paused') {
      console.error('[r5] WARNING: rule may still be active — pause manually!');
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
