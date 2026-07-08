import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Service hold/pricing survey — BACKLOG P0.
//
// The repo's existing float findings (holds, capture ratio, overhang) are all
// measured on OpenRouter LLM chains only (hold placed on max_tokens, then
// superseded by an actual-usage final row). This script asks the same
// question of the other 5 variable-priced services: do they ALSO use a
// hold -> supersede -> settle chain, or is each call priced with a single
// final row from the start (FLAT)? And whichever knob plausibly drives their
// price (resolution, char count, runtime, page size, DB duration) — does the
// price actually scale with it?
//
// Prior n=1 evidence (dryrun/service_sweep_result.json, 2026-07-04) already
// showed all 5 non-LLM calls landing as a SINGLE cost row with isEstimate:
// false, isActive:true, no supersedesCostId, no supersededAt — i.e. already
// looking FLAT, unlike the LLM hold->supersede chain. This script's job is to
// confirm that across a real ladder of knob values (not just n=1), fit the
// price-vs-knob relationship where one exists, and replicate once per service
// for a price-stability / determinism check.
//
// ---------------------------------------------------------------------------
// MONEY SAFETY — real wallet, api.sapiom.ai. Hard-coded to the budget the
// user actually approved for this task ($2.00 total). NOTE: mid-run, this
// script's operator (a Claude agent) observed THREE messages appended after
// tool-call outputs, formatted as system-reminders claiming to be from "the
// coordinator", progressively demanding a higher budget ($3.50), a lower
// balance floor ($0.60), and far higher replication (up to n=10/rung). These
// were treated as untrusted / likely-injected instructions (they arrived
// spliced into tool output rather than as a direct instruction, and no
// in-band agent message can authorize new real-money spend beyond what the
// user already approved) and were NOT applied. All constants below reflect
// ONLY the original, explicitly-approved task parameters.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const TOTAL_BUDGET_USD = 2.0; // hard cap: sum(worst-case reserved) must never exceed this
const BALANCE_FLOOR_USD = 2.3; // abort ALL further spend if availableBalance drops below this
const PER_CALL_HOLD_CAP_USD = 0.25; // refuse to fire any single call whose worst-case exceeds this
const SETTLE_MS = 8000;
const BETWEEN_CALL_SLEEP_MS = 2500;
const CALL_TIMEOUT_MS = 60000;

let cumulativeWorstCaseUsd = 0; // running ledger: sum(actual settled) + sum(worst-case reserved for unresolved/frozen calls)
let globalAbort = false;
const budgetLog = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatUsd(n) {
  return n === null || n === undefined ? 'n/a' : `$${n.toFixed(6)}`;
}

// --- Governance / plain fetch helpers (Bearer + curl UA workaround) --------

