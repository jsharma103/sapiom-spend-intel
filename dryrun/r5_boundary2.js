import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// R5 continuation — drive the SAME rule/agent to an OBSERVED denial.
// Run 1 (r5_boundary_result.json): 8/8 allowed vs $0.005 limit — history is
// counted at LIVE/SETTLED values, not holds. Live-counting model predicts
// denial when cumulative_settled + current_hold > limit:
//   0.0008 (8 prior settles) + 0.0001k + 0.002403 > 0.005  ->  k >= 18.
// This run reactivates the rule and fires up to 22 more sequential calls to
// catch the denial and capture the violation's currentValue — the engine's
// own statement of what it summed.
// MONEY SAFETY: worst case 22 x $0.0001 settle + one $0.002403 denied-hold
// frozen. Rule paused in finally.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) { console.error('SAPIOM_API_KEY not set'); process.exit(1); }

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 4000;
const PROMPT = 'In exactly one sentence, define "budget" in payments.';
const AGENT_NAME = 'r5-boundary-agent';
const RULE_ID = 'f5759057-9b9c-4acd-b8e7-ea200e1c458f';
const MAX_CALLS = 22;
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

async function setRuleStatus(status) {
  // fetch current version first (optimistic concurrency)
  const cur = await gov(`/v1/spending-rules/${RULE_ID}`);
  const version = cur.body?.version ?? cur.body?.data?.attributes?.version;
  const res = await gov(`/v1/spending-rules/${RULE_ID}`, {
    method: 'PUT',
    body: JSON.stringify({ status, version }),
  });
  console.log(`[r5b] rule -> ${status}: HTTP ${res.status} (now version=${res.body?.version})`);
  return res;
}

async function main() {
  const bal0 = await availableBalance();
  console.log(`[r5b] availableBalance pre-run: $${bal0}`);
  if (!Number.isFinite(bal0) || bal0 < BALANCE_FLOOR) {
    console.error(`[r5b] ABORT: balance ${bal0} < floor ${BALANCE_FLOOR}`);
    process.exit(1);
  }

  await setRuleStatus('active');
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const calls = [];
  let denialBody = null;

  try {
    for (let i = 1; i <= MAX_CALLS; i++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      let status = null, body = null, errorMsg = null;
      try {
        const res = await sapiomFetch(ROUTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS }),
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
      console.log(`[r5b] call ${i}: HTTP ${status}${denied ? ' DENIED' : ''}${errorMsg ? ` err=${errorMsg}` : ''}`);
      calls.push({ i, http_status: status, denied, error: errorMsg });
      if (denied) { denialBody = body; break; }
      const bal = await availableBalance();
      if (bal < BALANCE_FLOOR) { console.error('[r5b] floor hit'); break; }
      await sleep(GAP_MS);
    }

    await sleep(6000);
    const txRes = await gov('/v1/transactions?page[limit]=100&sort=-created_at');
    const txns = (txRes.body?.data || []).filter((t) => (t.agent?.name || t.agentName) === AGENT_NAME);
    const deniedTxn = txns.find((t) => t.status === 'denied' || (t.authorizationRequests || []).some((a) => a.status === 'denied'));
    const violation = deniedTxn?.authorizationRequests?.[0]?.ruleExecutions?.[0];
    const nAllowedTotal = txns.filter((t) => (t.authorizationRequests || [])[0]?.status === 'authorized').length;
    const settledTotal = txns.reduce((s, t) => s + (t.costs || []).filter((c) => c.isActive).reduce((x, c) => x + parseFloat(c.fiatAmount || 0), 0), 0);

    const result = {
      fetched_at: new Date().toISOString(),
      rule_id: RULE_ID,
      limit_usd: 0.005,
      run2_calls: calls,
      denial_at_run2_call: calls.find((c) => c.denied)?.i ?? null,
      denial_http_body: denialBody,
      denied_txn_id: deniedTxn?.id ?? null,
      violation_excerpt: violation ? JSON.stringify(violation).slice(0, 1500) : null,
      totals_across_both_runs: {
        n_allowed: nAllowedTotal,
        settled_usd_live: settledTotal,
        note: 'includes run 1 (8 allowed) + run 2; settled = live cost rows on all agent txns incl. any frozen denied-hold',
      },
    };
    await writeFile(new URL('./r5_boundary2_result.json', import.meta.url), JSON.stringify(result, null, 2));
    console.log(`[r5b] wrote r5_boundary2_result.json — denial at run2 call ${result.denial_at_run2_call}, total allowed=${nAllowedTotal}, settled(live)=$${settledTotal.toFixed(6)}`);
    console.log(`[r5b] violation: ${result.violation_excerpt?.slice(0, 400)}`);
  } finally {
    await setRuleStatus('paused');
  }
}

main().catch((err) => { console.error('Fatal:', err?.stack || err); process.exit(1); });
