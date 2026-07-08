import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// neon_nondeterminism_n10.js — replicate the 15-minute Neon-create
// non-determinism found in dryrun/service_hold_survey.md /
// service_hold_survey_addendum.js at higher n.
//
// Prior evidence (n=2 at the 15m duration, pooled from the main survey run
// + its addendum): two IDENTICAL `POST /v1/databases` calls with
// duration="15m" landed differently classified —
//   - one: requiresPayment:false, actionName:"execute", 0 cost rows, $0
//   - one: requiresPayment:true,  actionName:"create",  1 cost row, $0.000001
// n=2 is a coin flip, not a rate. This script fires n=10 MORE identical 15m
// creates (same handle pattern `survey-neon-<duration>[-suffix]`, same
// duration string, same account) to see how often each behavior recurs, so
// the writeup can pool n=12 total and estimate an actual split rate instead
// of reporting "it happened once."
//
// Reuses the EXACT call shape from service_hold_survey_addendum.js's Neon
// block: same @sapiom/fetch usage, same governance/floor/budget rails, same
// findTransactionsForAgentSince + full-transaction-fetch pattern, same
// best-effort DELETE cleanup. Only change: agentName = 'survey-neon-n10' and
// a 10x sequential loop instead of one call, plus this run captures the FULL
// raw transaction JSON per call (not just the flattened analysis) per the
// task's deliverable requirement.
//
// Budget: real money, api.sapiom.ai. User-approved cap for this task = $0.25
// total. Each 15m Neon create costs at most $0.000001 (per the free /price
// quote, confirmed exactly matched by every charged create seen so far), so
// n=10 costs at most $0.00001 total — the $0.25 cap and the $2.00 balance
// floor below are tripwires, not expected to bind.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const TOTAL_BUDGET_USD = 0.25; // hard cap for THIS script's own spend (task-approved)
const BALANCE_FLOOR_USD = 2.0; // abort if availableBalance drops below this (tripwire)
const PER_CALL_HOLD_CAP_USD = 0.05; // generous vs. the ~$0.000001 expected cost
const N_CALLS = 10;
const AGENT_NAME = 'survey-neon-n10';
const DURATION = '15m';
const SETTLE_MS = 8000;
const BETWEEN_CALL_SLEEP_MS = 2500;

let cumulativeWorstCaseUsd = 0;
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

async function findTransactionsForAgentSince(agentName, sinceMs, minCount, maxPages = 12) {
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
    createdAt: txn?.createdAt ?? null,
    authorizedAt: txn?.authorizedAt ?? null,
    completedAt: txn?.completedAt ?? null,
    rows: rows.map((r) => ({
      fiatAmount: parseFloat(r.fiatAmount),
      isEstimate: !!r.isEstimate,
      isActive: !!r.isActive,
      supersedesCostId: r.supersedesCostId ?? null,
      supersededAt: r.supersededAt ?? null,
      createdAt: r.createdAt ?? null,
    })),
  };
}

async function governancePreflight() {
  console.log('\n=== GOVERNANCE PRE-FLIGHT ===');
  const rules = [];
  let path = '/v1/spending-rules?include=parameters,conditions,agents,services,transactions';
  while (path) {
    const payload = await gov(path);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    rules.push(...data);
    path = fixNextLink(payload?.links?.next);
  }
  const active = rules.filter((r) => r.attributes?.status === 'active');
  console.log(`Found ${rules.length} total spending rules, ${active.length} active.`);
  return { total: rules.length, active: active.length, activeRules: active };
}