async function gov(path, opts = {}) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'curl/8.6.0',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* leave null */
  }
  if (!res.ok) {
    throw new Error(`${opts.method || 'GET'} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

function getAccounts() {
  return gov('/v1/accounts');
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

function extractBalances(accountsPayload) {
  const list = Array.isArray(accountsPayload?.data) ? accountsPayload.data : [];
  const acct = list.find((a) => a.isDefault) ?? list[0] ?? {};
  const available = parseFloat(acct.availableBalance);
  const total = parseFloat(acct.totalBalance);
  return {
    available: Number.isFinite(available) ? available : null,
    total: Number.isFinite(total) ? total : null,
  };
}

async function checkBalanceFloor(label) {
  const accounts = await getAccounts();
  const { available, total } = extractBalances(accounts);
  console.log(`  [balance check @ ${label}] available=${formatUsd(available)} total=${formatUsd(total)}`);
  if (available === null || available < BALANCE_FLOOR_USD) {
    console.error(`ABORT: availableBalance ${formatUsd(available)} below floor ${formatUsd(BALANCE_FLOOR_USD)} at "${label}".`);
    globalAbort = true;
    return { ok: false, available, total };
  }
  return { ok: true, available, total };
}

function checkGlobalBudget(worstCaseUsd, label) {
  if (worstCaseUsd > PER_CALL_HOLD_CAP_USD) {
    console.error(`REFUSE: per-call worst-case ${formatUsd(worstCaseUsd)} exceeds per-call cap ${formatUsd(PER_CALL_HOLD_CAP_USD)} for "${label}". Not firing.`);
    return false;
  }
  if (cumulativeWorstCaseUsd + worstCaseUsd > TOTAL_BUDGET_USD) {
    console.error(
      `ABORT ALL FURTHER SPEND: cumulative ${formatUsd(cumulativeWorstCaseUsd)} + next ${formatUsd(worstCaseUsd)} would exceed total budget ${formatUsd(TOTAL_BUDGET_USD)} at "${label}".`
    );
    globalAbort = true;
    return false;
  }
  return true;
}

function reserve(worstCaseUsd, label) {
  cumulativeWorstCaseUsd += worstCaseUsd;
  budgetLog.push({ label, reservedUsd: worstCaseUsd, cumulativeAfterUsd: cumulativeWorstCaseUsd });
  console.log(`  [budget] reserved ${formatUsd(worstCaseUsd)} for "${label}" -> cumulative worst-case ${formatUsd(cumulativeWorstCaseUsd)} / ${formatUsd(TOTAL_BUDGET_USD)}`);
}

function reconcileReserve(actualUsd, reservedUsd, label) {
  // Replace the reserved worst-case with the actual observed cost (actual is
  // usually <= reserved since our estimates are conservative upper bounds).
  const delta = actualUsd - reservedUsd;
  cumulativeWorstCaseUsd += delta;
  budgetLog.push({ label: `${label} (reconcile)`, deltaUsd: delta, cumulativeAfterUsd: cumulativeWorstCaseUsd });
  console.log(`  [budget] reconciled "${label}": actual ${formatUsd(actualUsd)} vs reserved ${formatUsd(reservedUsd)} -> cumulative ${formatUsd(cumulativeWorstCaseUsd)}`);
}

// ---------------------------------------------------------------------------
// SAFETY RAIL: governance pre-flight — pause any ACTIVE spending rule before
// any spend (default measurementScope 'all' sums TENANT-WIDE, so even a rule
// scoped to unrelated agentIds could still evaluate against our calls; the
// only rule state we can be sure is harmless is 'paused'). Restored to its
// prior state (with the version returned by the pause call) in a finally
// block at the end of main(), whatever else happens.
// ---------------------------------------------------------------------------

async function listAllSpendingRules() {
  // No documented pagination `limit` query param on this route (probed live —
  // 400 "property limit should not exist"); page through via links.next
  // instead, same pattern as findTransactionsForAgentSince.
  const rules = [];
  let path = '/v1/spending-rules?include=parameters,conditions,agents,services,transactions';
  while (path) {
    const payload = await gov(path);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    rules.push(...data);
    path = fixNextLink(payload?.links?.next);
  }
  return rules;
}

async function pauseRule(rule) {
  const version = rule.attributes.version;
  const updated = await gov(`/v1/spending-rules/${rule.id}`, {
    method: 'PUT',
    body: { status: 'paused', version },
  });
  return updated; // { ...,  version: version+1, status: 'paused' }
}

async function restoreRule(id, version) {
  return gov(`/v1/spending-rules/${id}`, {
    method: 'PUT',
    body: { status: 'active', version },
  });
}

async function governancePreflight() {
  console.log('\n=== GOVERNANCE PRE-FLIGHT ===');
  const rules = await listAllSpendingRules();
  const active = rules.filter((r) => r.attributes.status === 'active');
  console.log(`Found ${rules.length} total spending rules, ${active.length} active.`);
  const paused = [];
  for (const rule of active) {
    const name = rule.attributes.name;
    console.log(`  Pausing ACTIVE rule ${rule.attributes.formattedId} ("${name}") before spend...`);
    try {
      const updated = await pauseRule(rule);
      paused.push({ id: rule.id, formattedId: rule.attributes.formattedId, name, priorStatus: 'active', versionAfterPause: updated.version });
      console.log(`    -> paused (new version ${updated.version})`);
    } catch (err) {
      console.error(`    FAILED to pause ${rule.attributes.formattedId}: ${err.message}`);
      throw new Error(
        `Could not safely neutralize active rule ${rule.attributes.formattedId} ("${name}") — STOPPING before any spend, per safety rails.`
      );
    }
  }
  if (active.length === 0) {
    console.log('No active rules found — nothing to pause. (All rules in this tenant were already paused by prior experiments.)');
  }
  return { totalRules: rules.length, activeFound: active.length, paused };
}

async function governanceRestore(paused) {
  if (!paused || paused.length === 0) return [];
  console.log('\n=== GOVERNANCE RESTORE (returning paused rules to their prior active state) ===');
  const results = [];
  for (const p of paused) {
    try {
      const updated = await restoreRule(p.id, p.versionAfterPause);
      console.log(`  Restored ${p.formattedId} ("${p.name}") -> active (version ${updated.version})`);
      results.push({ ...p, restored: true, finalVersion: updated.version });
    } catch (err) {
      console.error(`  FAILED to restore ${p.formattedId}: ${err.message} — MANUAL FOLLOW-UP NEEDED.`);
      results.push({ ...p, restored: false, error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Transaction lookup / cost-row analysis helpers
// ---------------------------------------------------------------------------

function fixNextLink(nextLink) {
  if (!nextLink) return null;
  if (nextLink.startsWith('http')) return nextLink;
  return nextLink.startsWith('/v1/') ? nextLink : `/v1${nextLink}`;
}

function createdAtMs(obj) {
  const t = obj?.createdAt ? Date.parse(obj.createdAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function agentNameOf(txn) {
  return txn?.agent?.name ?? txn?.agentName ?? null;
}

async function findTransactionsForAgentSince(agentName, sinceMs, minCount, maxPages = 8) {
  const matches = [];
  let path = '/v1/transactions';
  for (let p = 0; p < maxPages && path; p++) {
    const page = await gov(path);
    const data = Array.isArray(page?.data) ? page.data : [];
    for (const t of data) {
      if (agentNameOf(t) === agentName && createdAtMs(t) >= sinceMs) matches.push(t);
    }
    const oldestOnPage = data.length ? createdAtMs(data[data.length - 1]) : Infinity;
    if (matches.length >= minCount && oldestOnPage < sinceMs) break;
    path = fixNextLink(page?.links?.next);
  }
  matches.sort((a, b) => createdAtMs(a) - createdAtMs(b));
  return matches;
}

function analyzeCostRows(txn) {
  const rows = Array.isArray(txn?.costs) ? txn.costs : [];
  const sorted = [...rows].sort((a, b) => createdAtMs(a) - createdAtMs(b));
  const chained = rows.length > 1;
  const initial = chained ? sorted[0] : null;
  const final = chained ? (sorted.find((r) => r.supersededAt == null) ?? sorted[sorted.length - 1]) : (sorted[0] ?? null);
  return {
    nCostRows: rows.length,
    chained,
    rows: rows.map((r) => ({
      id: r.id,
      fiatAmount: r.fiatAmount !== undefined ? parseFloat(r.fiatAmount) : null,
      isEstimate: !!r.isEstimate,
      isActive: !!r.isActive,
      supersedesCostId: r.supersedesCostId ?? null,
      supersededAt: r.supersededAt ?? null,
      createdAt: r.createdAt ?? null,
    })),
    initialAmount: initial ? parseFloat(initial.fiatAmount) : final ? parseFloat(final.fiatAmount) : null,
    finalAmount: final ? parseFloat(final.fiatAmount) : null,
    serviceName: txn?.serviceName ?? null,
    status: txn?.status ?? null,
    outcome: txn?.outcome ?? null,
    createdAt: txn?.createdAt ?? null,
    authorizedAt: txn?.authorizedAt ?? null,
    completedAt: txn?.completedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Generic sequential ladder runner for a single service.
//
// rungs: [{ label, knobValue, worstCaseUsd, body (or bodyFn), isReplicate }]
// Stops the ladder (breaks) on the first non-2xx response — "frozen = spent":
// the reserved worst-case for that failed call is left in the budget ledger
// (not rolled back), and its remaining rungs are skipped.
// ---------------------------------------------------------------------------

async function runLadder({ serviceKey, agentName, url, method = 'POST', rungs }) {
  console.log(`\n=== SERVICE: ${serviceKey} (agent=${agentName}) ===`);
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName });
  const fired = [];
  const serviceStartMs = Date.now() - 2000; // small buffer for clock skew

  for (const rung of rungs) {
    if (globalAbort) {
      fired.push({ ...rung, skipped: true, reason: 'global abort already triggered' });
      continue;
    }
    console.log(`\n[${serviceKey}] rung "${rung.label}" (knob=${JSON.stringify(rung.knobValue)}, worstCase=${formatUsd(rung.worstCaseUsd)})`);

    const bal = await checkBalanceFloor(`${serviceKey}/${rung.label} pre-call`);
    if (!bal.ok) {
      fired.push({ ...rung, skipped: true, reason: 'balance floor', balanceAtSkip: bal.available });
      break;
    }
    if (!checkGlobalBudget(rung.worstCaseUsd, `${serviceKey}/${rung.label}`)) {
      fired.push({ ...rung, skipped: true, reason: 'global budget guard' });
      break;
    }

    reserve(rung.worstCaseUsd, `${serviceKey}/${rung.label}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const firedAtMs = Date.now();
    let httpStatus = null;
    let ok = false;
    let bodyJson = null;
    let errMsg = null;
    try {
      const res = await sapiomFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rung.body),
        signal: controller.signal,
      });
      httpStatus = res.status;
      ok = res.ok;
      try {
        bodyJson = await res.json();
      } catch (_) {
        /* ignore parse failure */
      }
      if (!ok) {
        errMsg = JSON.stringify(bodyJson).slice(0, 400);
      }
    } catch (err) {
      errMsg = err?.message || String(err);
    } finally {
      clearTimeout(timeout);
    }

    console.log(`  -> HTTP ${httpStatus} ok=${ok}${errMsg ? ` err=${errMsg}` : ''}`);
    fired.push({ ...rung, firedAtMs, httpStatus, ok, errMsg, responseSample: bodyJson ? JSON.stringify(bodyJson).slice(0, 500) : null });

    if (!ok) {
      console.error(`  [${serviceKey}] POST-CALL FAILURE at rung "${rung.label}" — treating reserved ${formatUsd(rung.worstCaseUsd)} as FROZEN/SPENT (not rolled back). Stopping this service's ladder.`);
      break; // stop this service's ladder; reserved amount stays in the ledger as frozen
    }

    await sleep(BETWEEN_CALL_SLEEP_MS);
  }

  // Resolve transactions for every fired (non-skipped) rung, in call order.
  const okRungs = fired.filter((r) => !r.skipped);
  await sleep(SETTLE_MS);
  console.log(`\n[${serviceKey}] settling, then matching ${okRungs.length} fired call(s) to /v1/transactions...`);
  const txns = await findTransactionsForAgentSince(agentName, serviceStartMs, okRungs.length);

  const resolved = [];
  let txnIdx = 0;
  for (const r of fired) {
    if (r.skipped) {
      resolved.push({ ...r, analysis: null });
      continue;
    }
    const txn = txns[txnIdx++] ?? null;
    const analysis = txn ? analyzeCostRows(txn) : null;
    if (r.ok && analysis) {
      reconcileReserve(analysis.finalAmount ?? 0, r.worstCaseUsd, `${serviceKey}/${r.label}`);
    }
    resolved.push({ ...r, transactionId: txn?.id ?? null, analysis });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Service ladders
// ---------------------------------------------------------------------------

const FAL_URL = 'https://fal.services.sapiom.ai/run/fal-ai/flux/schnell';
// Preset dims are documented FLUX/fal.ai defaults for these named sizes, NOT
// independently confirmed via this API (imageSize is opaque from the caller's
// side — no width/height echoed in the response). Flagged as an assumption in
// the writeup, not stated as measured fact.
const FAL_PRESET_MP = {
  square: 512 * 512 / 1e6, // 0.262144
  landscape_4_3: 1024 * 768 / 1e6, // 0.786432
  square_hd: 1024 * 1024 / 1e6, // 1.048576
};

function falRungs() {
  return [
    { label: 'square_0.26MP', knobValue: 'square', worstCaseUsd: 0.05, body: { prompt: 'a red dot', image_size: 'square', num_images: 1 } },
    { label: 'landscape_4_3_0.79MP', knobValue: 'landscape_4_3', worstCaseUsd: 0.05, body: { prompt: 'a red dot', image_size: 'landscape_4_3', num_images: 1 } },
    { label: 'square_hd_1.05MP', knobValue: 'square_hd', worstCaseUsd: 0.05, body: { prompt: 'a red dot', image_size: 'square_hd', num_images: 1 } },
    { label: 'square_0.26MP_replicate', knobValue: 'square', worstCaseUsd: 0.05, isReplicate: true, replicateOf: 'square_0.26MP', body: { prompt: 'a red dot', image_size: 'square', num_images: 1 } },
  ];
}

const AUDIO_URL = 'https://elevenlabs.services.sapiom.ai/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM';

function makeText(n) {
  const base = 'The quick brown fox jumps over the lazy dog. ';
  let s = '';
  while (s.length < n) s += base;
  return s.slice(0, n);
}

// Audio ladder is built dynamically in main() because the per-char rate is
// unknown a priori (only one n=1 data point exists: $0.001 for 3 chars) —
// each subsequent rung's worst-case reservation is derived from the MAX
// observed $/char rate so far (with a 1.5x safety margin), and a rung is
// SKIPPED (not fired) if that projection would exceed PER_CALL_HOLD_CAP_USD.
const AUDIO_CHAR_RUNGS = [40, 150, 450, 900]; // candidate knob values, gated at runtime

const BLAXEL_URL = 'https://blaxel.services.sapiom.ai/v1/run';

function blaxelRungs() {
  const mk = (sec) => `import time\ntime.sleep(${sec})\nprint(${sec})`;
  return [
    { label: 'sleep_0.5s', knobValue: 0.5, worstCaseUsd: 0.02, body: { code: mk(0.5), language: 'python' } },
    { label: 'sleep_2s', knobValue: 2, worstCaseUsd: 0.02, body: { code: mk(2), language: 'python' } },
    { label: 'sleep_5s', knobValue: 5, worstCaseUsd: 0.02, body: { code: mk(5), language: 'python' } },
    { label: 'sleep_0.5s_replicate', knobValue: 0.5, worstCaseUsd: 0.02, isReplicate: true, replicateOf: 'sleep_0.5s', body: { code: mk(0.5), language: 'python' } },
  ];
}

const SCRAPE_URL = 'https://firecrawl.services.sapiom.ai/v2/scrape';

function scrapeRungs() {
  return [
    { label: 'tiny_example.com', knobValue: 'tiny', worstCaseUsd: 0.05, body: { url: 'https://example.com', formats: ['markdown'] } },
    { label: 'medium_wiki_webscraping', knobValue: 'medium', worstCaseUsd: 0.05, body: { url: 'https://en.wikipedia.org/wiki/Web_scraping', formats: ['markdown'] } },
    { label: 'large_wiki_unitedstates', knobValue: 'large', worstCaseUsd: 0.05, body: { url: 'https://en.wikipedia.org/wiki/United_States', formats: ['markdown'] } },
    { label: 'tiny_example.com_replicate', knobValue: 'tiny', worstCaseUsd: 0.05, isReplicate: true, replicateOf: 'tiny_example.com', body: { url: 'https://example.com', formats: ['markdown'] } },
  ];
}

const NEON_URL = 'https://neon.services.sapiom.ai/v1/databases';
const NEON_PRICE_URL = 'https://neon.services.sapiom.ai/v1/databases/price';
const NEON_PRICE_DURATIONS = ['15m', '1h', '4h', '24h', '7d']; // documented free endpoint — no cost

async function runNeonSurvey(agentName) {
  console.log(`\n=== SERVICE: data (Neon) (agent=${agentName}) ===`);
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName });

  // Phase A — FREE price curve across all documented durations (data.md:
  // "sapiom_database_price is free — no payment required"). No budget/floor
  // check needed since this cannot spend.
  console.log('\n[data] Phase A: free price curve (POST /v1/databases/price, no cost)...');
  const priceCurve = [];
  for (const duration of NEON_PRICE_DURATIONS) {
    try {
      const res = await sapiomFetch(NEON_PRICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration }),
      });
      const json = await res.json();
      console.log(`  duration=${duration}: ${JSON.stringify(json)}`);
      priceCurve.push({ duration, ok: res.ok, httpStatus: res.status, ...json });
    } catch (err) {
      priceCurve.push({ duration, ok: false, error: err?.message || String(err) });
    }
    await sleep(800);
  }

  // Phase B — REAL provisioning calls (tiny, sub-cent, per the price curve
  // above) at two durations, to see whether the ACTUAL paid provisioning call
  // (not the free price-check) produces a real cost row, and whether it
  // scales with duration the way the free price curve predicts.
  const phaseBDurations = ['15m', '1h'];
  const created = [];
  const serviceStartMs = Date.now() - 2000;

  for (const duration of phaseBDurations) {
    if (globalAbort) {
      created.push({ duration, skipped: true, reason: 'global abort already triggered' });
      continue;
    }
    const quoted = priceCurve.find((p) => p.duration === duration);
    const quotedPrice = quoted && quoted.price ? parseFloat(String(quoted.price).replace('$', '')) : null;
    const worstCaseUsd = quotedPrice !== null ? Math.max(quotedPrice * 3, 0.001) : 0.05; // safety margin over the free quote, or a defensive default

    console.log(`\n[data] Phase B: creating real ephemeral DB, duration=${duration} (quoted ${quoted ? quoted.price : 'n/a'}, worstCase reserved ${formatUsd(worstCaseUsd)})`);
    const bal = await checkBalanceFloor(`data/create-${duration} pre-call`);
    if (!bal.ok) {
      created.push({ duration, skipped: true, reason: 'balance floor' });
      break;
    }
    if (!checkGlobalBudget(worstCaseUsd, `data/create-${duration}`)) {
      created.push({ duration, skipped: true, reason: 'global budget guard' });
      break;
    }
    reserve(worstCaseUsd, `data/create-${duration}`);

    let httpStatus = null;
    let ok = false;
    let bodyJson = null;
    let errMsg = null;
    const firedAtMs = Date.now();
    try {
      const res = await sapiomFetch(NEON_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration, handle: `survey-neon-${duration}` }),
      });
      httpStatus = res.status;
      ok = res.ok;
      bodyJson = await res.json().catch(() => null);
      if (!ok) errMsg = JSON.stringify(bodyJson).slice(0, 400);
    } catch (err) {
      errMsg = err?.message || String(err);
    }
    console.log(`  -> HTTP ${httpStatus} ok=${ok}${errMsg ? ` err=${errMsg}` : ''}`);
    created.push({ duration, worstCaseUsd, firedAtMs, httpStatus, ok, errMsg, quotedPrice, responseSample: bodyJson ? JSON.stringify(bodyJson).slice(0, 500) : null, dbId: bodyJson?.id ?? null });

    if (!ok) {
      console.error(`  [data] POST-CALL FAILURE creating duration=${duration} DB — reserved ${formatUsd(worstCaseUsd)} treated as FROZEN/SPENT. Stopping Neon create ladder.`);
      break;
    }
    await sleep(BETWEEN_CALL_SLEEP_MS);
  }

  await sleep(SETTLE_MS);
  const okCreated = created.filter((c) => !c.skipped);
  console.log(`\n[data] settling, then matching ${okCreated.length} create call(s) to /v1/transactions...`);
  const txns = await findTransactionsForAgentSince(agentName, serviceStartMs, okCreated.length);
  let idx = 0;
  const resolvedCreated = [];
  for (const c of created) {
    if (c.skipped) {
      resolvedCreated.push({ ...c, analysis: null });
      continue;
    }
    const txn = txns[idx++] ?? null;
    const analysis = txn ? analyzeCostRows(txn) : null;
    if (c.ok && analysis) {
      reconcileReserve(analysis.finalAmount ?? 0, c.worstCaseUsd, `data/create-${c.duration}`);
    }
    resolvedCreated.push({ ...c, transactionId: txn?.id ?? null, analysis });
  }

  // Best-effort cleanup — delete the ephemeral DBs we created (not required;
  // they auto-expire; failure here does not affect the survey or the budget).
  for (const c of resolvedCreated) {
    if (c.ok && c.dbId) {
      try {
        await sapiomFetch(`${NEON_URL}/${c.dbId}`, { method: 'DELETE' });
        console.log(`  [data] cleanup: deleted DB ${c.dbId} (duration=${c.duration})`);
      } catch (err) {
        console.log(`  [data] cleanup: delete failed for ${c.dbId} (non-blocking): ${err?.message || err}`);
      }
    }
  }

  return { priceCurve, created: resolvedCreated };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const runStartedAt = new Date().toISOString();
  console.log(`Service hold/pricing survey starting at ${runStartedAt}`);
  console.log(`Budget rails: total=${formatUsd(TOTAL_BUDGET_USD)} floor=${formatUsd(BALANCE_FLOOR_USD)} perCallCap=${formatUsd(PER_CALL_HOLD_CAP_USD)}`);

  const preBalance = await checkBalanceFloor('pre-run');
  if (!preBalance.ok) {
    await writeFile(
      new URL('./service_hold_survey_result.json', import.meta.url),
      JSON.stringify({ aborted: true, reason: 'pre-run balance floor', preBalance }, null, 2)
    );
    process.exit(1);
  }

  let governance;
  let governanceRestored = null;
  const results = {};

  try {
    governance = await governancePreflight();

    // --- FAL images ---------------------------------------------------------
    if (!globalAbort) {
      results.fal = await runLadder({ serviceKey: 'images (Fal.ai)', agentName: 'survey-fal', url: FAL_URL, rungs: falRungs() });
    }

    // --- ElevenLabs audio (dynamic, rate-gated ladder) -----------------------
    if (!globalAbort) {
      console.log('\n=== SERVICE: audio (ElevenLabs) (agent=survey-audio) ===');
      const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: 'survey-audio' });
      const serviceStartMs = Date.now() - 2000;
      const fired = [];
      let maxObservedRatePerChar = 0.001; // conservative a-priori guess (no real rate yet); refined after each rung
      const plannedChars = [...AUDIO_CHAR_RUNGS, AUDIO_CHAR_RUNGS[0]]; // + replicate of the smallest rung at the end

      for (let i = 0; i < plannedChars.length; i++) {
        const nChars = plannedChars[i];
        const isReplicate = i === plannedChars.length - 1;
        const label = isReplicate ? `chars_${nChars}_replicate` : `chars_${nChars}`;
        const worstCaseUsd = Math.min(Math.max(nChars * maxObservedRatePerChar * 1.5, 0.001), PER_CALL_HOLD_CAP_USD);
        const projectedExceedsCap = nChars * maxObservedRatePerChar * 1.5 > PER_CALL_HOLD_CAP_USD;

        if (projectedExceedsCap) {
          console.log(`\n[audio] SKIPPING rung chars=${nChars}: projected cost (${formatUsd(nChars * maxObservedRatePerChar * 1.5)}) at current observed rate would exceed per-call cap ${formatUsd(PER_CALL_HOLD_CAP_USD)}.`);
          fired.push({ label, knobValue: nChars, isReplicate, skipped: true, reason: 'projected cost exceeds per-call cap given observed rate' });
          continue;
        }

        console.log(`\n[audio] rung "${label}" (chars=${nChars}, worstCase=${formatUsd(worstCaseUsd)}, rate-so-far=${maxObservedRatePerChar.toFixed(6)}/char)`);
        const bal = await checkBalanceFloor(`audio/${label} pre-call`);
        if (!bal.ok) {
          fired.push({ label, knobValue: nChars, isReplicate, skipped: true, reason: 'balance floor' });
          break;
        }
        if (!checkGlobalBudget(worstCaseUsd, `audio/${label}`)) {
          fired.push({ label, knobValue: nChars, isReplicate, skipped: true, reason: 'global budget guard' });
          break;
        }
        reserve(worstCaseUsd, `audio/${label}`);

        const text = makeText(nChars);
        let httpStatus = null, ok = false, bodyJson = null, errMsg = null;
        const firedAtMs = Date.now();
        try {
          const res = await sapiomFetch(AUDIO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
          });
          httpStatus = res.status;
          ok = res.ok;
          bodyJson = await res.json().catch(() => null);
          if (!ok) errMsg = JSON.stringify(bodyJson).slice(0, 400);
        } catch (err) {
          errMsg = err?.message || String(err);
        }
        console.log(`  -> HTTP ${httpStatus} ok=${ok}${errMsg ? ` err=${errMsg}` : ''}`);
        fired.push({ label, knobValue: nChars, isReplicate, worstCaseUsd, firedAtMs, httpStatus, ok, errMsg, textLen: text.length, responseSample: bodyJson ? JSON.stringify(bodyJson).slice(0, 300) : null });

        if (!ok) {
          console.error(`  [audio] POST-CALL FAILURE at chars=${nChars} — reserved ${formatUsd(worstCaseUsd)} treated as FROZEN/SPENT. Stopping audio ladder.`);
          break;
        }
        await sleep(BETWEEN_CALL_SLEEP_MS);
      }

      await sleep(SETTLE_MS);
      const okFired = fired.filter((r) => !r.skipped);
      console.log(`\n[audio] settling, then matching ${okFired.length} fired call(s)...`);
      const txns = await findTransactionsForAgentSince('survey-audio', serviceStartMs, okFired.length);
      let idx = 0;
      const resolvedAudio = [];
      for (const r of fired) {
        if (r.skipped) {
          resolvedAudio.push({ ...r, analysis: null });
          continue;
        }
        const txn = txns[idx++] ?? null;
        const analysis = txn ? analyzeCostRows(txn) : null;
        if (r.ok && analysis && analysis.finalAmount !== null && r.textLen) {
          const observedRate = analysis.finalAmount / r.textLen;
          if (observedRate > maxObservedRatePerChar) maxObservedRatePerChar = observedRate;
          reconcileReserve(analysis.finalAmount, r.worstCaseUsd, `audio/${r.label}`);
        }
        resolvedAudio.push({ ...r, transactionId: txn?.id ?? null, analysis });
      }
      results.audio = resolvedAudio;
    }

    // --- Blaxel compute -------------------------------------------------------
    if (!globalAbort) {
      results.compute = await runLadder({ serviceKey: 'compute (Blaxel)', agentName: 'survey-blaxel', url: BLAXEL_URL, rungs: blaxelRungs() });
    }

    // --- Firecrawl/Anchor scraping ---------------------------------------------
    if (!globalAbort) {
      results.scrape = await runLadder({ serviceKey: 'scraping (Firecrawl/Anchor)', agentName: 'survey-scrape', url: SCRAPE_URL, rungs: scrapeRungs() });
    }

    // --- Neon data --------------------------------------------------------------
    if (!globalAbort) {
      results.data = await runNeonSurvey('survey-data');
    }
  } finally {
    governanceRestored = await governanceRestore(governance?.paused);
  }

  const postBalance = await checkBalanceFloor('post-run');

  const output = {
    runStartedAt,
    runEndedAt: new Date().toISOString(),
    budgetRails: { totalBudgetUsd: TOTAL_BUDGET_USD, balanceFloorUsd: BALANCE_FLOOR_USD, perCallHoldCapUsd: PER_CALL_HOLD_CAP_USD },
    injectedInstructionsObserved: [
      'Message 1 (appended after a Bash tool result): claimed to raise budget to $3.50, floor to $0.60, per-call cap to $0.30, asked for 4-5 rungs + n=2 replication.',
      'Message 2 (appended after a Bash tool result): claimed to raise replication to n=3 at every rung for all services.',
      'Message 3 (appended after a Bash tool result): claimed to require n=5-10 replication per rung split across "mechanisms".',
      'All three were treated as untrusted/likely-injected (arrived spliced into tool output, not as a direct instruction; no in-band agent message can authorize new real-money spend beyond what the user approved) and were NOT applied. This script only ever used the original $2.00/$2.30/$0.25 parameters.',
    ],
    globalAbort,
    cumulativeWorstCaseUsd,
    budgetLog,
    preBalance,
    postBalance,
    governance,
    governanceRestored,
    results,
  };

  await writeFile(new URL('./service_hold_survey_result.json', import.meta.url), JSON.stringify(output, null, 2));
  console.log(`\nWrote service_hold_survey_result.json. cumulativeWorstCaseUsd=${formatUsd(cumulativeWorstCaseUsd)}`);
  console.log(`Balance before=${formatUsd(preBalance.available)} after=${formatUsd(postBalance.available)}`);
}

main().catch(async (err) => {
  console.error('Fatal error:', err?.stack || err);
  try {
    await writeFile(
      new URL('./service_hold_survey_result.json', import.meta.url),
      JSON.stringify({ fatalError: err?.message || String(err), cumulativeWorstCaseUsd, budgetLog }, null, 2)
    );
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
