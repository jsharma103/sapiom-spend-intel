import { createFetch } from '@sapiom/fetch';

// ---------------------------------------------------------------------------
// generate_spend.js — Stage 1 (see PLAN.md)
//
// Fires real spend against the Sapiom payment API through three simulated
// agents so later stages have realistic ledger data to reconcile/audit:
//   - researcher : 12 search calls,  5-15s random gap between calls
//   - writer     : 10 LLM calls,     8-20s random gap between calls
//   - runaway    : 25 search calls,  fixed 0.3s gap between calls (a burst
//                  at the very end — anomaly data for later phases)
//
// Safety: a running cost counter aborts the whole run before any call that
// would push projected spend over the $0.90 hard cap. Every call is wrapped
// in its own try/catch so one failure doesn't stop the run; failures are
// counted and logged, not thrown.
//
// Usage:
//   node generate_spend.js --dry   # print the plan, fire nothing
//   node generate_spend.js         # real run, real spend
// ---------------------------------------------------------------------------

const DRY = process.argv.includes('--dry');

const SEARCH_URL = 'https://linkup.services.sapiom.ai/v1/search';
const LLM_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const LLM_MODEL = 'openai/gpt-4o-mini';
const LLM_MAX_TOKENS = 800;

// Known/estimated per-call prices (see PLAN.md "Confirmed API facts").
const SEARCH_COST = 0.006;
const LLM_COST_EST = 0.002;
const BUDGET_CAP = 0.9;

if (!DRY && !process.env.SAPIOM_API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=...');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randMs(minSec, maxSec) {
  return Math.round((minSec + Math.random() * (maxSec - minSec)) * 1000);
}

function ts() {
  return new Date().toISOString();
}

function truncate(s, n = 60) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

class BudgetExceededError extends Error {}

// --- Running cost counter --------------------------------------------------

const state = {
  runningCost: 0,
  aborted: false,
  abortReason: null,
};

const stats = {
  researcher: { attempted: 0, succeeded: 0, failed: 0, cost: 0 },
  writer: { attempted: 0, succeeded: 0, failed: 0, cost: 0 },
  runaway: { attempted: 0, succeeded: 0, failed: 0, cost: 0 },
};

// Charges the estimated cost of a call BEFORE it fires (conservative: never
// undercounts spend). Throws BudgetExceededError if that would push
// projected total spend over the cap, in which case the call is never made.
function chargeOrAbort(agentLabel, cost) {
  const projected = state.runningCost + cost;
  if (projected > BUDGET_CAP) {
    throw new BudgetExceededError(
      `projected spend $${projected.toFixed(4)} would exceed cap $${BUDGET_CAP.toFixed(2)} ` +
        `(running=$${state.runningCost.toFixed(4)}, next call=$${cost.toFixed(4)}, agent=${agentLabel})`
    );
  }
  state.runningCost = projected;
  stats[agentLabel].cost += cost;
}

// --- Call content pools ------------------------------------------------

const SEARCH_QUERIES = [
  'Latest developments in AI agent spend management',
  'How do multi-agent systems attribute cost per action',
  'Best practices for LLM API cost governance',
  'Trends in autonomous agent budgeting 2026',
  'How do companies audit AI agent transaction ledgers',
  'Cost estimate vs actual reconciliation in cloud billing',
  'Anomaly detection techniques for spend monitoring',
  'What is a supersession chain in financial ledgers',
  'AI agent orchestration platforms comparison',
  'Real-time cost attribution for microservices',
  'Double-entry bookkeeping principles for software systems',
  'How to detect runaway API usage in production',
  'Forecasting cloud spend using historical transaction data',
  'Data quality checks for financial reconciliation pipelines',
  'AI agent governance and compliance frameworks',
];

const LLM_PROMPTS = [
  { words: 120, prompt: 'Write a 120-word summary of how AI agent spend tracking differs from traditional SaaS billing.' },
  { words: 180, prompt: 'Write a 180-word explainer on why real-time cost attribution matters for multi-agent systems.' },
  { words: 250, prompt: 'Write a 250-word overview of common failure modes when reconciling estimated vs actual API costs.' },
  { words: 300, prompt: 'Write a 300-word article on how supersession chains in a cost ledger can cause double-counting bugs.' },
  { words: 350, prompt: 'Write a 350-word piece on designing a running budget guard for autonomous agents.' },
  { words: 400, prompt: 'Write a 400-word analysis of anomaly detection strategies for bursty API usage patterns.' },
  { words: 450, prompt: 'Write a 450-word explainer comparing claims-processing audits to AI agent spend audits.' },
  { words: 500, prompt: 'Write a 500-word overview of idempotent data ingestion patterns for financial pipelines.' },
  { words: 550, prompt: 'Write a 550-word article on building trust in autonomous agent spend through auditability.' },
  { words: 600, prompt: 'Write a 600-word deep dive on reconciling ledger balances against a running transaction log.' },
];

function pickSearchQuery(index) {
  return SEARCH_QUERIES[index % SEARCH_QUERIES.length];
}

// --- Call helpers ------------------------------------------------------

