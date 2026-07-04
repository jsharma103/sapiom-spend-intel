import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Extrapolation experiment — two related questions about Sapiom's cost-hold
// mechanism, building on cap_experiment.js and hypothesis_test.js:
//
//   Experiment A ("scale-test", sequential): does the initial hold keep
//   scaling linearly with `max_tokens` once the cap gets large (2000 / 8000 /
//   16000), or does it plateau / deviate the way it did NOT at the smaller
//   caps tested in cap_experiment.js (100 / 400 / 900)? We compare the
//   hold/cap ratio ("hold-per-1k-tokens") at these larger caps against the
//   two known reference points from cap_experiment.js: 0.000243 @ cap=400
//   and 0.000543 @ cap=900.
//
//   Experiment B ("fleet-test", concurrent): does firing a burst of parallel
//   LLM calls cause the account balance to visibly dip mid-flight (because
//   holds are real money temporarily removed from the spendable balance),
//   or does the balance only move when costs are captured/settled (i.e.
//   holds are bookkeeping-only annotations on transactions, not real float)?
//   We poll /v1/accounts every 500ms while firing 10 concurrent calls and
//   look for a transient dip below the eventual settled balance.
//
// Both experiments use the same schema-defensive helpers as the reference
// scripts (field names for this API aren't formally documented), and the
// full raw data for both experiments is always written to
// extrapolation_result.json for manual inspection.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=...');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const PROMPT = 'In exactly two sentences, explain what double-entry bookkeeping is.';
const LLM_TIMEOUT_MS = 35000; // safety valve so a hung LLM call can't blow the runtime budget

// --- Experiment A config -----------------------------------------------------
const AGENT_NAME_A = 'scale-test';
const MAX_TOKENS_STEPS_A = [2000, 8000, 16000];
const BETWEEN_CALL_SLEEP_MS_A = 3000;
const SETTLE_MS_A = 8000;
// Reference hold/cap ratios observed in cap_experiment.js at smaller caps.
const REFERENCE_RATIOS = [
  { cap: 400, ratio: 0.000243 },
  { cap: 900, ratio: 0.000543 },
];
// How much the hold/cap ratio is allowed to vary across A's own data points
// before we call it "not constant" (i.e. plateau/deviation rather than linear).
const LINEARITY_REL_SPREAD_THRESHOLD = 0.25;

// --- Experiment B config -----------------------------------------------------
const AGENT_NAME_B = 'fleet-test';
const CONCURRENT_CALL_COUNT_B = 10;
const MAX_TOKENS_B = 900;
const POLL_INTERVAL_MS_B = 500;
const PRE_CALL_DELAY_MS_B = 2000; // fire the burst 2s after the poller starts
const POST_CALLS_SETTLE_MS_B = 8000; // keep polling this long after all calls settle
const HARD_MAX_POLL_MS_B = 60000; // safety cap in case settlement runs long
const HOLD_PER_CALL_ESTIMATE_B = 0.000543; // reuse cap_experiment's observed ratio @ cap=900
const DIP_BEYOND_SETTLED_THRESHOLD_USD = 0.001;

// --- Cost guard ---------------------------------------------------------------
const ESTIMATED_COST_USD_A = 0.007; // 3 calls, caps up to 16000
const ESTIMATED_COST_USD_B = CONCURRENT_CALL_COUNT_B * HOLD_PER_CALL_ESTIMATE_B; // 10 * 0.000543
const ESTIMATED_TOTAL_COST_USD = ESTIMATED_COST_USD_A + ESTIMATED_COST_USD_B;
const COST_GUARD_LIMIT_USD = 0.05;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Defensive payload helpers (schema access is best-effort) --------------

function firstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidateKeys = ['data', 'transactions', 'accounts', 'items', 'results', 'records'];
  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function shortId(id) {
  if (id === undefined || id === null) return 'null';
  const s = String(id);
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
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

function agentNameOf(txn) {
  return pick(txn.agent ?? {}, ['name', 'label']) ?? pick(txn, ['agentName', 'agent_name']);
}

function createdAtMs(obj) {
  const raw = pick(obj, ['createdAt', 'created_at']);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Split a transaction's cost rows into { initialRow, finalRow }, same
// convention as cap_experiment.js: initialRow = superseded hold, finalRow =
// live/current row.
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

function formatUsd(n) {
  return n === null || n === undefined ? 'n/a'.padStart(11) : `$${n.toFixed(6)}`.padStart(11);
}

function formatRatio(n) {
  return n === null || n === undefined ? 'n/a'.padStart(14) : n.toFixed(6).padStart(14);
}

// Plain fetch GET against the Sapiom governance/accounting API (curl-style,
// no @sapiom/fetch wrapper — this is a read against the accounting API, not
// a metered agent action).
async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'curl/8.6.0',
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function getTransactions() {
  return gov('/v1/transactions');
}

function getAccounts() {
  return gov('/v1/accounts');
}

function extractBalance(accountsPayload) {
  const balanceKeys = ['balance', 'balanceFiat', 'balance_fiat', 'availableBalance', 'available_balance'];
  const direct = pick(accountsPayload, balanceKeys);
  if (direct !== undefined) {
    const n = parseFloat(direct);
    return Number.isFinite(n) ? n : null;
  }
  const list = firstArray(accountsPayload);
  if (list.length) {
    const n = parseFloat(pick(list[0], balanceKeys));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function fireLlmCall(sapiomFetch, maxTokens, label) {
  console.log(`[${label}] Firing LLM call (max_tokens=${maxTokens})...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await sapiomFetch(ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    console.log(`[${label}]   -> HTTP status: ${response.status}`);
    try {
      await response.json();
    } catch (err) {
      console.error(`[${label}]   Failed to parse LLM response body:`, err?.message || err);
    }
    return { ok: response.ok, status: response.status };
  } catch (err) {
    console.error(`[${label}]   LLM call failed (max_tokens=${maxTokens}, likely cap too high for model):`, err?.message || err);
    return { ok: false, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Experiment A — hold linearity at scale (sequential)
// ---------------------------------------------------------------------------

async function runExperimentA() {
  console.log('\n=== EXPERIMENT A: HOLD LINEARITY AT SCALE (scale-test) ===');
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME_A });

  const callOutcomes = [];
  for (let i = 0; i < MAX_TOKENS_STEPS_A.length; i++) {
    const maxTokens = MAX_TOKENS_STEPS_A[i];
    const { ok, status } = await fireLlmCall(sapiomFetch, maxTokens, 'A');
    callOutcomes.push({ maxTokens, ok, status });
    if (i < MAX_TOKENS_STEPS_A.length - 1) {
      await sleep(BETWEEN_CALL_SLEEP_MS_A);
    }
  }

  console.log(`[A] All calls fired. Waiting ${SETTLE_MS_A}ms for cost settlement...`);
  await sleep(SETTLE_MS_A);

  console.log('[A] Fetching /v1/transactions...');
  const rawTransactions = await getTransactions();
  const allTxns = firstArray(rawTransactions);

  const agentTxns = allTxns
    .filter((t) => agentNameOf(t) === AGENT_NAME_A)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a)); // newest first

  const okCount = callOutcomes.filter((c) => c.ok).length;
  const newestMatch = agentTxns.slice(0, okCount);
  if (newestMatch.length < okCount) {
    console.warn(
      `[A] Warning: only found ${newestMatch.length} transaction(s) for agent "${AGENT_NAME_A}" (expected ${okCount} successful calls). ` +
        'Inspect extrapolation_result.json.'
    );
  }
  // Order-match oldest -> newest against the fire order of successful calls.
  const orderMatched = [...newestMatch].sort((a, b) => createdAtMs(a) - createdAtMs(b));

  let matchIdx = 0;
  const rows = callOutcomes.map((c) => {
    if (!c.ok) {
      return {
        maxTokens: c.maxTokens,
        error: true,
        status: c.status,
        transactionId: null,
        initialHold: null,
        finalCost: null,
        holdPer1kTokens: null,
      };
    }
    const txn = orderMatched[matchIdx++] ?? null;
    const costRows = txn ? costRowsOf(txn) : [];
    const { initialRow, finalRow } = splitCostRows(costRows);
    const initialHold = initialRow ? fiatAmountOf(initialRow) : finalRow ? fiatAmountOf(finalRow) : null;
    const finalCost = finalRow ? fiatAmountOf(finalRow) : null;
    const holdPer1kTokens = initialHold !== null && c.maxTokens ? (initialHold / c.maxTokens) * 1000 : null;
    return {
      maxTokens: c.maxTokens,
      error: false,
      status: c.status,
      transactionId: txn ? pick(txn, ['id', 'transactionId', 'transaction_id']) : null,
      initialHold,
      finalCost,
      holdPer1kTokens,
    };
  });

  console.log('\n--- EXPERIMENT A: HOLD LINEARITY TABLE ---');
  console.log(
    `${'max_tokens'.padStart(10)} | ${'initial hold'.padStart(13)} | ${'final'.padStart(11)} | ${'hold-per-1k-tokens'.padStart(19)} | txn`
  );
  console.log('-'.repeat(80));
  for (const r of rows) {
    const maxTokensStr = String(r.maxTokens).padStart(10);
    if (r.error) {
      console.log(`${maxTokensStr} | ${'ERROR'.padStart(13)} | ${'ERROR'.padStart(11)} | ${'ERROR'.padStart(19)} | -`);
      continue;
    }
    console.log(
      `${maxTokensStr} | ${formatUsd(r.initialHold)} | ${formatUsd(r.finalCost)} | ${formatRatio(r.holdPer1kTokens)} | ${shortId(
        r.transactionId
      )}`
    );
  }

  // --- Verdict: is hold/cap ratio roughly constant (linear), or does it
  // plateau/deviate at these larger caps compared to cap_experiment's
  // 400/900 reference points?
  const validRatios = rows
    .filter((r) => !r.error && r.initialHold !== null)
    .map((r) => r.initialHold / r.maxTokens);

  let verdict;
  if (validRatios.length < 2) {
    verdict = 'INSUFFICIENT DATA — fewer than 2 valid hold/cap data points (inspect extrapolation_result.json)';
  } else {
    const mean = validRatios.reduce((a, b) => a + b, 0) / validRatios.length;
    const spread = Math.max(...validRatios) - Math.min(...validRatios);
    const relSpread = mean === 0 ? Infinity : spread / mean;
    const refStr = REFERENCE_RATIOS.map((r) => `${r.ratio}@${r.cap}`).join(', ');
    verdict =
      relSpread <= LINEARITY_REL_SPREAD_THRESHOLD
        ? `HOLDS ~LINEAR at scale — hold/cap ratio roughly constant (rel. spread ${(relSpread * 100).toFixed(1)}%; cap_experiment reference: ${refStr})`
        : `PLATEAU/DEVIATION at scale — hold/cap ratio not constant (rel. spread ${(relSpread * 100).toFixed(1)}%; cap_experiment reference: ${refStr})`;
  }
  console.log('\n' + verdict);

  return {
    agent_name: AGENT_NAME_A,
    max_tokens_steps: MAX_TOKENS_STEPS_A,
    reference_ratios: REFERENCE_RATIOS,
    call_outcomes: callOutcomes,
    rows,
    verdict,
    matched_transactions_raw: orderMatched,
    raw_transactions_response: rawTransactions,
  };
}

// ---------------------------------------------------------------------------
// Experiment B — concurrent float (parallel)
// ---------------------------------------------------------------------------

async function runExperimentB() {
  console.log('\n=== EXPERIMENT B: CONCURRENT FLOAT (fleet-test) ===');
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME_B });

  console.log('[B] Recording initial balance...');
  const initialAccounts = await getAccounts();
  const initialBalance = extractBalance(initialAccounts);
  console.log(`[B] Initial balance: ${initialBalance ?? 'n/a'}`);

  const series = [];
  const pollStart = Date.now();
  let callsDone = false;
  let callsDoneAt = null;

  async function poller() {
    while (true) {
      const elapsed = Date.now() - pollStart;
      if (elapsed >= HARD_MAX_POLL_MS_B) break;
      if (callsDone && Date.now() - callsDoneAt >= POST_CALLS_SETTLE_MS_B) break;
      try {
        const accounts = await getAccounts();
        const balance = extractBalance(accounts);
        series.push({ t_ms: elapsed, timestamp: new Date().toISOString(), balance });
      } catch (err) {
        console.error(`[B] Poll error at t=${elapsed}ms:`, err?.message || err);
      }
      await sleep(POLL_INTERVAL_MS_B);
    }
  }

  async function fireBurst() {
    await sleep(PRE_CALL_DELAY_MS_B);
    console.log(`[B] Firing ${CONCURRENT_CALL_COUNT_B} concurrent LLM calls (max_tokens=${MAX_TOKENS_B})...`);
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CALL_COUNT_B }, (_, i) => fireLlmCall(sapiomFetch, MAX_TOKENS_B, `B-${i}`))
    );
    console.log('[B] Call statuses:');
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        console.log(`  [B-${i}] ${s.value.ok ? 'ok' : 'error'} (status=${s.value.status})`);
      } else {
        console.log(`  [B-${i}] rejected: ${s.reason?.message || s.reason}`);
      }
    });
    callsDone = true;
    callsDoneAt = Date.now();
    console.log(`[B] All calls settled; will keep polling for another ${POST_CALLS_SETTLE_MS_B}ms.`);
    return settled;
  }

  const [, callResults] = await Promise.all([poller(), fireBurst()]);

  console.log('[B] Fetching final balance...');
  const finalAccounts = await getAccounts();
  const finalBalance = extractBalance(finalAccounts);

  // Compact table: only rows where balance CHANGED from the previous kept row.
  const changedRows = [];
  let lastKept;
  for (const point of series) {
    if (changedRows.length === 0 || point.balance !== lastKept) {
      changedRows.push(point);
      lastKept = point.balance;
    }
  }

  console.log('\n--- EXPERIMENT B: BALANCE SERIES (changed rows only) ---');
  console.log(`${'t (s)'.padStart(8)} | balance`);
  console.log('-'.repeat(40));
  for (const row of changedRows) {
    console.log(`${(row.t_ms / 1000).toFixed(1).padStart(8)} | ${row.balance ?? 'n/a'}`);
  }

  const observedBalances = series.map((p) => p.balance).filter((b) => typeof b === 'number');
  const minBalance = observedBalances.length ? Math.min(...observedBalances) : null;
  const expectedDip = CONCURRENT_CALL_COUNT_B * HOLD_PER_CALL_ESTIMATE_B;
  const actualDrop =
    typeof initialBalance === 'number' && typeof finalBalance === 'number' ? initialBalance - finalBalance : null;

  let verdict;
  if (minBalance === null || typeof finalBalance !== 'number') {
    verdict = 'INSUFFICIENT DATA — could not determine balance values (inspect extrapolation_result.json)';
  } else if (minBalance < finalBalance - DIP_BEYOND_SETTLED_THRESHOLD_USD) {
    verdict = 'FLOAT REAL — balance dipped by holds mid-flight then recovered';
  } else {
    verdict = 'HOLDS ARE BOOKKEEPING-ONLY — balance moved only by settled costs';
  }

  console.log(`\nmin balance observed: ${minBalance ?? 'n/a'}`);
  console.log(`expected-dip-if-holds-hit-balance (10 x ~${HOLD_PER_CALL_ESTIMATE_B}): ~${expectedDip.toFixed(4)}`);
  console.log(`actual total drop start->end: ${actualDrop !== null ? actualDrop.toFixed(6) : 'n/a'}`);
  console.log('\n' + verdict);

  return {
    agent_name: AGENT_NAME_B,
    initial_balance: initialBalance,
    final_balance: finalBalance,
    balance_series_full: series,
    balance_series_changed: changedRows,
    call_statuses: callResults.map((s, i) =>
      s.status === 'fulfilled'
        ? { index: i, status: 'fulfilled', ok: s.value.ok, http_status: s.value.status }
        : { index: i, status: 'rejected', reason: String(s.reason?.message || s.reason) }
    ),
    min_balance: minBalance,
    expected_dip_if_holds_hit_balance: expectedDip,
    actual_drop_start_to_end: actualDrop,
    verdict,
    initial_accounts_raw: initialAccounts,
    final_accounts_raw: finalAccounts,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `Cost guard: estimated total $${ESTIMATED_TOTAL_COST_USD.toFixed(5)} ` +
      `(A: $${ESTIMATED_COST_USD_A.toFixed(5)}, B: $${ESTIMATED_COST_USD_B.toFixed(5)}) vs limit $${COST_GUARD_LIMIT_USD.toFixed(2)}`
  );
  if (ESTIMATED_TOTAL_COST_USD > COST_GUARD_LIMIT_USD) {
    console.error('Cost guard triggered: estimated total exceeds limit. Aborting before firing any calls.');
    process.exit(1);
  }

  const experimentA = await runExperimentA();
  const experimentB = await runExperimentB();

  const result = {
    fetched_at: new Date().toISOString(),
    cost_guard: {
      estimated_cost_usd_a: ESTIMATED_COST_USD_A,
      estimated_cost_usd_b: ESTIMATED_COST_USD_B,
      estimated_total_cost_usd: ESTIMATED_TOTAL_COST_USD,
      limit_usd: COST_GUARD_LIMIT_USD,
    },
    experiment_a: experimentA,
    experiment_b: experimentB,
  };

  const outPath = new URL('./extrapolation_result.json', import.meta.url);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath.pathname}`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
