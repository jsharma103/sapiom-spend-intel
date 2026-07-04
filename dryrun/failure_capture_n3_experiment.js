import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// failure_capture_n3 — does "errored call captures its FULL pre-authorized
// hold, no refund" REPEAT? Prior evidence is N=1: the 128k-token rung of
// dryrun/hold_linearity_extension_experiment.js hit a 502 from OpenRouter and
// the full $0.076803 hold stayed isActive:true (no floor-settle, no release).
// See dryrun/hold_linearity_extension.md ("Important secondary finding").
//
// This script fires 3 MORE fresh max_tokens=128000 / gpt-4o-mini calls,
// SEQUENTIALLY, each a clean independent observation:
//   1. GET /v1/accounts (before)
//   2. fire one 128k call, short prompt
//   3. GET the resulting transaction (?include=costs) — active cost row,
//      isEstimate, isActive, supersededAt
//   4. GET /v1/accounts (after) — compute delta
//   5. record the transaction id
//
// Money safety (real wallet):
//  - Pre-check every iteration; ABORT remaining iterations if
//    availableBalance < $2.75 (binding floor; $0.50 hard floor is strictly
//    inside that so never separately reachable first).
//  - Spend cap for this run: $0.35 total captured/settled.
//  - NO retries of paid calls on error — an error is the EXPECTED outcome.
//  - NO loops beyond 3 iterations.
//  - If any iteration captures far more than the expected ~$0.0768 (i.e. the
//    delta exceeds $0.15), STOP firing further iterations immediately.
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
const MAX_TOKENS = 128000;
const N_ITERATIONS = 3;
const BETWEEN_ITER_SLEEP_MS = 5000;
const SETTLE_MS = 10000;
const LLM_TIMEOUT_MS = 35000;

const EXPECTED_HOLD_USD = 0.076803;
const FLOOR_USD = 0.0001;
const PRE_ITER_MIN_BALANCE_USD = 2.75; // binding floor (>$0.50 hard floor, so it always fires first)
const SPEND_CAP_USD = 0.35;
const ANOMALY_DELTA_USD = 0.15; // "far more than $0.0768" trip-wire

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Defensive payload helpers (mirrors hold_linearity_extension_experiment.js) --

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

function createdAtMs(obj) {
  const raw = pick(obj, ['createdAt', 'created_at']);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function agentNameOf(txn) {
  return pick(txn.agent ?? {}, ['name', 'label']) ?? pick(txn, ['agentName', 'agent_name']);
}

async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'curl/8.6.0',
    },
  });
  const status = res.status;
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* ignore non-JSON body */
  }
  if (!res.ok) {
    throw Object.assign(new Error(`GET ${path} failed: ${status}`), { status, body });
  }
  return { status, body };
}

async function getAccounts() {
  const { body } = await gov('/v1/accounts');
  return body;
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

async function findTransactionByAgentName(agentName) {
  const { body } = await gov('/v1/transactions');
  const all = firstArray(body);
  const matches = all
    .filter((t) => agentNameOf(t) === agentName)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a));
  return matches[0] ?? null;
}

async function getTransactionWithCosts(txnId) {
  const { body } = await gov(`/v1/transactions/${txnId}?include=costs`);
  return body;
}

function activeCostRow(txn) {
  const costs = Array.isArray(txn?.costs) ? txn.costs : [];
  return costs.find((c) => c.isActive === true) ?? costs[costs.length - 1] ?? null;
}