async function main() {
  const runStartedAt = new Date().toISOString();
  console.log(`neon_nondeterminism_n10 starting at ${runStartedAt}`);
  console.log(`Budget rails: total=${formatUsd(TOTAL_BUDGET_USD)} floor=${formatUsd(BALANCE_FLOOR_USD)} perCallCap=${formatUsd(PER_CALL_HOLD_CAP_USD)} n=${N_CALLS} duration=${DURATION} agent=${AGENT_NAME}`);

  const preBalance = await checkBalanceFloor('pre-run');
  if (!preBalance.ok) {
    await writeFile(new URL('./neon_nondeterminism_n10_result.json', import.meta.url), JSON.stringify({ aborted: true, reason: 'pre-run balance floor', preBalance }, null, 2));
    process.exit(1);
  }

  const governance = await governancePreflight();
  if (governance.active > 0) {
    console.error(`ABORT: ${governance.active} active spending rule(s) found — refusing to fire without confirming they can't deny these calls (denied calls freeze holds permanently).`);
    await writeFile(new URL('./neon_nondeterminism_n10_result.json', import.meta.url), JSON.stringify({ aborted: true, reason: 'active spending rules present', governance }, null, 2));
    process.exit(1);
  }
  console.log(`Governance OK: ${governance.total} total rules, 0 active.`);

  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const NEON_URL = 'https://neon.services.sapiom.ai/v1/databases';
  const serviceStartMs = Date.now() - 2000;
  const created = [];

  for (let i = 0; i < N_CALLS; i++) {
    const label = `n10-call-${i + 1}`;
    if (globalAbort) {
      created.push({ index: i + 1, label, skipped: true, reason: 'global abort' });
      continue;
    }
    const bal = await checkBalanceFloor(`${label} pre-call`);
    if (!bal.ok) {
      created.push({ index: i + 1, label, skipped: true, reason: 'balance floor' });
      break;
    }
    const worstCaseUsd = 0.0001; // generous vs. the ~$0.000001 expected cost
    if (!checkGlobalBudget(worstCaseUsd, label)) {
      created.push({ index: i + 1, label, skipped: true, reason: 'global budget guard' });
      break;
    }
    reserve(worstCaseUsd, label);

    const handle = `survey-neon-n10-${i + 1}`;
    let httpStatus = null, ok = false, bodyJson = null, errMsg = null;
    const firedAt = new Date().toISOString();
    try {
      const res = await sapiomFetch(NEON_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: DURATION, handle }),
      });
      httpStatus = res.status;
      ok = res.ok;
      bodyJson = await res.json().catch(() => null);
      if (!ok) errMsg = JSON.stringify(bodyJson).slice(0, 400);
    } catch (err) {
      errMsg = err?.message || String(err);
    }
    console.log(`  [${label}] duration=${DURATION} -> HTTP ${httpStatus} ok=${ok}${errMsg ? ` err=${errMsg}` : ''}`);
    created.push({ index: i + 1, label, handle, firedAt, worstCaseUsd, httpStatus, ok, errMsg, dbId: bodyJson?.id ?? null, createResponse: bodyJson });

    if (!ok) {
      console.error(`  [${label}] POST-CALL FAILURE — reserved ${formatUsd(worstCaseUsd)} treated as FROZEN/SPENT. Stopping loop.`);
      break;
    }
    await sleep(BETWEEN_CALL_SLEEP_MS);
  }

  await sleep(SETTLE_MS);
  const okCreated = created.filter((c) => !c.skipped);
  console.log(`\nSettling, then matching ${okCreated.length} create call(s) to /v1/transactions for agent=${AGENT_NAME}...`);
  const txns = await findTransactionsForAgentSince(AGENT_NAME, serviceStartMs, okCreated.length);
  console.log(`Found ${txns.length} matching transaction(s).`);

  let idx = 0;
  const resolved = [];
  for (const c of created) {
    if (c.skipped) {
      resolved.push({ ...c, transactionId: null, analysis: null, rawTransaction: null });
      continue;
    }
    const txn = txns[idx++] ?? null;
    const analysis = txn ? analyzeTxn(txn) : null;
    if (c.ok && analysis) reconcileReserve(analysis.finalAmount ?? 0, c.worstCaseUsd, c.label);
    resolved.push({ ...c, transactionId: txn?.id ?? null, analysis, rawTransaction: txn });
  }

  // Best-effort cleanup — delete every DB we created.
  for (const c of resolved) {
    if (c.ok && c.dbId) {
      try {
        await sapiomFetch(`${NEON_URL}/${c.dbId}`, { method: 'DELETE' });
        console.log(`  cleanup: deleted DB ${c.dbId} (${c.label})`);
      } catch (err) {
        console.log(`  cleanup: delete failed for ${c.dbId} (non-blocking): ${err?.message || err}`);
      }
    }
  }

  const post = await checkBalanceFloor('post-run');

  const chargedCount = resolved.filter((c) => c.analysis && c.analysis.nCostRows > 0).length;
  const freeCount = resolved.filter((c) => c.analysis && c.analysis.nCostRows === 0).length;
  console.log(`\nSummary: ${chargedCount} charged / ${freeCount} free out of ${resolved.filter((c) => !c.skipped).length} resolved calls.`);

  const output = {
    runStartedAt,
    runEndedAt: new Date().toISOString(),
    agentName: AGENT_NAME,
    duration: DURATION,
    nRequested: N_CALLS,
    governance,
    cumulativeWorstCaseUsd,
    budgetLog,
    globalAbort,
    preBalance,
    postBalance: post,
    actualSpendUsd: preBalance.available !== null && post.available !== null ? +(preBalance.available - post.available).toFixed(6) : null,
    summary: { chargedCount, freeCount, resolvedCount: resolved.filter((c) => !c.skipped).length },
    calls: resolved,
  };
  await writeFile(new URL('./neon_nondeterminism_n10_result.json', import.meta.url), JSON.stringify(output, null, 2));
  console.log(`\nWrote neon_nondeterminism_n10_result.json. cumulativeWorstCaseUsd=${formatUsd(cumulativeWorstCaseUsd)}`);
  console.log(`Balance before=${formatUsd(preBalance.available)} after=${formatUsd(post.available)}`);
}

main().catch(async (err) => {
  console.error('Fatal error:', err?.stack || err);
  try {
    await writeFile(new URL('./neon_nondeterminism_n10_result.json', import.meta.url), JSON.stringify({ fatalError: err?.message || String(err), cumulativeWorstCaseUsd, budgetLog }, null, 2));
  } catch (_) {}
  process.exit(1);
});
