import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// TOCTOU LATENCY experiment — does the concurrency race (found at N=3,
// max_tokens=4000 in hold_vs_settlement_experiment.md: 2/3 leaked; NOT
// reproduced at N=10, max_tokens=500 in toctou_scale_experiment.md: 1/10,
// no leak) scale with CALL LATENCY, controlled via max_tokens (bigger
// max_tokens -> bigger pre-auth hold quoted via x402 "upto" scheme -> in
// principle a longer negotiation/settlement pipeline)?
//
// This is a direct fork of toctou_scale_experiment.js with two changes:
//   1. MAX_TOKENS is now a CLI parameter (argv[4]), so we can hold the
//      PROMPT fixed (identical to the N=10 fast run) and vary only
//      max_tokens — isolating latency-via-max_tokens as the sole
//      controlled variable.
//   2. FIXED A COUNTING BUG from the prior run: the old script counted a
//      transaction as "ALLOWED" if ANY ruleExecution decision for our rule
//      was ALLOWED — but every transaction gets a phase-1 PRE-NEGOTIATION
//      check (always ALLOWED, because the hold amount isn't known yet) in
//      addition to the real phase-2 POST-NEGOTIATION check. That bug
//      previously reported allowed=10/10 in the raw JSON; the .md report
//      manually corrected it to 1/10 by hand. This script now takes, per
//      transaction, the ruleExecution decision for our rule with the
//      LATEST completedAt as the one authoritative (phase-2) decision.
//
// Usage: node toctou_latency_experiment.js <ROUND_NAME> <CONCURRENT_CALLS> <MAX_TOKENS>
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}

const ROUND_NAME = process.argv[2];
const CONCURRENT_CALLS = parseInt(process.argv[3], 10);
const MAX_TOKENS = parseInt(process.argv[4], 10) || 500;
if (!ROUND_NAME || !Number.isFinite(CONCURRENT_CALLS) || CONCURRENT_CALLS < 2) {
  console.error('Usage: node toctou_latency_experiment.js <ROUND_NAME> <CONCURRENT_CALLS> <MAX_TOKENS>');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
// IDENTICAL prompt to the N=10 fast baseline (toctou_scale_experiment.js) so that
// max_tokens is the ONLY controlled variable differing between fast and slow rounds.
const PROMPT = 'Reply with exactly one word: "test".';
const AGENT_NAME = `race-lat-agent-${ROUND_NAME}`;
const LLM_TIMEOUT_MS = 45000;
const SETTLE_WAIT_MS = 12000;
const RULE_MULTIPLIER = 1.5; // limit = 1.5x a single call's measured hold (strictly between 1H and 2H)
const MAX_PEAK_HOLD_DOLLARS = 0.15; // money-safety cap: peak simultaneous frozen holds

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

// Extract, for a given transaction, every decision this specific rule made
// (its own ruleExecutions entries — phase-1 pre-negotiation AND phase-2
// post-negotiation), each tagged with completedAt so we can pick the
// authoritative (latest) one downstream.
function ruleDecisionsFor(txn, ruleId) {
  const ars = pick(txn, ['authorizationRequests']) || [];
  const decisions = [];
  for (const ar of ars) {
    const execs = pick(ar, ['ruleExecutions']) || [];
    for (const ex of execs) {
      if (pick(ex, ['ruleId']) === ruleId) {
        const out = pick(ex, ['outputData']) || {};
        decisions.push({
          decision: pick(out, ['decision']),
          reason: pick(out, ['reason']),
          violations: pick(pick(out, ['metadata']) || {}, ['violations']),
          completedAt: pick(ex, ['completedAt']),
        });
      }
    }
  }
  return decisions;
}

// FIX for the prior run's counting bug: the authoritative decision for a
// transaction is the ruleExecution with the LATEST completedAt (the
// post-negotiation / phase-2 check), not "any decision is ALLOWED".
function finalDecisionFor(decisions) {
  if (!decisions.length) return null;
  const sorted = [...decisions].sort((a, b) => {
    const ta = Date.parse(a.completedAt ?? '') || 0;
    const tb = Date.parse(b.completedAt ?? '') || 0;
    return tb - ta;
  });
  return sorted[0];
}

async function gov(path, opts = {}) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0', 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function getAccounts() {
  const raw = await gov('/v1/accounts');
  const acct = firstArray(raw)[0];
  return {
    availableBalance: parseFloat(pick(acct, ['availableBalance'])),
    unavailableBalance: parseFloat(pick(acct, ['unavailableBalance'])),
    totalBalance: parseFloat(pick(acct, ['totalBalance'])),
  };
}

async function createAgent(name) {
  const body = await gov('/v1/agents', {
    method: 'POST',
    body: JSON.stringify({
      label: `Race Latency Test Agent (${ROUND_NAME})`,
      name,
      description:
        'Throwaway agent created for the TOCTOU-latency concurrency experiment (dryrun/toctou_latency_experiment.md). Never used for real traffic. Safe to ignore.',
    }),
  });
  return body;
}

