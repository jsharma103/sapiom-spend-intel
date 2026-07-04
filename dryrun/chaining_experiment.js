import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// BUILD 3 — Workflow chaining experiment.
//
// Fires a 3-step "agent task" (search -> LLM summarize -> follow-up search)
// with the SAME traceExternalId across all 3 calls, to answer:
//   1. STITCH: does Sapiom "find-or-create" one internal trace across calls
//      sharing an externalId (per SDK docs / BACKLOG.md SDK CAPABILITIES)?
//   2. HOLD-STACKING: while step 2's LLM hold hasn't settled yet (settlement
//      latency for openrouter is p50 5.75s / p95 12.24s per findings.md), do
//      we fire step 3 with step 2's hold still live? If so, does the balance
//      dip by the SUM of concurrently-live holds (stacking) rather than just
//      the single largest one?
//   3. LATENCY: real wall-clock time for a 3-step chained task fired back-to-
//      back with no artificial waits.
//
// IMPORTANT SDK FINDING (verified locally, zero API calls, before writing
// this script): the per-request `(request).__sapiom = {...}` override
// documented in @sapiom/fetch's README does NOT survive in this SDK version.
// createFetch()'s internal `sapiomFetch` does `let request = new
// Request(input, init)` BEFORE reading `request.__sapiom` — and the
// native Fetch spec's `new Request(existingRequest)` constructor does NOT
// copy arbitrary expando properties (only recognized RequestInit fields:
// url/method/headers/body/etc). Verified with a local, no-network Node
// script:
//     const original = new Request('https://example.com');
//     original.__sapiom = { traceExternalId: 'x' };
//     new Request(original).__sapiom  // -> undefined
// So setting `.__sapiom` on a Request object you pass to `sapiomFetch()` is
// silently a no-op for metadata purposes in this SDK build. INSTEAD, this
// script bakes `traceExternalId` into the `createFetch({ ... })` CONFIG
// object once and reuses that ONE client instance for all 3 chained calls —
// `defaultMetadata.traceExternalId` is a closure variable set at client-
// creation time (fetch.js line ~78-79), not dependent on any Request
// round-trip, so this path is verified-correct from the SDK source.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=...');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const MIN_BALANCE_USD = 0.5;   // abort if availableBalance falls below this
const HARD_BUDGET_USD = 0.05;  // abort if projected/running total exceeds this (~$0.02 expected)
const POLL_INTERVAL_MS = 1000;
const POST_CHAIN_SETTLE_MS = 15000; // keep polling this long after step 3 resolves, to catch late settlement
const CALL_TIMEOUT_MS = 30000;

const args = process.argv.slice(2);
const FLAG_RUN = args.includes('--run');
const MODE = FLAG_RUN ? 'run' : 'dry';
// max_tokens for the LLM step. Default 900 is deliberately NOT a small/cheap
// value: cap_experiment_result.json confirms max_tokens=900 produces a real
// hold (~$0.000543) that later settles to ~$0.0001 (a multi-row supersession
// chain with a multi-second settlement window, per findings.md's settlement-
// latency section: openrouter p50 5.75s / p95 12.24s). A small max_tokens
// (e.g. 60) was tried first and produced only a SINGLE cost row with no
// separate hold/settle window at all (see RUN_LOG for that result) — too
// small to give the hold-stacking question in this experiment a fair test.
const MAX_TOKENS_ARG = args.find((a) => a.startsWith('--max-tokens='));
const LLM_MAX_TOKENS = MAX_TOKENS_ARG ? parseInt(MAX_TOKENS_ARG.split('=')[1], 10) : 900;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

function formatUsd(n) {
  return n === null || n === undefined ? 'n/a' : `$${Number(n).toFixed(6)}`;
}