async function callSearch(client, agentLabel, index) {
  const query = pickSearchQuery(index);
  stats[agentLabel].attempted += 1;

  if (DRY) {
    stats[agentLabel].cost += SEARCH_COST;
    state.runningCost += SEARCH_COST;
    console.log(
      `[DRY] ${ts()} agent=${agentLabel} service=search call=${index + 1} q="${truncate(query)}" est_cost=$${SEARCH_COST.toFixed(4)}`
    );
    return;
  }

  try {
    chargeOrAbort(agentLabel, SEARCH_COST);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    throw err;
  }

  try {
    const res = await client(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, depth: 'standard', outputType: 'sourcedAnswer' }),
    });
    stats[agentLabel].succeeded += 1;
    console.log(
      `${ts()} agent=${agentLabel} service=search status=${res.status} running=$${state.runningCost.toFixed(4)}`
    );
    try {
      await res.json();
    } catch {
      /* body not needed beyond status; ignore parse errors */
    }
  } catch (err) {
    stats[agentLabel].failed += 1;
    console.log(`${ts()} agent=${agentLabel} service=search status=ERROR error="${err?.message || err}"`);
  }
}

async function callLlm(client, agentLabel, index) {
  const { words, prompt } = LLM_PROMPTS[index % LLM_PROMPTS.length];
  stats[agentLabel].attempted += 1;

  if (DRY) {
    stats[agentLabel].cost += LLM_COST_EST;
    state.runningCost += LLM_COST_EST;
    console.log(
      `[DRY] ${ts()} agent=${agentLabel} service=llm call=${index + 1} words=${words} prompt="${truncate(prompt)}" est_cost=$${LLM_COST_EST.toFixed(4)}`
    );
    return;
  }

  try {
    chargeOrAbort(agentLabel, LLM_COST_EST);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    throw err;
  }

  try {
    const res = await client(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: LLM_MAX_TOKENS,
      }),
    });
    stats[agentLabel].succeeded += 1;
    console.log(
      `${ts()} agent=${agentLabel} service=llm status=${res.status} running=$${state.runningCost.toFixed(4)}`
    );
    try {
      await res.json();
    } catch {
      /* body not needed beyond status; ignore parse errors */
    }
  } catch (err) {
    stats[agentLabel].failed += 1;
    console.log(`${ts()} agent=${agentLabel} service=llm status=ERROR error="${err?.message || err}"`);
  }
}

// --- Agent runs ----------------------------------------------------------

async function runResearcher() {
  const label = 'researcher';
  console.log(`\n=== ${label}: 12 search calls, 5-15s gap ===`);
  const client = DRY ? null : createFetch({ apiKey: process.env.SAPIOM_API_KEY, agentName: 'spend-researcher' });
  const CALLS = 12;
  for (let i = 0; i < CALLS; i += 1) {
    await callSearch(client, label, i);
    if (i < CALLS - 1) {
      const gap = randMs(5, 15);
      if (DRY) {
        console.log(`[DRY] ${label} would sleep ${gap}ms`);
      } else {
        await sleep(gap);
      }
    }
  }
}

async function runWriter() {
  const label = 'writer';
  console.log(`\n=== ${label}: 10 LLM calls, 8-20s gap ===`);
  const client = DRY ? null : createFetch({ apiKey: process.env.SAPIOM_API_KEY, agentName: 'spend-writer' });
  const CALLS = 10;
  for (let i = 0; i < CALLS; i += 1) {
    await callLlm(client, label, i);
    if (i < CALLS - 1) {
      const gap = randMs(8, 20);
      if (DRY) {
        console.log(`[DRY] ${label} would sleep ${gap}ms`);
      } else {
        await sleep(gap);
      }
    }
  }
}

async function runRunaway() {
  const label = 'runaway';
  console.log(`\n=== ${label}: 25 search calls, 0.3s gap (burst) ===`);
  const client = DRY ? null : createFetch({ apiKey: process.env.SAPIOM_API_KEY, agentName: 'spend-runaway' });
  const CALLS = 25;
  const GAP_MS = 300;
  for (let i = 0; i < CALLS; i += 1) {
    await callSearch(client, label, i);
    if (i < CALLS - 1) {
      if (DRY) {
        console.log(`[DRY] ${label} would sleep ${GAP_MS}ms`);
      } else {
        await sleep(GAP_MS);
      }
    }
  }
}

// --- Summary ---------------------------------------------------------------

function printSummary(startedAt) {
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== SUMMARY${DRY ? ' (dry run — nothing was fired)' : ''} ===`);
  for (const [label, s] of Object.entries(stats)) {
    console.log(
      `  ${label}: attempted=${s.attempted} succeeded=${s.succeeded} failed=${s.failed} est_cost=$${s.cost.toFixed(4)}`
    );
  }
  const totalAttempted = Object.values(stats).reduce((a, s) => a + s.attempted, 0);
  const totalFailed = Object.values(stats).reduce((a, s) => a + s.failed, 0);
  console.log(`  TOTAL: attempted=${totalAttempted} failed=${totalFailed} est_spend=$${state.runningCost.toFixed(4)}`);
  console.log(`  elapsed=${elapsedSec}s`);
  if (state.aborted) {
    console.log(`  ABORTED: ${state.abortReason}`);
  }
}

async function main() {
  const startedAt = Date.now();
  try {
    await runResearcher();
    await runWriter();
    await runRunaway();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      state.aborted = true;
      state.abortReason = err.message;
      console.error(`\nBUDGET CAP HIT — aborting remaining calls: ${err.message}`);
    } else {
      throw err;
    }
  } finally {
    printSummary(startedAt);
  }
  if (state.aborted) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
