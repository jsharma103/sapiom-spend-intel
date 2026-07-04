import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Service sweep — fires ONE minimal/cheapest call at every Sapiom-gated
// service to answer two questions at once:
//
//   1. Does this ONE API key work against every service, or is it scoped /
//      rejected for some? (401/403 = key rejected; other 4xx = key fine but
//      request malformed; 2xx = works.)
//   2. What does each service's response look like? (top-level keys/types),
//      doubling as the Data-1.0 data-shape inventory.
//
// This spends real money, so it is gated hard:
//   - refuses to run without SAPIOM_API_KEY
//   - `--dry` (or no flag at all) only PRINTS the plan; nothing is fired
//   - `--run` is required to actually fire calls
//   - balance pre-check aborts if availableBalance < $0.50
//   - a static + a running per-call cost guard hard-aborts if the projected
//     total exceeds $0.20
//   - messaging (QStash) and verify (Prelude/SMS) are SIDE-EFFECTING
//     (real SMS / real webhook dispatch) and are SKIPPED by default; pass
//     `--probe-side-effects` (with `--run`) to fire a deliberately-invalid,
//     auth-only probe against them instead (no real SMS / no real delivery
//     expected — just enough to see whether the key authenticates).
//
// Endpoints, bodies, and gateway URLs below are taken verbatim from
// .agents/skills/use-sapiom/references/*.md (search.md, ai-models.md,
// images.md, audio.md, compute.md, data.md, scraping.md, messaging.md,
// verify.md) — nothing is guessed. Where a doc was ambiguous or silent on
// exact pricing, that's called out in AMBIGUITIES below and in the code
// comments at the point of ambiguity.
//
// Style/helpers (gov(), pick(), firstArray(), formatUsd()) mirror the
// existing dryrun/*.js experiments in this directory.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=...');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const MIN_BALANCE_USD = 0.5; // abort if availableBalance falls below this
const HARD_BUDGET_USD = 0.2; // abort if projected/running total exceeds this
const CALL_TIMEOUT_MS = 45000; // safety valve per outbound call
const BETWEEN_CALL_SLEEP_MS = 2000; // pacing between fired calls
const SETTLE_MS = 10000; // wait for cost capture to post before reading /v1/transactions

const args = process.argv.slice(2);
const FLAG_DRY = args.includes('--dry');
const FLAG_RUN = args.includes('--run');
const FLAG_PROBE_SIDE_EFFECTS = args.includes('--probe-side-effects');
// Explicit --dry always wins over --run if both are passed (safer default).
const MODE = FLAG_DRY || !FLAG_RUN ? 'dry' : 'run';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Governance reads (plain fetch, Bearer + curl UA — not a metered call) -
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

function getAccounts() {
  return gov('/v1/accounts');
}

function getTransactions() {
  return gov('/v1/transactions');
}

// --- Defensive payload helpers (schema is only partially documented) -------

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

function formatUsd(n) {
  return n === null || n === undefined ? 'n/a' : `$${n.toFixed(6)}`;
}

