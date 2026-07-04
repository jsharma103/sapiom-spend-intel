import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// TOCTOU SCALE experiment — does the concurrency race found in
// hold_vs_settlement_experiment.md (2 of 3 concurrent calls independently
// ALLOWED by a rule sized for exactly 1) get WORSE at higher concurrency?
//
// Usage: node toctou_scale_experiment.js <ROUND_NAME> <CONCURRENT_CALLS>
// Each invocation is a fully self-contained round: creates its own throwaway
// agent + rule (fresh 1-day rolling window, no cross-round contamination),
// measures a real baseline hold, sizes the rule to permit ~1 call, fires N
// concurrent calls, reads each transaction's OWN ruleExecutions record for
// OUR rule (not wallet delta — a stale rule could confound), counts
// allowed/denied, then pauses the rule (mandatory cleanup).
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}

const ROUND_NAME = process.argv[2];
const CONCURRENT_CALLS = parseInt(process.argv[3], 10);
if (!ROUND_NAME || !Number.isFinite(CONCURRENT_CALLS) || CONCURRENT_CALLS < 2) {
  console.error('Usage: node toctou_scale_experiment.js <ROUND_NAME> <CONCURRENT_CALLS>');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 500;
const PROMPT = 'Reply with exactly one word: "test".';
const AGENT_NAME = `race-scale-agent-${ROUND_NAME}`;
const LLM_TIMEOUT_MS = 35000;
const SETTLE_WAIT_MS = 12000;
const RULE_MULTIPLIER = 1.5; // limit = 1.5x a single call's measured hold (strictly between 1H and 2H)

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

// Extract, for a given transaction, the decision this specific rule made
// (its own ruleExecutions entry), independent of any other active rule.
function ruleDecisionFor(txn, ruleId) {
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
      label: `Race Scale Test Agent (${ROUND_NAME})`,
      name,
      description:
        'Throwaway agent created for the TOCTOU-scale concurrency experiment (dryrun/toctou_scale_experiment.md). Never used for real traffic. Safe to ignore.',
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
  const report = { round: ROUND_NAME, concurrent_calls: CONCURRENT_CALLS, started_at: new Date().toISOString() };

  console.log(`[${ROUND_NAME}] === Pre-check: account balance ===`);
  const before = await getAccounts();
  console.log(`[${ROUND_NAME}] before:`, before);
  report.accounts_before = before;
  if (before.availableBalance < 2.75) {
    throw new Error(`ABORT: availableBalance ${before.availableBalance} < 2.75 floor`);
  }

  console.log(`[${ROUND_NAME}] === Step 1: create throwaway agent ${AGENT_NAME} ===`);
  const agent = await createAgent(AGENT_NAME);
  console.log(`[${ROUND_NAME}] agent created:`, agent.id, agent.formattedId);
  report.agent = agent;

  console.log(`[${ROUND_NAME}] === Step 2: baseline call (no rule active) to measure real hold ===`);
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const baselineOutcome = await fireOne(sapiomFetch, 'baseline');
  await sleep(SETTLE_WAIT_MS);
  const baselineTxns = await fetchAgentTransactions(AGENT_NAME, 1);
  const baselineTxn = baselineTxns[0] ?? null;
  const baselineCosts = baselineTxn ? costRowsOf(baselineTxn) : [];
  const { initialRow: baseInitial, finalRow: baseFinal } = splitCostRows(baselineCosts);
  const baselineHold = baseInitial ? fiatAmountOf(baseInitial) : baseFinal ? fiatAmountOf(baseFinal) : null;
  const baselineSettle = baseFinal ? fiatAmountOf(baseFinal) : null;
  console.log(`[${ROUND_NAME}] baseline hold=${baselineHold} settle=${baselineSettle}`);
  report.baseline_outcome = baselineOutcome;
  report.baseline_hold = baselineHold;
  report.baseline_settle = baselineSettle;
  report.baseline_txn = baselineTxn;

  if (!baselineHold || baselineHold <= 0) {
    throw new Error(`ABORT: could not measure a positive baseline hold (got ${baselineHold})`);
  }

  const limitValue = baselineHold * RULE_MULTIPLIER;
  console.log(`[${ROUND_NAME}] === Step 3: create rule, limit=$${limitValue.toFixed(6)} (1.5x baseline hold $${baselineHold}) ===`);
  const ruleName = `race-scale-rule-${ROUND_NAME}`;
  const rule = await createRule(ruleName, agent.id, limitValue);
  console.log(`[${ROUND_NAME}] rule created:`, rule.id, rule.formattedId, 'version', rule.version);
  report.rule = rule;
  report.rule_limit_value = limitValue;

  console.log(`[${ROUND_NAME}] === Step 4: fire ${CONCURRENT_CALLS} CONCURRENT calls through ${AGENT_NAME} ===`);
  const midBalance = await getAccounts();
  console.log(`[${ROUND_NAME}] balance before concurrent batch:`, midBalance);
  report.accounts_mid = midBalance;

  const raceStartedAt = Date.now();
  const outcomes = await Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, (_, i) => fireOne(sapiomFetch, `race${i}`))
  );
  console.log(`[${ROUND_NAME}] waiting ${SETTLE_WAIT_MS}ms before inspecting ledger...`);
  await sleep(SETTLE_WAIT_MS);

  console.log(`[${ROUND_NAME}] === Step 5: read each transaction's OWN ruleExecution record ===`);
  const raceTxns = await fetchAgentTransactions(AGENT_NAME, CONCURRENT_CALLS);
  const raceTxnsFiltered = raceTxns.filter((t) => createdAtMs(t) >= raceStartedAt - 2000);
  console.log(`[${ROUND_NAME}] found ${raceTxnsFiltered.length} race-batch transactions (expected ${CONCURRENT_CALLS})`);

  const perTxn = raceTxnsFiltered.map((t) => {
    const decisions = ruleDecisionFor(t, rule.id);
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
      our_rule_decisions: decisions,
    };
  });

  const allowedCount = perTxn.filter((t) => t.our_rule_decisions.some((d) => d.decision === 'ALLOWED')).length;
  const deniedCount = perTxn.filter((t) => t.our_rule_decisions.some((d) => d.decision === 'DENIED')).length;
  const unknownCount = perTxn.length - allowedCount - deniedCount;

  console.log(`[${ROUND_NAME}] our-rule decisions: allowed=${allowedCount} denied=${deniedCount} unknown=${unknownCount} of ${perTxn.length}`);
  perTxn.forEach((t) => {
    console.log(`  ${t.id} createdAt=${t.createdAt} hold=${t.hold} decisions=${JSON.stringify(t.our_rule_decisions.map((d) => d.decision))}`);
  });

  report.race_outcomes = outcomes;
  report.race_transactions = perTxn;
  report.allowed_count = allowedCount;
  report.denied_count = deniedCount;
  report.unknown_count = unknownCount;
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
  await writeFile(new URL(`./toctou_scale_${ROUND_NAME}_result.json`, import.meta.url), JSON.stringify(report, null, 2));
  console.log(`[${ROUND_NAME}] wrote toctou_scale_${ROUND_NAME}_result.json`);
  console.log(`\n[${ROUND_NAME}] === SUMMARY ===`);
  console.log(`limit=$${limitValue.toFixed(6)}  baseline_hold=$${baselineHold}  N=${CONCURRENT_CALLS}`);
  console.log(`allowed=${allowedCount}  denied=${deniedCount}  dollars_through=$${(allowedCount * baselineHold).toFixed(6)}  leak_factor=${allowedCount}x`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
