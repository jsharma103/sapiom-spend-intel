import { appendFile, readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// refund_watch (v2) — GET-only tracker for ALL FOUR known failure-capture
// holds, plus the account's aggregate frozen gap (totalBalance minus
// availableBalance).
//
// Background: dryrun/hold_linearity_extension.md (N=1, txn d59fb015...) and
// dryrun/failure_capture_n3.md (+3 more, txns c2c2ef60/0d248074/2f8bec77)
// found that when an LLM call errors AFTER Sapiom places a pre-authorization
// hold, the FULL hold is captured as the final settled cost instead of
// floor-settling like a successful call does. 4/4 observed errored-post-hold
// calls captured the full ~$0.076803 hold, 0/4 had reversed as of the last
// check before this script existed. This script exists to answer, over
// time: (a) does any individual capture ever reverse, and (b) does the
// account-wide frozen gap — which may include stuck money beyond these 4
// specific holds — ever shrink?
//
// v1 of this script (2026-07-04, superseded) tracked only d59fb015... against
// hardcoded baseline constants. v2 tracks all 4 holds and derives "did
// anything change" by comparing each run to the PREVIOUS log line instead of
// a fixed historical baseline — see REFUND_WATCH.md for the full format note
// and how to read a line.
//
// Safe to run repeatedly: only issues GET requests, never spends money.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set. Run with: node --env-file=.env dryrun/refund_watch.js');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';

// The 4 known failure-capture holds (each froze ~$0.076803 when the
// underlying call errored after the hold was placed).
//   d59fb015-f55f-4501-a3cb-247b6e091366  — dryrun/hold_linearity_extension.md (N=1)
//   c2c2ef60-2a28-4abf-8e61-1bfcae805bd7  — dryrun/failure_capture_n3.md (iteration 1)
//   0d248074-87fd-4f23-845f-c1c92e83fdf4  — dryrun/failure_capture_n3.md (iteration 2)
//   2f8bec77-71f1-4f06-8f3e-9dcd562a1ba9  — dryrun/failure_capture_n3.md (iteration 3)
const HOLD_IDS = [
  'd59fb015-f55f-4501-a3cb-247b6e091366',
  'c2c2ef60-2a28-4abf-8e61-1bfcae805bd7',
  '0d248074-87fd-4f23-845f-c1c92e83fdf4',
  '2f8bec77-71f1-4f06-8f3e-9dcd562a1ba9',
];

const EPS = 0.0000005; // float-compare tolerance for balance fields (all observed to 6dp)
const LOG_PATH = new URL('./refund_watch.log', import.meta.url);
const FORMAT_MARKER =
  '# --- format changed 2026-07-04: v2 tracks all 4 failure-capture holds + aggregate frozen gap (see REFUND_WATCH.md) ---';

function shortLabel(id) {
  return id.split('-')[0];
}

async function gov(path) {
  return fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
}

async function appendLog(line) {
  await appendFile(LOG_PATH, line + '\n');
}

async function readLastLogLine() {
  try {
    const raw = await readFile(LOG_PATH, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));
    return lines.length ? lines[lines.length - 1] : null;
  } catch {
    return null; // no log file yet — fine, first-ever run
  }
}