function extractBalance(accountsPayload) {
  const balanceKeys = ['availableBalance', 'available_balance', 'balance', 'balanceFiat', 'balance_fiat'];
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

// Live/current cost row = isActive true, or supersededAt null when there's
// more than one row (see cap_experiment.js for the estimate->actual chain).
function liveCostRow(rows) {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return (
    rows.find((r) => pick(r, ['isActive', 'is_active']) === true) ??
    rows.find((r) => pick(r, ['supersededAt', 'superseded_at']) == null) ??
    rows[0]
  );
}

// Shallow-ish shape capture: top-level keys with types; one level of nesting
// for objects/arrays so the "data-shape inventory" is actually useful.
function shapeOf(value, depth = 0, maxDepth = 2) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array(0)';
    const elemShape = depth < maxDepth ? shapeOf(value[0], depth + 1, maxDepth) : typeof value[0];
    return `array(${value.length}) of ${elemShape}`;
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return 'object';
    const entries = Object.keys(value).map((k) => `${k}: ${shapeOf(value[k], depth + 1, maxDepth)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return typeof value;
}

function truncateSample(value, maxLen = 800) {
  const s = JSON.stringify(value);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…(truncated)` : s;
}

function verdictFromStatus(status) {
  if (status === null || status === undefined) return 'ERROR';
  if (status >= 200 && status < 300) return 'WORKS';
  if (status === 401 || status === 403) return 'KEY REJECTED';
  if (status >= 400 && status < 500) return 'KEY OK (bad request)';
  if (status >= 500) return 'SERVER ERROR (inconclusive)';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Plan — one minimal/cheapest call per service. Gateway URLs + body shapes
// are copied from the SDK Access sections of each reference doc.
// ---------------------------------------------------------------------------

const AMBIGUITIES = [
  {
    service: 'data (Neon)',
    note:
      'The task asked for the "cheapest/read-ish DB op". Actually provisioning even the shortest-lived ' +
      '(15m) Postgres DB is a real, non-trivial charge and not read-ish. data.md documents ' +
      'sapiom_database_price / POST {NEON}/v1/databases/price as explicitly FREE ("no payment required"). ' +
      'We use that as the data-service call: it still round-trips through the Neon gateway with the API ' +
      'key (proving auth) at guaranteed $0 cost, rather than guessing at Neon provisioning cost, which is ' +
      'not published anywhere in data.md.',
  },
  {
    service: 'scraping',
    note:
      'The task labelled this bucket "(Anchor Browser)", but scraping.md documents Anchor Browser only for ' +
      'sapiom_screenshot (webpage screenshot). The action that actually matches "scrape one simple URL" is ' +
      'Firecrawl\'s POST {FIRECRAWL}/v2/scrape, which is what SKILL.md/scraping.md map to "scrape/fetch". We ' +
      'used Firecrawl scrape against https://example.com; a screenshot call would exercise Anchor Browser ' +
      'instead but is a different action (render+screenshot, not scrape) and not documented as cheaper.',
  },
  {
    service: 'pricing (all services)',
    note:
      'None of search.md, ai-models.md, images.md, audio.md, compute.md, or scraping.md publish a flat ' +
      'per-call USD price. The estCostUsd values below are conservative estimates: the OpenRouter figure is ' +
      'anchored to real captured costs in cap_experiment_result.json (~$0.0001-0.0006 for short gpt-4o-mini ' +
      'completions); the others are generous upper-bound guesses at typical vendor rates (Linkup, Fal.ai ' +
      'flux/schnell, ElevenLabs TTS, Blaxel sandbox run, Firecrawl scrape) rounded up for safety margin in the ' +
      'budget guard. Actual costs are captured post-hoc from GET /v1/transactions and reported per-service ' +
      'alongside the estimate.',
  },
  {
    service: 'messaging (QStash) / verify (Prelude)',
    note:
      'Both are side-effecting: verify sends a real SMS to a real phone number; messaging/QStash schedules a ' +
      'real HTTP delivery (webhook). Neither is fired by default. With --probe-side-effects we fire a ' +
      'deliberately malformed request (bad phone format / bad destination) intended to be rejected by ' +
      'provider-side validation before any real dispatch happens — but this is inherently a best-effort ' +
      'guess about where that provider validates, since neither reference doc documents a "dry validate" mode.',
  },
];

const PLAN = [
  {
    service: 'search',
    provider: 'Linkup',
    url: 'https://linkup.services.sapiom.ai/v1/search',
    method: 'POST',
    body: { q: 'capital of France', depth: 'standard', outputType: 'sourcedAnswer' },
    estCostUsd: 0.01,
    agentName: 'sweep-search',
  },
  {
    service: 'llm',
    provider: 'OpenRouter',
    url: 'https://openrouter.services.sapiom.ai/v1/chat/completions',
    method: 'POST',
    body: {
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      max_tokens: 30,
    },
    estCostUsd: 0.001,
    agentName: 'sweep-llm',
  },
  {
    service: 'images',
    provider: 'Fal.ai',
    url: 'https://fal.services.sapiom.ai/v1/run/fal-ai/flux/schnell',
    method: 'POST',
    // flux/schnell is the fastest/cheapest model per images.md; "square" (not
    // square_hd) is the smallest of the documented imageSize options.
    body: { prompt: 'a red dot', image_size: 'square', num_images: 1 },
    estCostUsd: 0.01,
    agentName: 'sweep-images',
  },
  {
    service: 'audio',
    provider: 'ElevenLabs',
    url: 'https://elevenlabs.services.sapiom.ai/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM',
    method: 'POST',
    body: { text: 'Hi.', model_id: 'eleven_multilingual_v2' },
    estCostUsd: 0.02,
    agentName: 'sweep-audio',
  },
  {
    service: 'compute',
    provider: 'Blaxel',
    url: 'https://compute.services.sapiom.ai/v1/runs',
    method: 'POST',
    body: { code: 'print(1)', language: 'python' },
    estCostUsd: 0.02,
    agentName: 'sweep-compute',
  },
  {
    service: 'data',
    provider: 'Neon',
    url: 'https://neon.services.sapiom.ai/v1/databases/price',
    method: 'POST',
    body: { duration: '15m' },
    estCostUsd: 0, // documented free endpoint (data.md: "Free — no payment required")
    agentName: 'sweep-data',
  },
  {
    service: 'scraping',
    provider: 'Firecrawl', // see AMBIGUITIES: task said "(Anchor Browser)", doc maps scrape action to Firecrawl
    url: 'https://firecrawl.services.sapiom.ai/v2/scrape',
    method: 'POST',
    body: { url: 'https://example.com', formats: ['markdown'] },
    estCostUsd: 0.01,
    agentName: 'sweep-scraping',
  },
  {
    service: 'messaging',
    provider: 'QStash',
    sideEffect: true,
    sideEffectLabel: 'real webhook/job dispatch',
    url: 'https://qstash.services.sapiom.ai/v2/publish/not-a-valid-destination',
    method: 'POST',
    // No scheme/host — intended to fail QStash's destination validation
    // before any delivery is scheduled. Auth-only probe, not a real publish.
    body: {},
    estCostUsd: 0,
    agentName: 'sweep-messaging',
  },
  {
    service: 'verify',
    provider: 'Prelude',
    sideEffect: true,
    sideEffectLabel: 'real SMS send',
    url: 'https://prelude.services.sapiom.ai/verifications',
    method: 'POST',
    // Deliberately malformed target (not E.164) — intended to be rejected by
    // Prelude's validation before an SMS is actually dispatched.
    body: { target: { type: 'phone_number', value: 'not-a-real-phone-number' } },
    estCostUsd: 0,
    agentName: 'sweep-verify',
  },
];

function willFire(entry) {
  return !entry.sideEffect || FLAG_PROBE_SIDE_EFFECTS;
}

// Build a not-fired result row (side-effect skip or budget-guard skip).
function skipResult(entry, keyWorks, note) {
  return {
    service: entry.service,
    provider: entry.provider,
    endpoint: entry.url,
    method: entry.method,
    requestBody: entry.body,
    agentName: entry.agentName,
    plannedEstCostUsd: entry.estCostUsd,
    httpStatus: null,
    keyWorks,
    charged: false,
    actualCostUsd: 0,
    matchedTransactionId: null,
    responseShape: null,
    responseSample: null,
    error: null,
    note,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printPlan() {
  console.log('\n=== PLANNED CALLS ===');
  for (const entry of PLAN) {
    const skip = entry.sideEffect && !FLAG_PROBE_SIDE_EFFECTS;
    console.log(`\n[${entry.service}] (${entry.provider})`);
    if (skip) {
      console.log(`  SKIPPED — side effect (${entry.sideEffectLabel}). Pass --probe-side-effects to fire an auth-only probe instead.`);
    }
    console.log(`  ${entry.method} ${entry.url}`);
    console.log(`  body: ${JSON.stringify(entry.body)}`);
    console.log(`  est. cost: ${formatUsd(entry.estCostUsd)}${entry.sideEffect ? ' (if probed)' : ''}`);
  }
  const firingNow = PLAN.filter(willFire);
  const plannedTotal = firingNow.reduce((sum, e) => sum + e.estCostUsd, 0);
  console.log(`\nTotal estimated cost of calls that would fire: ${formatUsd(plannedTotal)} (hard budget guard: ${formatUsd(HARD_BUDGET_USD)})`);

  console.log('\n=== AMBIGUITIES / NOTES ===');
  for (const a of AMBIGUITIES) {
    console.log(`- [${a.service}] ${a.note}`);
  }
}

function printSummaryTable(results) {
  console.log('\n=== SUMMARY ===');
  const cols = ['service', 'endpoint', 'status', 'charged', 'key-works'];
  console.log(cols.join(' | '));
  console.log('-'.repeat(100));
  for (const r of results) {
    const endpointShort = r.endpoint.replace('https://', '').split('?')[0];
    console.log(
      `${r.service.padEnd(10)} | ${endpointShort.slice(0, 45).padEnd(45)} | ${String(r.httpStatus ?? '—').padEnd(6)} | ${String(
        r.charged
      ).padEnd(7)} | ${r.keyWorks}`
    );
  }
}

// ---------------------------------------------------------------------------
// Firing one call
// ---------------------------------------------------------------------------

async function fireCall(entry) {
  console.log(`\n[${entry.service}] firing ${entry.method} ${entry.url} ...`);
  const result = {
    service: entry.service,
    provider: entry.provider,
    endpoint: entry.url,
    method: entry.method,
    requestBody: entry.body,
    agentName: entry.agentName,
    plannedEstCostUsd: entry.estCostUsd,
    httpStatus: null,
    keyWorks: null,
    charged: 'unknown',
    actualCostUsd: null,
    matchedTransactionId: null,
    responseShape: null,
    responseSample: null,
    error: null,
  };

  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: entry.agentName });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await sapiomFetch(entry.url, {
      method: entry.method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry.body),
      signal: controller.signal,
    });
    result.httpStatus = response.status;
    result.keyWorks = verdictFromStatus(response.status);
    try {
      const json = await response.json();
      result.responseShape = shapeOf(json);
      result.responseSample = truncateSample(json);
    } catch (err) {
      result.error = `Failed to parse JSON response: ${err?.message || err}`;
    }
    console.log(`  -> HTTP ${response.status} (${result.keyWorks})`);
  } catch (err) {
    if (err?.name === 'AuthorizationDeniedError') {
      result.keyWorks = 'AUTH DENIED (Sapiom spending rule or balance, pre-flight)';
    } else if (err?.name === 'AuthorizationTimeoutError') {
      result.keyWorks = 'AUTH TIMEOUT (pre-flight)';
    } else {
      result.keyWorks = 'ERROR';
    }
    result.error = err?.message || String(err);
    console.log(`  -> ${result.keyWorks}: ${result.error}`);
  } finally {
    clearTimeout(timeout);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Mode: ${MODE}${FLAG_PROBE_SIDE_EFFECTS ? ' (+ probe side-effect services)' : ''}`);

  console.log('\nChecking account balance (GET /v1/accounts)...');
  const accountsBefore = await getAccounts();
  const balanceBefore = extractBalance(accountsBefore);
  console.log(`  availableBalance: ${formatUsd(balanceBefore)}`);

  if (MODE === 'dry') {
    printPlan();
    if (balanceBefore !== null && balanceBefore < MIN_BALANCE_USD) {
      console.log(`\n(Note: current balance ${formatUsd(balanceBefore)} is below the ${formatUsd(MIN_BALANCE_USD)} minimum required for a real --run.)`);
    }
    console.log('\nDry mode — no calls fired. Pass --run to actually fire real calls (this spends real money).');
    return;
  }

  // --- MONEY-SAFETY: balance pre-check --------------------------------------
  if (balanceBefore === null) {
    console.error('Could not determine availableBalance from /v1/accounts response. Aborting for safety.');
    process.exit(1);
  }
  if (balanceBefore < MIN_BALANCE_USD) {
    console.error(`ABORT: availableBalance ${formatUsd(balanceBefore)} is below the required minimum ${formatUsd(MIN_BALANCE_USD)}.`);
    process.exit(1);
  }

  // --- MONEY-SAFETY: static budget guard ------------------------------------
  const toFire = PLAN.filter(willFire);
  const plannedTotal = toFire.reduce((sum, e) => sum + e.estCostUsd, 0);
  console.log(`\nCost guard: planned total ${formatUsd(plannedTotal)} vs hard limit ${formatUsd(HARD_BUDGET_USD)}`);
  if (plannedTotal > HARD_BUDGET_USD) {
    console.error(`ABORT: projected total ${formatUsd(plannedTotal)} exceeds hard budget guard ${formatUsd(HARD_BUDGET_USD)}.`);
    process.exit(1);
  }

  const sweepStartedAt = Date.now();
  const results = [];
  let runningCostUsd = 0;
  let budgetAborted = false;

  for (const entry of PLAN) {
    if (!willFire(entry)) {
      results.push(
        skipResult(
          entry,
          'SKIPPED',
          `side effect (${entry.sideEffectLabel}) — not fired; pass --probe-side-effects to fire an auth-only probe`
        )
      );
      console.log(`\n[${entry.service}] SKIPPED — side effect (${entry.sideEffectLabel})`);
      continue;
    }

    if (budgetAborted) {
      results.push(
        skipResult(entry, 'SKIPPED — budget guard', 'not fired: running cost counter would have exceeded the hard budget guard')
      );
      continue;
    }

    // --- MONEY-SAFETY: running per-call cost guard --------------------------
    if (runningCostUsd + entry.estCostUsd > HARD_BUDGET_USD) {
      console.error(
        `ABORT (running guard): firing [${entry.service}] would push running cost ${formatUsd(runningCostUsd)} + ${formatUsd(
          entry.estCostUsd
        )} past hard limit ${formatUsd(HARD_BUDGET_USD)}. Skipping remaining calls.`
      );
      budgetAborted = true;
      results.push(skipResult(entry, 'SKIPPED — budget guard', 'not fired: would have exceeded the hard budget guard'));
      continue;
    }

    const result = await fireCall(entry);
    runningCostUsd += entry.estCostUsd;
    results.push(result);
    await sleep(BETWEEN_CALL_SLEEP_MS);
  }

  console.log(`\nAll calls fired (running estimated cost: ${formatUsd(runningCostUsd)}). Waiting ${SETTLE_MS}ms for cost settlement...`);
  await sleep(SETTLE_MS);

  console.log('\nFetching /v1/transactions to check charges...');
  let rawTransactions = null;
  try {
    rawTransactions = await getTransactions();
  } catch (err) {
    console.error('Failed to fetch /v1/transactions:', err?.message || err);
  }
  const allTxns = rawTransactions ? firstArray(rawTransactions) : [];

  for (const r of results) {
    if (r.keyWorks === 'SKIPPED' || r.keyWorks === 'SKIPPED — budget guard') continue;
    const matches = allTxns
      .filter((t) => agentNameOf(t) === r.agentName && createdAtMs(t) >= sweepStartedAt - 5000)
      .sort((a, b) => createdAtMs(b) - createdAtMs(a));
    const txn = matches[0];
    if (!txn) {
      r.charged = 'unknown (no matching transaction found)';
      continue;
    }
    r.matchedTransactionId = pick(txn, ['id', 'transactionId', 'transaction_id']);
    const rows = costRowsOf(txn);
    const live = liveCostRow(rows);
    const amount = live ? fiatAmountOf(live) : null;
    r.actualCostUsd = amount;
    r.charged = amount !== null && amount > 0;
  }

  const accountsAfter = await getAccounts();
  const balanceAfter = extractBalance(accountsAfter);

  printSummaryTable(results);

  const actualTotal = results.reduce((sum, r) => sum + (r.actualCostUsd || 0), 0);
  console.log(`\nTotal actual charged (from /v1/transactions): ${formatUsd(actualTotal)}`);
  console.log(`Balance before: ${formatUsd(balanceBefore)}  ->  after: ${formatUsd(balanceAfter)}`);

  console.log('\n=== AMBIGUITIES / NOTES ===');
  for (const a of AMBIGUITIES) {
    console.log(`- [${a.service}] ${a.note}`);
  }

  const output = {
    ranAt: new Date().toISOString(),
    mode: MODE,
    probeSideEffects: FLAG_PROBE_SIDE_EFFECTS,
    costGuard: {
      minBalanceRequiredUsd: MIN_BALANCE_USD,
      hardBudgetUsd: HARD_BUDGET_USD,
      plannedTotalUsd: plannedTotal,
      runningEstimatedTotalUsd: runningCostUsd,
      actualTotalUsd: actualTotal,
      budgetAborted,
    },
    balance: { beforeUsd: balanceBefore, afterUsd: balanceAfter },
    results,
    ambiguities: AMBIGUITIES,
    rawAccountsBefore: accountsBefore,
    rawAccountsAfter: accountsAfter,
    rawTransactions,
  };

  const outPath = new URL('./service_sweep_result.json', import.meta.url);
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath.pathname}`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
