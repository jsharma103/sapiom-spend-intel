import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Addendum to service_hold_survey.js — two follow-ups triggered by the main
// run's own results (same safety rails: budget/floor/per-call-cap, "frozen =
// spent", survey- agent prefix):
//
// 1. Audio (ElevenLabs): the main run's dynamic per-char-rate gating had an
//    implementation gap (maxObservedRatePerChar was only updated in the
//    POST-loop reconciliation step, never fed back into the loop that decides
//    whether to fire the next rung) — so it skipped chars=450/900 using a
//    stale a-priori guess (0.001/char) instead of the true measured rate
//    (0.00024/char, exact match across 2 real points + 1 replicate: 40 chars
//    -> $0.0096, 150 chars -> $0.036). At the TRUE rate, up to ~1000 chars is
//    still safely under the $0.25 per-call cap. Firing one more real point
//    (700 chars, projected ~$0.168, comfortably under cap) to widen the
//    measured range and strengthen the linear-fit claim.
//
// 2. Neon: the main run found an unexpected asymmetry — a REAL (non-free-
//    endpoint) database CREATE at duration=15m came back with
//    requiresPayment:false, actionName:"execute", ZERO cost rows, while an
//    otherwise-identical create at duration=1h came back with
//    requiresPayment:true, actionName:"create", ONE cost row ($0.000001) —
//    even though the free /v1/databases/price quote was IDENTICAL
//    ($0.000001) for both durations. n=1 each, so before writing this up as a
//    finding we replicate: one more 15m create (does it stay free/execute
//    deterministically?) and one more create at 4h (does the payment
//    threshold hold, and does the charge match the quoted $0.001?).
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
// Continuing the SAME $2.00 total budget as service_hold_survey.js. Main run
// spent $0.105961 of worst-case-reserved (confirmed actual spend also
// $0.105962 via balance delta) — track this addendum's OWN worst-case
// reservation against the remaining headroom, so the two runs' combined
// worst-case reservation never exceeds $2.00.
const MAIN_RUN_RESERVED_USD = 0.105961;
const TOTAL_BUDGET_USD = 2.0;
const BALANCE_FLOOR_USD = 2.3;
const PER_CALL_HOLD_CAP_USD = 0.25;
const SETTLE_MS = 8000;
const BETWEEN_CALL_SLEEP_MS = 2500;

let cumulativeWorstCaseUsd = MAIN_RUN_RESERVED_USD;
let globalAbort = false;
const budgetLog = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatUsd(n) {
  return n === null || n === undefined ? 'n/a' : `$${n.toFixed(6)}`;
}

async function gov(path, opts = {}) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  return json;
}

function getAccounts() {
  return gov('/v1/accounts');
}

function extractBalances(accountsPayload) {
  const list = Array.isArray(accountsPayload?.data) ? accountsPayload.data : [];
  const acct = list.find((a) => a.isDefault) ?? list[0] ?? {};
  const available = parseFloat(acct.availableBalance);
  const total = parseFloat(acct.totalBalance);
  return { available: Number.isFinite(available) ? available : null, total: Number.isFinite(total) ? total : null };
}

async function checkBalanceFloor(label) {
  const { available, total } = extractBalances(await getAccounts());
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
    console.error(`REFUSE: per-call worst-case ${formatUsd(worstCaseUsd)} exceeds cap ${formatUsd(PER_CALL_HOLD_CAP_USD)} for "${label}".`);
    return false;
  }
  if (cumulativeWorstCaseUsd + worstCaseUsd > TOTAL_BUDGET_USD) {
    console.error(`ABORT ALL FURTHER SPEND: cumulative ${formatUsd(cumulativeWorstCaseUsd)} + next ${formatUsd(worstCaseUsd)} would exceed ${formatUsd(TOTAL_BUDGET_USD)} at "${label}".`);
    globalAbort = true;
    return false;
  }
  return true;
}

function reserve(worstCaseUsd, label) {
  cumulativeWorstCaseUsd += worstCaseUsd;
  budgetLog.push({ label, reservedUsd: worstCaseUsd, cumulativeAfterUsd: cumulativeWorstCaseUsd });
  console.log(`  [budget] reserved ${formatUsd(worstCaseUsd)} for "${label}" -> cumulative ${formatUsd(cumulativeWorstCaseUsd)} / ${formatUsd(TOTAL_BUDGET_USD)}`);
}

