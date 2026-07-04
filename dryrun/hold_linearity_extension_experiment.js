import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Hold-linearity extension experiment — builds on cap_experiment.js and
// extrapolation_experiment.js's Experiment A. Prior data (gpt-4o-mini,
// sequential, short prompt) confirmed the initial cost hold scales linearly
// with `max_tokens` at ~$0.0006/1k tokens, flat from 100 -> 16000 tokens
// (0.2% relative spread in hold-per-1k-tokens).
//
// This script extends the cap ladder to [16000, 32000, 64000, 128000] on the
// SAME model (openai/gpt-4o-mini) to see whether that linearity continues,
// bends, or the model itself rejects max_tokens once it exceeds its own
// completion-token ceiling (gpt-4o-mini's real max output is documented
// around 16384 tokens). We deliberately do NOT switch to a different model
// for the higher rungs: this account's hold-rate calibration ($0.0006/1k)
// is specific to gpt-4o-mini, and an uncalibrated model could place a hold
// of unknown size against a real wallet. A model-side rejection at/above
// its own cap is treated as a legitimate experimental finding in its own
// right (the hold is then implicitly bounded by the model, not the wallet).
//
// Money safety: real wallet. Balance is checked before the run (abort if
// availableBalance < $2.75) and re-checked specifically before the 128000
// step (abort that step only if availableBalance < $0.50). One call per
// cap, no retries. Calls run strictly sequentially with a pause between.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const PROMPT = 'In exactly two sentences, explain what double-entry bookkeeping is.';
const AGENT_NAME = 'hold-ext-test';
const MAX_TOKENS_STEPS = [16000, 32000, 64000, 128000];
const BETWEEN_CALL_SLEEP_MS = 4000;
const SETTLE_MS = 10000;
const LLM_TIMEOUT_MS = 35000;

const BASELINE_RATE_PER_1K = 0.0006; // $/1k tokens, established 100->16000
const PRE_RUN_MIN_BALANCE_USD = 2.75;
const PRE_128K_MIN_BALANCE_USD = 0.5;

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
  return n === null || n === undefined ? 'n/a'.padStart(12) : n.toFixed(7).padStart(12);
}

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

function extractBalances(accountsPayload) {
  const list = firstArray(accountsPayload);
  const acct = list[0] ?? accountsPayload;
  const available = parseFloat(pick(acct, ['availableBalance', 'available_balance']));
  const total = parseFloat(pick(acct, ['totalBalance', 'total_balance']));
  return {
    available: Number.isFinite(available) ? available : null,
    total: Number.isFinite(total) ? total : null,
  };
}

