import { appendFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// refund_watch — GET-only tracker for ONE question: did the $0.076803 held on
// the errored 128k-token transaction (d59fb015-f55f-4501-a3cb-247b6e091366)
// ever get refunded? See dryrun/hold_linearity_extension.md and the "Case B"
// finding in findings.md for the failure this is watching.
//
// Safe to run repeatedly: only issues GET requests, never spends money.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set. Run with: node --env-file=.env dryrun/refund_watch.js');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const TXN_ID = 'd59fb015-f55f-4501-a3cb-247b6e091366';
const TARGET_COST_ROW_ID = 'ec78f8a8-e02e-4c65-8a20-9c44acd3b6be';
const TARGET_AMOUNT_USD = 0.076803;
const BASELINE_AVAILABLE_USD = 4.432691; // availableBalance right after the experiment that captured the hold
const BASELINE_TOTAL_USD = 4.721228;
const FLOOR_USD = 0.0001; // the settled-cost floor every successful call in the same experiment landed on
const BALANCE_RISE_TOLERANCE_USD = 0.001; // ±$0.001 band around baseline + TARGET_AMOUNT_USD
const LOG_PATH = new URL('./refund_watch.log', import.meta.url);

async function gov(path) {
  return fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
}

async function appendLog(line) {
  await appendFile(LOG_PATH, line + '\n');
}

async function main() {
  const timestamp = new Date().toISOString();

  // 1. GET /v1/accounts — current balances.
  let available = null;
  let total = null;
  let accountsErr = null;
  try {
    const res = await gov('/v1/accounts');
    if (!res.ok) {
      accountsErr = `HTTP ${res.status}`;
    } else {
      const body = await res.json();
      const acct = Array.isArray(body?.data) ? body.data[0] : null;
      available = acct ? parseFloat(acct.availableBalance) : null;
      total = acct ? parseFloat(acct.totalBalance) : null;
    }
  } catch (err) {
    accountsErr = err?.message || String(err);
  }

  // 2. GET the target transaction + its cost rows.
  let activeCost = null;
  let superseded = null;
  let newSupersedingRow = false;
  let txnErr = null;
  try {
    const res = await gov(`/v1/transactions/${TXN_ID}?include=costs`);
    if (!res.ok) {
      txnErr = `HTTP ${res.status}`;
    } else {
      const txn = await res.json();
      const costs = Array.isArray(txn?.costs) ? txn.costs : [];
      const targetRow = costs.find((c) => c.id === TARGET_COST_ROW_ID) ?? null;
      if (targetRow) {
        superseded = targetRow.supersededAt != null || targetRow.isActive === false;
      }
      newSupersedingRow = costs.some((c) => c.supersedesCostId === TARGET_COST_ROW_ID);
      const activeRow = costs.find((c) => c.isActive === true) ?? targetRow;
      activeCost = activeRow ? parseFloat(activeRow.fiatAmount) : null;
    }
  } catch (err) {
    txnErr = err?.message || String(err);
  }

  if (accountsErr || txnErr) {
    const line = `${timestamp}\tERROR\taccounts=${accountsErr ?? 'ok'}\ttxn=${txnErr ?? 'ok'}`;
    await appendLog(line);
    console.log(`[refund_watch] FAILED — ${line}`);
    process.exit(1);
  }

  const balanceRose =
    available !== null &&
    available > BASELINE_AVAILABLE_USD &&
    Math.abs(available - (BASELINE_AVAILABLE_USD + TARGET_AMOUNT_USD)) <= BALANCE_RISE_TOLERANCE_USD;
  const costNearFloor = activeCost !== null && activeCost <= FLOOR_USD + 0.00005;

  const refunded = superseded === true || newSupersedingRow || balanceRose || costNearFloor;
  const verdict = refunded ? 'REFUNDED' : 'STILL-CAPTURED';

  const line = `${timestamp}\tavailable=${available}\ttotal=${total}\tactiveCost=${activeCost}\tsuperseded=${superseded}\tverdict=${verdict}`;
  await appendLog(line);
  console.log(
    `[refund_watch] ${verdict} — availableBalance=$${available}, activeCost=$${activeCost}, targetRowSuperseded=${superseded}, newSupersedingRow=${newSupersedingRow}`
  );
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