async function createRule(name, agentId, limitValue) {
  const body = await gov('/v1/spending-rules', {
    method: 'POST',
    body: JSON.stringify({
      name,
      ruleType: 'usage_limit',
      agentIds: [agentId],
      parameters: [
        {
          limitValue: limitValue.toFixed(6),
          measurementType: 'sum_transaction_costs',
          intervalValue: 1,
          intervalUnit: 'days',
          isRolling: true,
          measurementScope: 'rule',
        },
      ],
    }),
  });
  return body;
}

async function pauseRule(ruleId, version) {
  return gov(`/v1/spending-rules/${ruleId}`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'paused', version }),
  });
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
  console.log(`[${ROUND_NAME}-${label}] status=${httpStatus} error=${errorMsg ?? 'none'} elapsedMs=${elapsedMs}`);
  return { label, httpStatus, body, errorMsg, elapsedMs, startedAt };
}

async function fetchAgentTransactions(agentName, take) {
  const raw = await gov('/v1/transactions?page%5Blimit%5D=100');
  const all = firstArray(raw);
  return all
    .filter((t) => agentNameOf(t) === agentName)
    .sort((a, b) => createdAtMs(b) - createdAtMs(a))
    .slice(0, take);
}

async function main() {
  const report = {
    round: ROUND_NAME,
    concurrent_calls: CONCURRENT_CALLS,
    max_tokens: MAX_TOKENS,
    started_at: new Date().toISOString(),
  };

  console.log(`[${ROUND_NAME}] === Pre-check: account balance ===`);
  const before = await getAccounts();
  console.log(`[${ROUND_NAME}] before:`, before);
  report.accounts_before = before;
  if (before.availableBalance < 2.75 || before.availableBalance < 0.5) {
    throw new Error(`ABORT: availableBalance ${before.availableBalance} below floor`);
  }

  console.log(`[${ROUND_NAME}] === Step 1: create throwaway agent ${AGENT_NAME} ===`);
  const agent = await createAgent(AGENT_NAME);
  console.log(`[${ROUND_NAME}] agent created:`, agent.id, agent.formattedId);
  report.agent = agent;

  console.log(`[${ROUND_NAME}] === Step 2: baseline call (no rule active) to measure real hold + latency, max_tokens=${MAX_TOKENS} ===`);
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const baselineOutcome = await fireOne(sapiomFetch, 'baseline');
  await sleep(SETTLE_WAIT_MS);
  const baselineTxns = await fetchAgentTransactions(AGENT_NAME, 1);
  const baselineTxn = baselineTxns[0] ?? null;
  const baselineCosts = baselineTxn ? costRowsOf(baselineTxn) : [];
  const { initialRow: baseInitial, finalRow: baseFinal } = splitCostRows(baselineCosts);
  const baselineHold = baseInitial ? fiatAmountOf(baseInitial) : baseFinal ? fiatAmountOf(baseFinal) : null;
  const baselineSettle = baseFinal ? fiatAmountOf(baseFinal) : null;
  console.log(`[${ROUND_NAME}] baseline hold=${baselineHold} settle=${baselineSettle} elapsedMs=${baselineOutcome.elapsedMs}`);
  report.baseline_outcome = baselineOutcome;
  report.baseline_hold = baselineHold;
  report.baseline_settle = baselineSettle;
  report.baseline_elapsed_ms = baselineOutcome.elapsedMs;
  report.baseline_txn = baselineTxn;

  if (!baselineHold || baselineHold <= 0) {
    throw new Error(`ABORT: could not measure a positive baseline hold (got ${baselineHold})`);
  }

  // MONEY SAFETY: abort if peak simultaneous frozen holds would exceed the cap.
  const peakHoldDollars = baselineHold * CONCURRENT_CALLS;
  console.log(`[${ROUND_NAME}] peak simultaneous holds if all ${CONCURRENT_CALLS} land together: $${peakHoldDollars.toFixed(6)} (cap $${MAX_PEAK_HOLD_DOLLARS})`);
  report.peak_hold_dollars_projected = peakHoldDollars;
  if (peakHoldDollars > MAX_PEAK_HOLD_DOLLARS) {
    throw new Error(
      `ABORT: projected peak hold $${peakHoldDollars.toFixed(6)} exceeds money-safety cap $${MAX_PEAK_HOLD_DOLLARS} (N=${CONCURRENT_CALLS} x hold=$${baselineHold})`
    );
  }

  const limitValue = baselineHold * RULE_MULTIPLIER;
  console.log(`[${ROUND_NAME}] === Step 3: create rule, limit=$${limitValue.toFixed(6)} (1.5x baseline hold $${baselineHold}) ===`);
  const ruleName = `race-lat-rule-${ROUND_NAME}`;
  const rule = await createRule(ruleName, agent.id, limitValue);
  console.log(`[${ROUND_NAME}] rule created:`, rule.id, rule.formattedId, 'version', rule.version);
  report.rule = rule;
  report.rule_limit_value = limitValue;

  console.log(`[${ROUND_NAME}] === Step 4: fire ${CONCURRENT_CALLS} CONCURRENT calls (max_tokens=${MAX_TOKENS}) through ${AGENT_NAME} ===`);
  const midBalance = await getAccounts();
  console.log(`[${ROUND_NAME}] balance before concurrent batch:`, midBalance);
  report.accounts_mid = midBalance;

  const raceStartedAt = Date.now();
  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, (_, i) => fireOne(sapiomFetch, `race${i}`))
  );
  const avgElapsedMs = outcomes.reduce((s, o) => s + o.elapsedMs, 0) / outcomes.length;
  console.log(`[${ROUND_NAME}] race calls avg elapsedMs=${avgElapsedMs.toFixed(0)}`);
  report.race_avg_elapsed_ms = avgElapsedMs;
  console.log(`[${ROUND_NAME}] waiting ${SETTLE_WAIT_MS}ms before inspecting ledger...`);
  await sleep(SETTLE_WAIT_MS);

  console.log(`[${ROUND_NAME}] === Step 5: read each transaction's OWN ruleExecution record (latest completedAt = authoritative) ===`);
  const raceTxns = await fetchAgentTransactions(AGENT_NAME, CONCURRENT_CALLS);
  const raceTxnsFiltered = raceTxns.filter((t) => createdAtMs(t) >= raceStartedAt - 2000);
  console.log(`[${ROUND_NAME}] found ${raceTxnsFiltered.length} race-batch transactions (expected ${CONCURRENT_CALLS})`);

  const perTxn = raceTxnsFiltered.map((t) => {
    const allDecisions = ruleDecisionsFor(t, rule.id);
    const finalDecision = finalDecisionFor(allDecisions);
    const costRows = costRowsOf(t);
    const { initialRow, finalRow } = splitCostRows(costRows);
    const hold = initialRow ? fiatAmountOf(initialRow) : finalRow ? fiatAmountOf(finalRow) : null;
    const settle = finalRow ? fiatAmountOf(finalRow) : null;
    return {
      id: pick(t, ['id']),
      createdAt: pick(t, ['createdAt']),
      overallStatus: pick(t, ['status']),
      hold,
      settle,
      all_rule_decisions: allDecisions,
      final_decision: finalDecision?.decision ?? null,
      final_decision_completed_at: finalDecision?.completedAt ?? null,
    };
  });

  const allowedCount = perTxn.filter((t) => t.final_decision === 'ALLOWED').length;
  const deniedCount = perTxn.filter((t) => t.final_decision === 'DENIED').length;
  const unknownCount = perTxn.length - allowedCount - deniedCount;

  // Cross-confirm with client-side HTTP status (200=allowed, 402=denied).
  const httpAllowed = outcomes.filter((o) => o.httpStatus === 200).length;
  const httpDenied = outcomes.filter((o) => o.httpStatus === 402).length;
  console.log(`[${ROUND_NAME}] our-rule FINAL decisions: allowed=${allowedCount} denied=${deniedCount} unknown=${unknownCount} of ${perTxn.length}`);
  console.log(`[${ROUND_NAME}] client HTTP cross-check: 200s=${httpAllowed} 402s=${httpDenied} other=${outcomes.length - httpAllowed - httpDenied}`);
  perTxn.forEach((t) => {
    console.log(`  ${t.id} createdAt=${t.createdAt} hold=${t.hold} final=${t.final_decision} completedAt=${t.final_decision_completed_at}`);
  });

  report.race_outcomes = outcomes;
  report.race_transactions = perTxn;
  report.allowed_count = allowedCount;
  report.denied_count = deniedCount;
  report.unknown_count = unknownCount;
  report.http_allowed_count = httpAllowed;
  report.http_denied_count = httpDenied;
  report.dollars_authorized_through = allowedCount * baselineHold;
  report.limit_dollars = limitValue;
  report.leak_factor = allowedCount / 1; // rule sized to permit exactly 1

  console.log(`[${ROUND_NAME}] === Step 6: cleanup - pause rule ===`);
  const paused = await pauseRule(rule.id, rule.version);
  console.log(`[${ROUND_NAME}] rule paused:`, paused.status, 'version', paused.version);
  report.rule_paused_confirmation = paused;

  const after = await getAccounts();
  console.log(`[${ROUND_NAME}] balance after:`, after);
  report.accounts_after = after;

  report.finished_at = new Date().toISOString();
  await writeFile(new URL(`./toctou_latency_${ROUND_NAME}_result.json`, import.meta.url), JSON.stringify(report, null, 2));
  console.log(`[${ROUND_NAME}] wrote toctou_latency_${ROUND_NAME}_result.json`);
  console.log(`\n[${ROUND_NAME}] === SUMMARY ===`);
  console.log(`max_tokens=${MAX_TOKENS}  limit=$${limitValue.toFixed(6)}  baseline_hold=$${baselineHold}  baseline_elapsedMs=${baselineOutcome.elapsedMs}  N=${CONCURRENT_CALLS}`);
  console.log(`allowed=${allowedCount}  denied=${deniedCount}  dollars_through=$${(allowedCount * baselineHold).toFixed(6)}  leak_factor=${allowedCount}x`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