function extractBalance(accountsPayload) {
  const list = accountsPayload?.data;
  if (Array.isArray(list) && list.length) {
    const n = parseFloat(pick(list[0], ['availableBalance']));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const PLAN = [
  { step: 1, service: 'search', estCostUsd: 0.01 },
  { step: 2, service: 'llm', estCostUsd: 0.005 },
  { step: 3, service: 'search', estCostUsd: 0.01 },
];
const PLANNED_TOTAL_USD = PLAN.reduce((s, e) => s + e.estCostUsd, 0);

async function main() {
  console.log(`Mode: ${MODE}`);
  console.log(`Planned total (generous estimate): ${formatUsd(PLANNED_TOTAL_USD)} vs hard budget guard ${formatUsd(HARD_BUDGET_USD)}`);

  console.log('\nChecking account balance (GET /v1/accounts)...');
  const accountsBefore = await gov('/v1/accounts');
  const balanceBefore = extractBalance(accountsBefore);
  console.log(`  availableBalance: ${formatUsd(balanceBefore)}`);

  if (MODE === 'dry') {
    console.log('\nDry mode — no calls fired. Pass --run to actually fire real calls (this spends real money).');
    console.log('Plan:');
    for (const p of PLAN) console.log(`  step ${p.step}: ${p.service} (est. ${formatUsd(p.estCostUsd)})`);
    return;
  }

  if (balanceBefore === null) {
    console.error('Could not determine availableBalance. Aborting for safety.');
    process.exit(1);
  }
  if (balanceBefore < MIN_BALANCE_USD) {
    console.error(`ABORT: availableBalance ${formatUsd(balanceBefore)} below required minimum ${formatUsd(MIN_BALANCE_USD)}.`);
    process.exit(1);
  }
  if (PLANNED_TOTAL_USD > HARD_BUDGET_USD) {
    console.error(`ABORT: planned total ${formatUsd(PLANNED_TOTAL_USD)} exceeds hard budget guard ${formatUsd(HARD_BUDGET_USD)}.`);
    process.exit(1);
  }

  const traceExternalId = `chain-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`\nShared traceExternalId for this chain: ${traceExternalId}`);

  const chainFetch = createFetch({ apiKey: API_KEY, agentName: 'chain-task', traceExternalId });

  // --- Polling (runs concurrently with the 3-step chain) --------------------
  const pollSnapshots = [];
  let chainDone = false;
  let chainDoneAt = null;
  const chainStartedAt = Date.now();

  async function poller() {
    while (true) {
      if (chainDone && Date.now() - chainDoneAt >= POST_CHAIN_SETTLE_MS) break;
      try {
        const [txns, accounts] = await Promise.all([gov('/v1/transactions'), gov('/v1/accounts')]);
        pollSnapshots.push({
          t_ms: Date.now() - chainStartedAt,
          timestamp: new Date().toISOString(),
          balance: extractBalance(accounts),
          txnCount: Array.isArray(txns?.data) ? txns.data.length : null,
        });
      } catch (err) {
        console.error(`Poll error at t=${Date.now() - chainStartedAt}ms:`, err?.message || err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  const stepLog = [];
  let runningCostEstimate = 0;

  async function fireStep(step, service, url, body) {
    if (runningCostEstimate + step.estCostUsd > HARD_BUDGET_USD) {
      console.error(`ABORT (running guard): step ${step.step} would exceed hard budget guard. Stopping chain.`);
      return { step: step.step, service, skipped: true, reason: 'budget guard' };
    }
    console.log(`\n[step ${step.step}] firing ${service} ...`);
    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const entry = { step: step.step, service, url, requestBody: body, startedAt: new Date(t0).toISOString() };
    try {
      const response = await chainFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      entry.httpStatus = response.status;
      let json = null;
      try {
        json = await response.json();
      } catch (err) {
        entry.parseError = err?.message || String(err);
      }
      entry.responseSample = JSON.stringify(json)?.slice(0, 500);
      entry.responseJson = json;
      console.log(`  -> HTTP ${response.status}`);
    } catch (err) {
      entry.error = err?.message || String(err);
      console.log(`  -> ERROR: ${entry.error}`);
    } finally {
      clearTimeout(timeout);
      entry.durationMs = Date.now() - t0;
      runningCostEstimate += step.estCostUsd;
    }
    stepLog.push(entry);
    return entry;
  }

  async function runChain() {
    // Step 1: search
    const s1 = await fireStep(PLAN[0], 'search (Linkup)', 'https://linkup.services.sapiom.ai/v1/search', {
      q: 'What is the x402 payment protocol used for AI agent payments?',
      depth: 'standard',
      outputType: 'sourcedAnswer',
    });

    // Step 2: LLM summarize step 1's answer (small max_tokens — cheap)
    const searchAnswer = s1?.responseJson?.answer || s1?.responseJson?.output || 'x402 is an agent payment protocol.';
    const s2 = await fireStep(PLAN[1], 'llm (OpenRouter)', 'https://openrouter.services.sapiom.ai/v1/chat/completions', {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: `Summarize this in exactly one short sentence: ${String(searchAnswer).slice(0, 800)}` }],
      max_tokens: LLM_MAX_TOKENS,
    });

    // Step 3: follow-up search, informed by step 2's summary when available
    const summary = s2?.responseJson?.choices?.[0]?.message?.content;
    const followUpQuery = summary
      ? `Follow-up: who invented the protocol described here: ${String(summary).slice(0, 200)}`
      : 'Who invented the x402 payment protocol?';
    await fireStep(PLAN[2], 'search (Linkup)', 'https://linkup.services.sapiom.ai/v1/search', {
      q: followUpQuery,
      depth: 'standard',
      outputType: 'sourcedAnswer',
    });

    chainDone = true;
    chainDoneAt = Date.now();
    console.log(`\nChain finished; will keep polling for another ${POST_CHAIN_SETTLE_MS / 1000}s to catch late settlement.`);
  }

  await Promise.all([poller(), runChain()]);

  console.log('\nFetching final transactions + accounts...');
  const finalTransactionsRaw = await gov('/v1/transactions');
  const accountsAfter = await gov('/v1/accounts');
  const balanceAfter = extractBalance(accountsAfter);

  const allTxns = Array.isArray(finalTransactionsRaw?.data) ? finalTransactionsRaw.data : [];
  const chainTxns = allTxns.filter((t) => pick(t, ['trace'])?.externalId === traceExternalId);

  // --- Analysis --------------------------------------------------------------
  const internalTraceIds = new Set(chainTxns.map((t) => t.traceId));
  const stitchConfirmed = chainTxns.length >= 2 && internalTraceIds.size === 1;

  // Hold-stacking: for each poll snapshot, count how many cost rows across
  // chainTxns were "live-but-not-final" (a hold, i.e. isActive/superseded_at
  // null AND part of a txn that later got superseded) at that instant. Since
  // we only polled balance (not full txn costs) during the run for speed, we
  // reconstruct stacking from the FINAL txn/cost timestamps instead: does
  // more than one chain-txn's hold window (authorizedAt -> live-cost
  // createdAt) overlap in wall-clock time?
  function costWindows(txn) {
    const costs = txn.costs || [];
    if (costs.length === 0) return null;
    const authorizedAt = txn.authorizedAt ? Date.parse(txn.authorizedAt) : null;
    const live = costs.find((c) => c.supersededAt == null) || costs[0];
    const liveCreatedAt = live?.createdAt ? Date.parse(live.createdAt) : null;
    return { authorizedAt, liveCreatedAt, holdAmount: costs[0]?.fiatAmount, liveAmount: live?.fiatAmount };
  }
  const windows = chainTxns.map((t) => ({ id: t.id, serviceName: t.serviceName, ...costWindows(t) }));
  let overlapDetected = false;
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      if (a.authorizedAt == null || a.liveCreatedAt == null || b.authorizedAt == null || b.liveCreatedAt == null) continue;
      const overlap = a.authorizedAt < b.liveCreatedAt && b.authorizedAt < a.liveCreatedAt;
      if (overlap) overlapDetected = true;
    }
  }

  const peakBalanceDip = pollSnapshots.length
    ? Math.max(...pollSnapshots.map((s) => (balanceBefore ?? 0) - (s.balance ?? balanceBefore ?? 0)))
    : null;

  const totalChainWallMs = stepLog.length ? stepLog[stepLog.length - 1].startedAt && (Date.parse(stepLog[stepLog.length - 1].startedAt) + stepLog[stepLog.length - 1].durationMs - Date.parse(stepLog[0].startedAt)) : null;

  const verdict = {
    stitchConfirmed,
    internalTraceIdCount: internalTraceIds.size,
    chainTxnCount: chainTxns.length,
    holdOverlapDetected: overlapDetected,
    peakBalanceDipUsd: peakBalanceDip,
    totalChainWallMs,
    note: stitchConfirmed
      ? 'Sapiom find-or-create grouped all chained calls under ONE internal traceId despite being separate transactions — trace-based cost-per-task attribution (BUILD 4) is viable.'
      : `Expected ${chainTxns.length} chain transactions to share one internal traceId; found ${internalTraceIds.size} distinct traceId(s) across ${chainTxns.length} matched transactions. Inspect chainTxns in this file for why (matching by trace.externalId may need adjustment, or find-or-create may require identical traceId hints too).`,
  };

  console.log('\n=== VERDICT ===');
  console.log(JSON.stringify(verdict, null, 2));

  const output = {
    ranAt: new Date().toISOString(),
    mode: MODE,
    traceExternalId,
    costGuard: { minBalanceRequiredUsd: MIN_BALANCE_USD, hardBudgetUsd: HARD_BUDGET_USD, plannedTotalUsd: PLANNED_TOTAL_USD, runningCostEstimateUsd: runningCostEstimate },
    balance: { beforeUsd: balanceBefore, afterUsd: balanceAfter },
    stepLog,
    pollSnapshots,
    chainTxns,
    windows,
    verdict,
  };

  const outPath = new URL('./chaining_result.json', import.meta.url);
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath.pathname}`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