// Pull `key=value` out of a tab/pipe-delimited log line, whatever version it
// came from (both v1 and v2 lines use plain `key=value` tokens).
function parseKeyed(line, key) {
  if (!line) return null;
  const re = new RegExp(`(?:^|[\\t|])${key}=([^\\t|]+)`);
  const m = line.match(re);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

async function fetchAccounts() {
  try {
    const res = await gov('/v1/accounts');
    if (!res.ok) return { err: `HTTP ${res.status}` };
    const body = await res.json();
    const acct = Array.isArray(body?.data) ? body.data[0] : null;
    if (!acct) return { err: 'no-account-data' };
    const available = parseFloat(acct.availableBalance);
    const total = parseFloat(acct.totalBalance);
    if (!Number.isFinite(available) || !Number.isFinite(total)) return { err: 'unparseable-balance' };
    return { err: null, available, total };
  } catch (err) {
    return { err: err?.message || String(err) };
  }
}

// Reads a single hold's transaction + cost rows and classifies whether the
// ORIGINAL hold row (costs[0], created when the hold was placed) has been
// superseded/released, independent of the account-wide balance check.
async function fetchHold(holdId) {
  try {
    const res = await gov(`/v1/transactions/${holdId}?include=costs`);
    if (!res.ok) return { err: `HTTP ${res.status}` };
    const txn = await res.json();
    const costs = Array.isArray(txn?.costs) ? txn.costs : [];
    if (costs.length === 0) return { err: 'no-cost-rows' };
    const originalRow = costs[0];
    const supersedingRow = costs.find((c) => c.supersedesCostId === originalRow.id) ?? null;
    const released =
      costs.length > 1 ||
      originalRow.isActive === false ||
      originalRow.supersededAt != null ||
      supersedingRow != null;
    const liveRow = supersedingRow ?? costs.find((c) => c.isActive === true) ?? originalRow;
    return {
      err: null,
      released,
      originalFiatAmount: parseFloat(originalRow.fiatAmount),
      liveFiatAmount: parseFloat(liveRow.fiatAmount),
      isActive: originalRow.isActive === true,
      supersededAt: originalRow.supersededAt ?? null,
      rowCount: costs.length,
    };
  } catch (err) {
    return { err: err?.message || String(err) };
  }
}

async function main() {
  const timestamp = new Date().toISOString();

  const prevLine = await readLastLogLine();
  const prevAvailable = parseKeyed(prevLine, 'available');
  const prevTotal = parseKeyed(prevLine, 'total');
  const prevFrozenExplicit = parseKeyed(prevLine, 'frozen');
  const prevFrozen =
    prevFrozenExplicit !== null
      ? prevFrozenExplicit
      : prevTotal !== null && prevAvailable !== null
        ? prevTotal - prevAvailable
        : null;

  const [accounts, ...holds] = await Promise.all([fetchAccounts(), ...HOLD_IDS.map((id) => fetchHold(id))]);

  if (accounts.err) {
    const line = `${timestamp}\tERROR\taccounts=${accounts.err}`;
    await appendLog(line);
    console.log(`[refund_watch] FAILED — could not read /v1/accounts: ${accounts.err}`);
    process.exit(1);
  }

  const { available, total } = accounts;
  const frozen = total - available;
  const totalDroppedSincePrev = prevTotal !== null && total < prevTotal - EPS;

  let anyHoldErr = false;
  const perHold = HOLD_IDS.map((id, i) => {
    const h = holds[i];
    const label = shortLabel(id);
    if (h.err) {
      anyHoldErr = true;
      return { label, state: 'ERROR', display: `${label}=ERROR(${h.err})`, originalFiatAmount: 0 };
    }
    const state = h.released ? 'RELEASED' : totalDroppedSincePrev ? 'GONE' : 'FROZEN';
    const amt = Number.isFinite(h.originalFiatAmount) ? h.originalFiatAmount.toFixed(6) : 'n/a';
    const display =
      state === 'RELEASED'
        ? `${label}=RELEASED($${Number.isFinite(h.liveFiatAmount) ? h.liveFiatAmount.toFixed(6) : 'n/a'},was$${amt})`
        : `${label}=${state}($${amt})`;
    return { label, state, display, originalFiatAmount: h.originalFiatAmount };
  });

  const nFrozen = perHold.filter((h) => h.state === 'FROZEN').length;
  const nReleased = perHold.filter((h) => h.state === 'RELEASED').length;
  const nGone = perHold.filter((h) => h.state === 'GONE').length;
  const nErr = perHold.filter((h) => h.state === 'ERROR').length;
  const rollup = `${nFrozen} FROZEN / ${nReleased} RELEASED / ${nGone} GONE${nErr ? ` / ${nErr} ERROR` : ''}`;

  const holdsSum = perHold.reduce((s, h) => s + (Number.isFinite(h.originalFiatAmount) ? h.originalFiatAmount : 0), 0);
  const residual = frozen - holdsSum;
  const frozenDeltaRaw = prevFrozen !== null ? frozen - prevFrozen : null;
  // Snap near-zero deltas to exactly 0 — prevFrozen is re-parsed from a
  // toFixed(6) string in the log, so a truly-unchanged reading can otherwise
  // show up as e.g. "-0.000000" after re-subtraction (float round-trip noise).
  const frozenDelta = frozenDeltaRaw !== null && Math.abs(frozenDeltaRaw) <= EPS ? 0 : frozenDeltaRaw;

  const line = [
    timestamp,
    `available=${available}`,
    `total=${total}`,
    `frozen=${frozen.toFixed(6)}`,
    `holdsSum=${holdsSum.toFixed(6)}`,
    `residual=${residual.toFixed(6)}`,
    perHold.map((h) => h.display).join('|'),
    `rollup=${rollup}`,
    `prevFrozen=${prevFrozen !== null ? prevFrozen.toFixed(6) : 'NA'}`,
    `frozenDelta=${frozenDelta !== null ? (frozenDelta >= 0 ? '+' : '') + frozenDelta.toFixed(6) : 'NA'}`,
  ].join('\t');

  // Stamp the format-change marker once, right before the first v2 line.
  if (!prevLine || !prevLine.includes('frozen=')) {
    await appendLog(FORMAT_MARKER);
  }
  await appendLog(line);

  const trend =
    frozenDelta === null
      ? 'no prior extended-format reading to compare yet'
      : Math.abs(frozenDelta) <= EPS
        ? 'unchanged vs previous reading'
        : frozenDelta < 0
          ? `SHRINKING by $${Math.abs(frozenDelta).toFixed(6)} vs previous reading (something is releasing)`
          : `GROWING by $${frozenDelta.toFixed(6)} vs previous reading (more captured since last check)`;

  console.log(
    `[refund_watch] frozen=$${frozen.toFixed(6)} (available=$${available}, total=$${total}) — ${nFrozen}/4 holds STILL-FROZEN [${rollup}] — aggregate ${trend}`
  );

  if (anyHoldErr) {
    console.log(`[refund_watch] WARNING — ${nErr} of 4 hold lookups failed; see log line for HTTP status.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
