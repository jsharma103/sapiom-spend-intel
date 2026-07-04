import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// hold_vs_settlement experiment — STEP 4: TOCTOU variant.
// Rule RL-006 (holdtest-rule-hvs-toctou): limit $0.003/day, scoped only to
// holdtest-agent-hvs, measurementScope=rule. A single call's hold is
// ~$0.002403 (fits under $0.003) but 2+ concurrent holds (~$0.0048) would
// exceed it. Fire 3 concurrent identical calls and see whether the
// authorization check serializes correctly (~1 approved, rest denied) or
// races (more than 1 approved despite combined holds exceeding the limit).
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
const RULE_ID = 'e2c8139f-aef0-4986-b920-37f47ce47d18';
const CONCURRENT_CALLS = 3;
const LLM_TIMEOUT_MS = 35000;
const SETTLE_WAIT_MS = 10000;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fireOne(sapiomFetch, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const startedAt = Date.now();
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
  } finally {
    clearTimeout(timeout);
  }
  const elapsedMs = Date.now() - startedAt;
  console.log(`[toctou-${label}] status=${httpStatus} error=${errorMsg ?? 'none'} elapsedMs=${elapsedMs}`);
  return { label, httpStatus, body, errorMsg, elapsedMs };
}

async function main() {
  console.log(`[toctou] Firing ${CONCURRENT_CALLS} CONCURRENT calls against rule ${RULE_ID} (limit $0.003, single-call hold ~$0.0024)`);
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });

  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, (_, i) => fireOne(sapiomFetch, i))
  );

  console.log(`[toctou] waiting ${SETTLE_WAIT_MS}ms before inspecting ledger...`);
  await sleep(SETTLE_WAIT_MS);

  console.log('[toctou] fetching /v1/transactions...');
  const rawTxns = await gov('/v1/transactions');
  const allTxns = firstArray(rawTxns);
  const agentTxns = allTxns
    .filter((t) => agentNameOf(t) === AGENT_NAME)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
  const newest3 = agentTxns.slice(0, CONCURRENT_CALLS);

  const summary = newest3.map((t) => ({
    id: pick(t, ['id']),
    status: pick(t, ['status']),
    createdAt: pick(t, ['createdAt']),
    costs: (pick(t, ['costs']) || []).map((c) => ({
      fiatAmount: pick(c, ['fiatAmount']),
      isActive: pick(c, ['isActive']),
      supersededAt: pick(c, ['supersededAt']),
    })),
  }));

  console.log('[toctou] newest transactions for agent:');
  console.log(JSON.stringify(summary, null, 2));

  let accounts = null;
  try {
    accounts = await gov('/v1/accounts');
  } catch (err) {
    console.error('[toctou] failed to fetch accounts:', err?.message || err);
  }

  const approvedCount = outcomes.filter((o) => o.httpStatus === 200).length;
  const deniedCount = outcomes.filter((o) => o.httpStatus === 402 || o.errorMsg).length;
  console.log(`[toctou] approved=${approvedCount} denied/error=${deniedCount} of ${CONCURRENT_CALLS}`);

  const result = {
    fetched_at: new Date().toISOString(),
    rule_id: RULE_ID,
    agent_name: AGENT_NAME,
    concurrent_calls: CONCURRENT_CALLS,
    outcomes,
    newest_transactions_summary: summary,
    newest_transactions_raw: newest3,
    accounts_after: accounts,
    approved_count: approvedCount,
    denied_or_error_count: deniedCount,
  };
  await writeFile(new URL('./hvs_toctou_result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log('[toctou] wrote hvs_toctou_result.json');
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