// Fires the LLM call and returns full detail so we can distinguish outcomes.
async function fireLlmCall(sapiomFetch) {
  console.log(`  Firing LLM call (max_tokens=${MAX_TOKENS})...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await sapiomFetch(ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: MAX_TOKENS,
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
      console.log(`  -> ERRORED (expected outcome). Body: ${JSON.stringify(errMsg).slice(0, 300)}`);
    } else {
      console.log('  -> Succeeded (unexpected for this rung, but recording as-is).');
    }
    return { ok: response.ok, status: response.status, bodyJson, bodyText };
  } catch (err) {
    console.error(`  LLM call threw:`, err?.message || err);
    return { ok: false, status: null, bodyJson: null, bodyText: String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}

function verdictFor({ activeCost, before, after }) {
  const delta = before !== null && after !== null ? before - after : null;
  if (activeCost !== null && Math.abs(activeCost - EXPECTED_HOLD_USD) < 0.005) return { verdict: 'CAPTURED', delta };
  if (activeCost !== null && activeCost <= FLOOR_USD + 0.00005) return { verdict: 'FLOOR', delta };
  if (delta !== null && Math.abs(delta) < 0.0005) return { verdict: 'RELEASED', delta };
  return { verdict: 'UNKNOWN', delta };
}

async function main() {
  const runResults = [];
  let totalSpend = 0;
  let aborted = false;
  let abortReason = null;

  for (let i = 1; i <= N_ITERATIONS; i++) {
    console.log(`\n=== Iteration ${i}/${N_ITERATIONS} ===`);
    const agentName = `failure-capture-n3-${i}`;

    // Step 1: pre-check.
    const preAccounts = await getAccounts();
    const preBalances = extractBalances(preAccounts);
    console.log(`  Pre-check: availableBalance=$${preBalances.available} totalBalance=$${preBalances.total}`);

    if (preBalances.available === null || preBalances.available < PRE_ITER_MIN_BALANCE_USD) {
      abortReason = `availableBalance ($${preBalances.available}) below floor ($${PRE_ITER_MIN_BALANCE_USD}) before iteration ${i}`;
      console.error(`ABORT: ${abortReason}`);
      aborted = true;
      break;
    }
    if (totalSpend >= SPEND_CAP_USD) {
      abortReason = `spend cap ($${SPEND_CAP_USD}) reached before iteration ${i} (spent so far $${totalSpend.toFixed(6)})`;
      console.error(`ABORT: ${abortReason}`);
      aborted = true;
      break;
    }

    // Step 2: fire the call.
    const sapiomFetch = createFetch({ apiKey: API_KEY, agentName });
    const callResult = await fireLlmCall(sapiomFetch);

    console.log(`  Waiting ${SETTLE_MS}ms for settlement...`);
    await sleep(SETTLE_MS);

    // Step 3: find + fetch the resulting transaction with cost rows.
    let txnSummary = null;
    let txn = null;
    let activeCost = null;
    let activeRow = null;
    try {
      txnSummary = await findTransactionByAgentName(agentName);
      if (txnSummary) {
        const txnId = pick(txnSummary, ['id', 'transactionId', 'transaction_id']);
        txn = await getTransactionWithCosts(txnId);
        activeRow = activeCostRow(txn);
        activeCost = activeRow ? parseFloat(pick(activeRow, ['fiatAmount', 'fiat_amount'])) : null;
      } else {
        console.warn('  WARNING: no transaction found for this agent name.');
      }
    } catch (err) {
      console.error('  Error fetching transaction:', err?.message || err);
    }

    // Step 4: post-check.
    const postAccounts = await getAccounts();
    const postBalances = extractBalances(postAccounts);
    console.log(`  Post-check: availableBalance=$${postBalances.available} totalBalance=$${postBalances.total}`);

    const { verdict, delta } = verdictFor({
      activeCost,
      before: preBalances.available,
      after: postBalances.available,
    });

    if (delta !== null && delta > 0) {
      totalSpend += delta;
    }

    console.log(
      `  Verdict: ${verdict} | activeCost=${activeCost} | balanceDelta=${delta !== null ? delta.toFixed(6) : 'n/a'}`
    );

    runResults.push({
      iteration: i,
      agentName,
      httpStatus: callResult.status,
      callOk: callResult.ok,
      rejectionMessage: !callResult.ok
        ? JSON.stringify(
            pick(callResult.bodyJson?.error ?? {}, ['message']) ?? callResult.bodyJson?.message ?? callResult.bodyText ?? null
          )
        : null,
      transactionId: txnSummary ? pick(txnSummary, ['id', 'transactionId', 'transaction_id']) : null,
      transactionOutcome: txn ? pick(txn, ['outcome']) : null,
      transactionStatus: txn ? pick(txn, ['status']) : null,
      activeCost,
      activeCostIsEstimate: activeRow ? pick(activeRow, ['isEstimate', 'is_estimate']) : null,
      activeCostIsActive: activeRow ? pick(activeRow, ['isActive', 'is_active']) : null,
      activeCostSupersededAt: activeRow ? pick(activeRow, ['supersededAt', 'superseded_at']) : null,
      allCostRowCount: Array.isArray(txn?.costs) ? txn.costs.length : null,
      balanceBefore: preBalances,
      balanceAfter: postBalances,
      delta,
      verdict,
    });

    // Anomaly trip-wire.
    if (delta !== null && Math.abs(delta) > ANOMALY_DELTA_USD) {
      abortReason = `iteration ${i} delta ($${delta.toFixed(6)}) exceeds anomaly threshold ($${ANOMALY_DELTA_USD}) — stopping before firing more.`;
      console.error(`ABORT (anomaly): ${abortReason}`);
      aborted = true;
      break;
    }

    if (i < N_ITERATIONS) {
      console.log(`  Sleeping ${BETWEEN_ITER_SLEEP_MS}ms before next iteration...`);
      await sleep(BETWEEN_ITER_SLEEP_MS);
    }
  }

  // --- Tally -----------------------------------------------------------
  const completed = runResults.filter((r) => !r.aborted);
  const errored = completed.filter((r) => r.callOk === false);
  const capturedOnError = errored.filter((r) => r.verdict === 'CAPTURED');
  const floorOnError = errored.filter((r) => r.verdict === 'FLOOR');
  const releasedOnError = errored.filter((r) => r.verdict === 'RELEASED');

  const meanCaptured =
    capturedOnError.length > 0
      ? capturedOnError.reduce((sum, r) => sum + (r.activeCost ?? 0), 0) / capturedOnError.length
      : null;

  console.log('\n=== TALLY (this run, N=' + completed.length + ') ===');
  console.log(`  Errored: ${errored.length}/${completed.length}`);
  console.log(`  Errored + CAPTURED full hold: ${capturedOnError.length}`);
  console.log(`  Errored + FLOOR settled: ${floorOnError.length}`);
  console.log(`  Errored + RELEASED: ${releasedOnError.length}`);
  console.log(`  Mean captured amount (of captured cases): $${meanCaptured}`);
  console.log(`  Total spend this run: $${totalSpend.toFixed(6)}`);

  const result = {
    fetched_at: new Date().toISOString(),
    model: MODEL,
    max_tokens: MAX_TOKENS,
    n_iterations_planned: N_ITERATIONS,
    n_iterations_completed: completed.length,
    aborted,
    abort_reason: abortReason,
    total_spend_usd_this_run: totalSpend,
    rows: runResults,
    tally: {
      errored: errored.length,
      capturedOnError: capturedOnError.length,
      floorOnError: floorOnError.length,
      releasedOnError: releasedOnError.length,
      meanCapturedUsd: meanCaptured,
    },
    prior_evidence: {
      n: 1,
      transactionId: 'd59fb015-f55f-4501-a3cb-247b6e091366',
      capturedUsd: EXPECTED_HOLD_USD,
    },
  };

  await writeFile(new URL('./failure_capture_n3_result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log('\nWrote failure_capture_n3_result.json');
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