// Fires the LLM call and returns full detail, including any error body, so
// we can distinguish "model rejected max_tokens" from other failure modes.
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
    let bodyJson = null;
    let bodyText = null;
    try {
      bodyJson = await response.json();
    } catch (err) {
      try {
        bodyText = await response.text();
      } catch (_) {
        /* ignore */
      }
    }
    console.log(`  -> HTTP status: ${response.status}`);
    if (!response.ok) {
      const errMsg =
        pick(bodyJson?.error ?? {}, ['message']) ?? bodyJson?.message ?? bodyText ?? '(no body)';
      console.log(`  -> REJECTED. Error: ${JSON.stringify(errMsg).slice(0, 400)}`);
    }
    return {
      ok: response.ok,
      status: response.status,
      bodyJson,
      bodyText,
    };
  } catch (err) {
    console.error(`  LLM call threw (max_tokens=${maxTokens}):`, err?.message || err);
    return { ok: false, status: null, bodyJson: null, bodyText: String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  // --- Pre-run balance check ------------------------------------------------
  console.log('Checking account balance before run...');
  const preAccounts = await getAccounts();
  const preBalances = extractBalances(preAccounts);
  console.log(
    `  availableBalance=$${preBalances.available} totalBalance=$${preBalances.total}`
  );
  if (preBalances.available === null || preBalances.available < PRE_RUN_MIN_BALANCE_USD) {
    console.error(
      `ABORT: availableBalance ($${preBalances.available}) below pre-run floor ($${PRE_RUN_MIN_BALANCE_USD}). No calls fired.`
    );
    const result = {
      aborted: true,
      reason: 'pre-run balance floor',
      pre_run_balances: preBalances,
    };
    await writeFile(new URL('./hold_linearity_result.json', import.meta.url), JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });

  const callOutcomes = [];
  const balanceChecks = [];

  for (let i = 0; i < MAX_TOKENS_STEPS.length; i++) {
    const maxTokens = MAX_TOKENS_STEPS[i];

    if (maxTokens === 128000) {
      console.log('Re-checking balance before the 128000 step...');
      const midAccounts = await getAccounts();
      const midBalances = extractBalances(midAccounts);
      balanceChecks.push({ beforeMaxTokens: maxTokens, ...midBalances });
      console.log(`  availableBalance=$${midBalances.available}`);
      if (midBalances.available === null || midBalances.available < PRE_128K_MIN_BALANCE_USD) {
        console.error(
          `SKIP 128000 step: availableBalance ($${midBalances.available}) below floor ($${PRE_128K_MIN_BALANCE_USD}).`
        );
        callOutcomes.push({
          maxTokens,
          skipped: true,
          reason: 'availableBalance near floor before 128k step',
          ok: false,
          status: null,
        });
        break;
      }
    }

    const { ok, status, bodyJson, bodyText } = await fireLlmCall(sapiomFetch, maxTokens);
    callOutcomes.push({
      maxTokens,
      ok,
      status,
      rejectionMessage: !ok
        ? JSON.stringify(pick(bodyJson?.error ?? {}, ['message']) ?? bodyJson?.message ?? bodyText ?? null)
        : null,
    });

    if (i < MAX_TOKENS_STEPS.length - 1) {
      await sleep(BETWEEN_CALL_SLEEP_MS);
    }
  }

  console.log(`\nAll steps attempted. Waiting ${SETTLE_MS}ms for cost settlement...`);
  await sleep(SETTLE_MS);

  console.log('Fetching /v1/transactions...');
  const rawTransactions = await getTransactions();
  const allTxns = firstArray(rawTransactions);

  const agentTxns = allTxns
    .filter((t) => agentNameOf(t) === AGENT_NAME)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a)); // newest first

  // Every attempted call (ok or rejected-by-provider) still creates a
  // transaction row on Sapiom's side if it got past initial authorization,
  // so match against ALL non-skipped attempts, not just the ok ones.
  const attemptedCount = callOutcomes.filter((c) => !c.skipped).length;
  const newestMatch = agentTxns.slice(0, attemptedCount);
  const orderMatched = [...newestMatch].sort((a, b) => createdAtMs(a) - createdAtMs(b));

  let matchIdx = 0;
  const rows = callOutcomes.map((c) => {
    if (c.skipped) {
      return {
        maxTokens: c.maxTokens,
        skipped: true,
        reason: c.reason,
        transactionId: null,
        initialHold: null,
        finalCost: null,
        holdPer1kTokens: null,
        deviationFromBaselinePct: null,
      };
    }
    const txn = orderMatched[matchIdx++] ?? null;
    const costRows = txn ? costRowsOf(txn) : [];
    const { initialRow, finalRow } = splitCostRows(costRows);
    const initialHold = initialRow ? fiatAmountOf(initialRow) : finalRow ? fiatAmountOf(finalRow) : null;
    const finalCost = finalRow ? fiatAmountOf(finalRow) : null;
    const holdPer1kTokens = initialHold !== null && c.maxTokens ? (initialHold / c.maxTokens) * 1000 : null;
    const deviationFromBaselinePct =
      holdPer1kTokens !== null ? ((holdPer1kTokens - BASELINE_RATE_PER_1K) / BASELINE_RATE_PER_1K) * 100 : null;
    return {
      maxTokens: c.maxTokens,
      ok: c.ok,
      httpStatus: c.status,
      rejectionMessage: c.rejectionMessage,
      transactionId: txn ? pick(txn, ['id', 'transactionId', 'transaction_id']) : null,
      transactionStatus: txn ? pick(txn, ['status']) : null,
      transactionOutcome: txn ? pick(txn, ['outcome']) : null,
      initialHold,
      finalCost,
      holdPer1kTokens,
      deviationFromBaselinePct,
    };
  });

  console.log('\n=== HOLD LINEARITY EXTENSION RESULTS ===');
  console.log(
    `${'max_tokens'.padStart(10)} | ${'hold'.padStart(11)} | ${'final'.padStart(11)} | ${'$/1k'.padStart(12)} | ${'dev%'.padStart(8)} | status | txn`
  );
  console.log('-'.repeat(90));
  for (const r of rows) {
    const maxTokensStr = String(r.maxTokens).padStart(10);
    if (r.skipped) {
      console.log(`${maxTokensStr} | SKIPPED (${r.reason})`);
      continue;
    }
    const devStr = r.deviationFromBaselinePct !== null ? `${r.deviationFromBaselinePct.toFixed(2)}%`.padStart(8) : 'n/a'.padStart(8);
    console.log(
      `${maxTokensStr} | ${formatUsd(r.initialHold)} | ${formatUsd(r.finalCost)} | ${formatRatio(r.holdPer1kTokens)} | ${devStr} | ${String(
        r.httpStatus
      ).padStart(6)} | ${shortId(r.transactionId)}`
    );
  }

  // --- Post-run balance ------------------------------------------------------
  console.log('\nFetching final balance...');
  const postAccounts = await getAccounts();
  const postBalances = extractBalances(postAccounts);
  console.log(`  availableBalance=$${postBalances.available} totalBalance=$${postBalances.total}`);

  const settledSpend = rows
    .filter((r) => !r.skipped && r.finalCost !== null)
    .reduce((sum, r) => sum + r.finalCost, 0);
  const peakFrozenEstimate = rows
    .filter((r) => !r.skipped && r.initialHold !== null)
    .reduce((sum, r) => sum + r.initialHold, 0);

  // --- Verdict -----------------------------------------------------------
  const successfulRows = rows.filter((r) => !r.skipped && r.ok && r.holdPer1kTokens !== null);
  const firstRejectionIdx = rows.findIndex((r) => !r.skipped && !r.ok);
  let verdict;
  if (successfulRows.length === 0) {
    verdict = 'NO DATA — no successful calls above baseline; inspect rejectionMessage per row.';
  } else {
    const ratios = successfulRows.map((r) => r.holdPer1kTokens);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const spread = Math.max(...ratios) - Math.min(...ratios);
    const relSpreadPct = (spread / mean) * 100;
    const linear = relSpreadPct <= 5; // tight threshold consistent with prior 0.2% spread
    const highestOk = Math.max(...successfulRows.map((r) => r.maxTokens));
    if (firstRejectionIdx === -1) {
      verdict = linear
        ? `LINEAR through ${highestOk} — hold/1k spread ${relSpreadPct.toFixed(2)}% across successful rungs, all rungs succeeded.`
        : `BENDS by ${highestOk} — hold/1k spread ${relSpreadPct.toFixed(2)}% (not flat), all rungs succeeded.`;
    } else {
      const rejectedAt = rows[firstRejectionIdx].maxTokens;
      verdict = linear
        ? `LINEAR through ${highestOk}; CAPS at ${rejectedAt} — model (${MODEL}) rejected max_tokens=${rejectedAt} (hold linearity can't be probed past ${highestOk}k because the model caps completion tokens, so the hold is implicitly bounded by model max, not wallet).`
        : `BENDS by ${highestOk} (spread ${relSpreadPct.toFixed(2)}%) AND CAPS at ${rejectedAt} — model rejected max_tokens=${rejectedAt}.`;
    }
  }
  console.log('\nVERDICT: ' + verdict);

  const result = {
    fetched_at: new Date().toISOString(),
    model: MODEL,
    max_tokens_steps: MAX_TOKENS_STEPS,
    baseline_rate_per_1k: BASELINE_RATE_PER_1K,
    pre_run_balances: preBalances,
    mid_run_balance_checks: balanceChecks,
    post_run_balances: postBalances,
    settled_spend_usd: settledSpend,
    peak_frozen_estimate_usd: peakFrozenEstimate,
    rows,
    verdict,
    call_outcomes: callOutcomes,
    matched_transactions_raw: orderMatched,
    raw_transactions_response: rawTransactions,
  };

  await writeFile(new URL('./hold_linearity_result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log('\nWrote hold_linearity_result.json');
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