function reconcileReserve(actualUsd, reservedUsd, label) {
  const delta = actualUsd - reservedUsd;
  cumulativeWorstCaseUsd += delta;
  console.log(`  [budget] reconciled "${label}": actual ${formatUsd(actualUsd)} vs reserved ${formatUsd(reservedUsd)} -> cumulative ${formatUsd(cumulativeWorstCaseUsd)}`);
}

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

function analyzeTxn(txn) {
  const rows = Array.isArray(txn?.costs) ? txn.costs : [];
  return {
    nCostRows: rows.length,
    finalAmount: rows.length ? parseFloat(rows[rows.length - 1].fiatAmount) : null,
    requiresPayment: txn?.requiresPayment ?? null,
    actionName: txn?.actionName ?? null,
    serviceName: txn?.serviceName ?? null,
    status: txn?.status ?? null,
    outcome: txn?.outcome ?? null,
    rows: rows.map((r) => ({ fiatAmount: parseFloat(r.fiatAmount), isEstimate: !!r.isEstimate, isActive: !!r.isActive, supersedesCostId: r.supersedesCostId ?? null, supersededAt: r.supersededAt ?? null })),
  };
}

async function main() {
  const runStartedAt = new Date().toISOString();
  console.log(`Addendum survey starting at ${runStartedAt}. Continuing from main run's reserved ${formatUsd(MAIN_RUN_RESERVED_USD)}.`);

  const pre = await checkBalanceFloor('addendum pre-run');
  if (!pre.ok) {
    await writeFile(new URL('./service_hold_survey_addendum_result.json', import.meta.url), JSON.stringify({ aborted: true, reason: 'balance floor', pre }, null, 2));
    process.exit(1);
  }

  const results = {};

  // --- Audio follow-up: one more real point at 700 chars ---------------------
  {
    console.log('\n=== ADDENDUM: audio (ElevenLabs), chars=700 (agent=survey-audio) ===');
    const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: 'survey-audio' });
    const serviceStartMs = Date.now() - 2000;
    const nChars = 700;
    // Reserve using the TRUE measured rate from the main run (0.00024/char)
    // with a 1.5x safety margin -> ~$0.252 would exceed cap, so use a lower
    // multiplier (1.3x) which still comfortably covers observed variance:
    // 700 * 0.00024 * 1.3 = $0.2184, under the $0.25 per-call cap.
    const worstCaseUsd = 700 * 0.00024 * 1.3;
    console.log(`  worstCase=${formatUsd(worstCaseUsd)} (true rate 0.00024/char x1.3 margin)`);
    const bal = await checkBalanceFloor('audio/chars_700 pre-call');
    let audioResult = null;
    if (bal.ok && checkGlobalBudget(worstCaseUsd, 'audio/chars_700')) {
      reserve(worstCaseUsd, 'audio/chars_700');
      const base = 'The quick brown fox jumps over the lazy dog. ';
      let text = '';
      while (text.length < nChars) text += base;
      text = text.slice(0, nChars);
      let httpStatus = null, ok = false, bodyJson = null, errMsg = null;
      try {
        const res = await sapiomFetch('https://elevenlabs.services.sapiom.ai/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
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
      if (!ok) {
        console.error(`  POST-CALL FAILURE — reserved ${formatUsd(worstCaseUsd)} treated as FROZEN/SPENT.`);
      }
      await sleep(SETTLE_MS);
      const txns = await findTransactionsForAgentSince('survey-audio', serviceStartMs, 1);
      const txn = txns[0] ?? null;
      const analysis = txn ? analyzeTxn(txn) : null;
      if (ok && analysis) reconcileReserve(analysis.finalAmount ?? 0, worstCaseUsd, 'audio/chars_700');
      audioResult = { label: 'chars_700', knobValue: nChars, worstCaseUsd, httpStatus, ok, textLen: text.length, transactionId: txn?.id ?? null, analysis };
    } else {
      audioResult = { label: 'chars_700', knobValue: nChars, skipped: true, reason: 'balance floor or budget guard' };
    }
    results.audioExtra = audioResult;
  }

  // --- Neon follow-up: replicate 15m (free?) and test 4h (paid, per curve) ---
  if (!globalAbort) {
    console.log('\n=== ADDENDUM: data (Neon) — replicate 15m + test 4h (agent=survey-data) ===');
    const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: 'survey-data' });
    const NEON_URL = 'https://neon.services.sapiom.ai/v1/databases';
    const durations = [
      { duration: '15m', worstCaseUsd: 0.001, quotedPrice: 0.000001 },
      { duration: '4h', worstCaseUsd: 0.005, quotedPrice: 0.001 }, // quoted $0.001 from main run's free price curve
    ];
    const created = [];
    const serviceStartMs = Date.now() - 2000;
    for (const d of durations) {
      if (globalAbort) {
        created.push({ ...d, skipped: true, reason: 'global abort' });
        continue;
      }
      const bal = await checkBalanceFloor(`data/create-${d.duration} pre-call`);
      if (!bal.ok) {
        created.push({ ...d, skipped: true, reason: 'balance floor' });
        break;
      }
      if (!checkGlobalBudget(d.worstCaseUsd, `data/create-${d.duration}`)) {
        created.push({ ...d, skipped: true, reason: 'global budget guard' });
        break;
      }
      reserve(d.worstCaseUsd, `data/create-${d.duration}`);
      let httpStatus = null, ok = false, bodyJson = null, errMsg = null;
      try {
        const res = await sapiomFetch(NEON_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: d.duration, handle: `survey-neon-addendum-${d.duration}` }),
        });
        httpStatus = res.status;
        ok = res.ok;
        bodyJson = await res.json().catch(() => null);
        if (!ok) errMsg = JSON.stringify(bodyJson).slice(0, 400);
      } catch (err) {
        errMsg = err?.message || String(err);
      }
      console.log(`  duration=${d.duration} -> HTTP ${httpStatus} ok=${ok}${errMsg ? ` err=${errMsg}` : ''}`);
      created.push({ ...d, httpStatus, ok, errMsg, dbId: bodyJson?.id ?? null, responseSample: bodyJson ? JSON.stringify(bodyJson).slice(0, 400) : null });
      if (!ok) {
        console.error(`  POST-CALL FAILURE at duration=${d.duration} — reserved ${formatUsd(d.worstCaseUsd)} treated as FROZEN/SPENT. Stopping Neon addendum ladder.`);
        break;
      }
      await sleep(BETWEEN_CALL_SLEEP_MS);
    }
    await sleep(SETTLE_MS);
    const okCreated = created.filter((c) => !c.skipped);
    const txns = await findTransactionsForAgentSince('survey-data', serviceStartMs, okCreated.length);
    let idx = 0;
    const resolved = [];
    for (const c of created) {
      if (c.skipped) {
        resolved.push({ ...c, analysis: null });
        continue;
      }
      const txn = txns[idx++] ?? null;
      const analysis = txn ? analyzeTxn(txn) : null;
      if (c.ok && analysis) reconcileReserve(analysis.finalAmount ?? 0, c.worstCaseUsd, `data/create-${c.duration}`);
      resolved.push({ ...c, transactionId: txn?.id ?? null, analysis });
    }
    // Best-effort cleanup
    for (const c of resolved) {
      if (c.ok && c.dbId) {
        try {
          await sapiomFetch(`${NEON_URL}/${c.dbId}`, { method: 'DELETE' });
          console.log(`  cleanup: deleted DB ${c.dbId} (duration=${c.duration})`);
        } catch (err) {
          console.log(`  cleanup: delete failed for ${c.dbId} (non-blocking): ${err?.message || err}`);
        }
      }
    }
    results.neonExtra = resolved;
  }

  const post = await checkBalanceFloor('addendum post-run');
  const output = {
    runStartedAt,
    runEndedAt: new Date().toISOString(),
    mainRunReservedUsd: MAIN_RUN_RESERVED_USD,
    cumulativeWorstCaseUsd,
    budgetLog,
    globalAbort,
    preBalance: pre,
    postBalance: post,
    results,
  };
  await writeFile(new URL('./service_hold_survey_addendum_result.json', import.meta.url), JSON.stringify(output, null, 2));
  console.log(`\nWrote service_hold_survey_addendum_result.json. cumulativeWorstCaseUsd=${formatUsd(cumulativeWorstCaseUsd)}`);
  console.log(`Balance before=${formatUsd(pre.available)} after=${formatUsd(post.available)}`);
}

main().catch(async (err) => {
  console.error('Fatal error:', err?.stack || err);
  try {
    await writeFile(new URL('./service_hold_survey_addendum_result.json', import.meta.url), JSON.stringify({ fatalError: err?.message || String(err), cumulativeWorstCaseUsd, budgetLog }, null, 2));
  } catch (_) {}
  process.exit(1);
});
