import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// hold_vs_settlement experiment — STEP 3: the GATED call.
// Same agent, same model/prompt/max_tokens as baseline, but now a usage_limit
// rule ($0.001/day, scoped only to this agent) is active. Hold=$0.002403 >
// limit > settle=$0.0001 (measured in baseline). Observe: DENIED -> rules
// evaluate on HOLD. APPROVED (+ settles) -> rules evaluate on SETTLEMENT.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 4000;
const PROMPT = 'In exactly one sentence, define "settlement" in payments.';
const AGENT_NAME = 'holdtest-agent-hvs';
const LLM_TIMEOUT_MS = 35000;
const SETTLE_WAIT_MS = 8000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function firstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidateKeys = ['data', 'transactions', 'accounts', 'items', 'results', 'records'];
  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function agentNameOf(txn) {
  return pick(txn.agent ?? {}, ['name', 'label']) ?? pick(txn, ['agentName', 'agent_name']);
}

function createdAtMs(obj) {
  const raw = pick(obj, ['createdAt', 'created_at']);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function costRowsOf(txn) {
  const rows = pick(txn, ['costs', 'costRows', 'cost_rows']);
  return Array.isArray(rows) ? rows : [];
}

function fiatAmountOf(row) {
  const raw = pick(row, ['fiatAmount', 'fiat_amount']);
  if (raw === undefined || raw === null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function splitCostRows(rows) {
  if (rows.length <= 1) {
    return { initialRow: null, finalRow: rows[0] ?? null };
  }
  const finalRow =
    rows.find((r) => pick(r, ['isActive', 'is_active']) === true) ??
    rows.find((r) => pick(r, ['supersededAt', 'superseded_at']) == null);
  const initialRow =
    rows.find((r) => pick(r, ['supersededAt', 'superseded_at']) != null) ??
    rows.find((r) => r !== finalRow);
  return { initialRow: initialRow ?? null, finalRow: finalRow ?? rows[0] };
}

async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log(`[gated2] Firing LLM call model=${MODEL} max_tokens=${MAX_TOKENS} prompt="${PROMPT}" agent=${AGENT_NAME} (rule active: $0.001/day limit)`);
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let httpStatus = null;
  let body = null;
  let errorMsg = null;
  try {
    const response = await sapiomFetch(ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS }),
      signal: controller.signal,
    });
    httpStatus = response.status;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
  } catch (err) {
    errorMsg = err?.message || String(err);
    console.error('[gated2] call threw:', errorMsg);
  } finally {
    clearTimeout(timeout);
  }
  console.log(`[gated2] HTTP status: ${httpStatus}`);
  console.log(`[gated2] body: ${JSON.stringify(body)}`);

  console.log(`[gated2] waiting ${SETTLE_WAIT_MS}ms for settlement...`);
  await sleep(SETTLE_WAIT_MS);

  console.log('[gated2] fetching /v1/transactions...');
  const rawTxns = await gov('/v1/transactions');
  const allTxns = firstArray(rawTxns);
  const agentTxns = allTxns
    .filter((t) => agentNameOf(t) === AGENT_NAME)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));

  // Newest txn for this agent (should be the gated call if it created one at all).
  const txn = agentTxns[0] ?? null;
  const costRows = txn ? costRowsOf(txn) : [];
  const { initialRow, finalRow } = splitCostRows(costRows);
  const hold = initialRow ? fiatAmountOf(initialRow) : finalRow ? fiatAmountOf(finalRow) : null;
  const settle = finalRow ? fiatAmountOf(finalRow) : null;

  console.log(`[gated2] newest txn id for agent: ${txn ? pick(txn, ['id']) : 'NONE'}`);
  console.log(`[gated2] newest txn outcome: ${txn ? pick(txn, ['outcome']) : 'n/a'}`);
  console.log(`[gated2] hold: ${hold}  settle: ${settle}`);

  // Also fetch the rule to see if it reflects any denial state / usage.
  let ruleAfter = null;
  try {
    ruleAfter = await gov('/v1/spending-rules/9c8c39ef-e4c4-47e1-9827-4f18a35fe04f?include=parameters,conditions,agents');
  } catch (err) {
    console.error('[gated2] failed to fetch rule state:', err?.message || err);
  }

  const result = {
    fetched_at: new Date().toISOString(),
    agent_name: AGENT_NAME,
    model: MODEL,
    max_tokens: MAX_TOKENS,
    prompt: PROMPT,
    http_status: httpStatus,
    error_message: errorMsg,
    newest_txn_for_agent: txn,
    hold,
    settle,
    raw_llm_response_body: body,
    rule_state_after: ruleAfter,
    all_agent_txns_count: agentTxns.length,
  };
  await writeFile(new URL('./hvs_gated2_result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log('[gated2] wrote hvs_gated2_result.json');
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
