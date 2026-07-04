import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Experiment: does Sapiom's initial cost hold (the pre-capture authorization
// amount) scale with the `max_tokens` cap sent to the LLM, even when the
// model's actual answer is short and identical regardless of the cap?
//
// We fire the same short-answer prompt three times, only varying max_tokens
// (100 / 400 / 900), then inspect /v1/transactions for the resulting cost
// rows. Each transaction's `costs` array is expected to contain:
//   - a superseded row (supersededAt != null / isActive: false) representing
//     the initial hold placed at authorization time, and
//   - a live row (supersededAt == null / isActive: true) representing the
//     final captured cost.
// If the hold scales with max_tokens but the final captured cost stays flat
// (since the real answer length doesn't change), that confirms the hold is
// sized off the token cap rather than actual usage.
//
// Schema is treated defensively (this API isn't formally documented here),
// and the full raw response is always written to cap_experiment_result.json
// for manual inspection.
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
const AGENT_NAME = 'cap-test';
const MAX_TOKENS_STEPS = [100, 400, 900];
const BETWEEN_CALL_SLEEP_MS = 3000;
const SETTLE_MS = 8000;
const LLM_TIMEOUT_MS = 35000; // safety valve so a hung LLM call can't blow the runtime budget

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Defensive payload helpers (schema access is best-effort) --------------

function firstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidateKeys = ['data', 'transactions', 'items', 'results', 'records'];
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

// Split a transaction's cost rows into { initialRow, finalRow }.
// initialRow = the superseded hold (supersededAt set / isActive: false).
// finalRow   = the live/current row (supersededAt null / isActive: true).
// If there's only one row, it's treated as the final with no initial.
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

// ---------------------------------------------------------------------------

async function fireLlmCall(sapiomFetch, maxTokens) {
  console.log(`Firing LLM call (max_tokens=${maxTokens})...`);
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
    console.log(`  -> HTTP status: ${response.status}`);
    try {
      await response.json();
    } catch (err) {
      console.error('  Failed to parse LLM response body:', err?.message || err);
    }
    return response.status;
  } catch (err) {
    console.error(`  LLM call failed (max_tokens=${maxTokens}):`, err?.message || err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Plain fetch GET against the Sapiom governance/accounting API (curl-style,
// no @sapiom/fetch wrapper — this is a read against the accounting API, not
// a metered agent action).
async function getTransactions() {
  const res = await fetch(`${GOV_BASE}/v1/transactions`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'curl/8.6.0',
    },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/transactions failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function formatUsd(n) {
  return n === null || n === undefined ? 'n/a'.padStart(10) : `$${n.toFixed(6)}`.padStart(10);
}

function formatRevisionPct(initial, final) {
  if (initial === null || final === null || initial === 0) return 'n/a'.padStart(9);
  const pct = ((final - initial) / initial) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`.padStart(9);
}

async function main() {
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });

  // --- Step 1-4: fire the 3 calls sequentially, 3s apart -------------------
  for (let i = 0; i < MAX_TOKENS_STEPS.length; i++) {
    await fireLlmCall(sapiomFetch, MAX_TOKENS_STEPS[i]);
    if (i < MAX_TOKENS_STEPS.length - 1) {
      await sleep(BETWEEN_CALL_SLEEP_MS);
    }
  }

  console.log(`\nAll calls fired. Waiting ${SETTLE_MS}ms for cost settlement...`);
  await sleep(SETTLE_MS);

  // --- Step 5: fetch transactions, find the 3 newest for this agent -------
  console.log('\nFetching /v1/transactions...');
  const rawTransactions = await getTransactions();
  const allTxns = firstArray(rawTransactions);

  const agentTxns = allTxns
    .filter((t) => agentNameOf(t) === AGENT_NAME)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a)); // newest first

  const newestThree = agentTxns.slice(0, 3);
  if (newestThree.length < 3) {
    console.warn(
      `Warning: only found ${newestThree.length} transaction(s) for agent "${AGENT_NAME}" (expected 3). ` +
        'Inspect cap_experiment_result.json.'
    );
  }

  // Order-match oldest -> newest against the fire order [100, 400, 900].
  const orderMatched = [...newestThree].sort((a, b) => createdAtMs(a) - createdAtMs(b));

  const rows = orderMatched.map((txn, idx) => {
    const maxTokens = MAX_TOKENS_STEPS[idx] ?? null;
    const costRows = costRowsOf(txn);
    const { initialRow, finalRow } = splitCostRows(costRows);
    const initialCost = initialRow ? fiatAmountOf(initialRow) : null;
    const finalCost = finalRow ? fiatAmountOf(finalRow) : null;
    return {
      maxTokens,
      transactionId: pick(txn, ['id', 'transactionId', 'transaction_id']),
      createdAt: pick(txn, ['createdAt', 'created_at']),
      initialCost,
      finalCost,
      hadSingleRow: costRows.length <= 1,
    };
  });

  // --- Step 6: print the table ---------------------------------------------
  console.log('\n=== CAP EXPERIMENT RESULTS ===');
  console.log(
    `${'max_tokens'.padStart(10)} | ${'initial cost'.padStart(13)} | ${'final cost'.padStart(11)} | ${'revision %'.padStart(9)} | txn`
  );
  console.log('-'.repeat(70));
  for (const r of rows) {
    const maxTokensStr = String(r.maxTokens ?? 'n/a').padStart(10);
    if (r.hadSingleRow) {
      console.log(
        `${maxTokensStr} | ${'—'.padStart(13)} | ${formatUsd(r.finalCost)} | ${'n/a'.padStart(9)} | ${shortId(r.transactionId)}`
      );
    } else {
      console.log(
        `${maxTokensStr} | ${formatUsd(r.initialCost)} | ${formatUsd(r.finalCost)} | ${formatRevisionPct(
          r.initialCost,
          r.finalCost
        )} | ${shortId(r.transactionId)}`
      );
    }
  }

  // --- Step 7: verdict -------------------------------------------------------
  const initials = rows.map((r) => r.initialCost);
  const finals = rows.map((r) => r.finalCost);
  const haveAllData =
    rows.length === 3 && initials.every((v) => v !== null) && finals.every((v) => v !== null);

  let confirmed = false;
  if (haveAllData) {
    const monotonicIncrease =
      initials[0] <= initials[1] && initials[1] <= initials[2] && initials[0] < initials[2];
    const meanFinal = finals.reduce((a, b) => a + b, 0) / finals.length;
    const finalSpread = Math.max(...finals) - Math.min(...finals);
    const finalsFlat = meanFinal === 0 ? finalSpread === 0 : finalSpread / meanFinal <= 0.15;
    confirmed = monotonicIncrease && finalsFlat;
  }

  console.log('\n' + (confirmed ? 'HOLD SCALES WITH max_tokens: CONFIRMED' : 'NOT CONFIRMED — inspect cap_experiment_result.json'));

  // --- Step 8: write full raw data -------------------------------------------
  const result = {
    fetched_at: new Date().toISOString(),
    max_tokens_steps: MAX_TOKENS_STEPS,
    agent_name: AGENT_NAME,
    matched_rows: rows,
    matched_transactions_raw: orderMatched,
    raw_transactions_response: rawTransactions,
  };

  const outPath = new URL('./cap_experiment_result.json', import.meta.url);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath.pathname}`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
