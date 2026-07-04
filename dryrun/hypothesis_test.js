import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Hypothesis: Sapiom cost records form estimate -> actual supersession chains
// on variable-priced (LLM) calls. This script fires one LLM call while
// polling /v1/transactions to see whether an "isEstimate" cost row appears
// first and is later superseded by an actual cost row (supersedesCostId /
// supersededAt).
//
// The exact response schema for /v1/accounts and /v1/transactions is not
// documented, so all field access below is defensive (multiple candidate
// key names are tried) and the full raw payloads are always written to
// hypothesis_result.json for manual inspection.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY environment variable is not set. Run: export SAPIOM_API_KEY=...');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_MS = 30000; // hard cap on total polling time
const POST_LLM_SETTLE_MS = 5000; // keep polling this long after the LLM call resolves
const LLM_TIMEOUT_MS = 35000; // safety valve so a hung LLM call can't blow the runtime budget

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Plain fetch GET against the Sapiom governance/accounting API.
async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`gov ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Defensive payload helpers (schema is unknown / exploratory) -----------

function firstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidateKeys = ['transactions', 'accounts', 'data', 'items', 'results', 'records'];
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

function shortId(id) {
  if (id === undefined || id === null) return 'null';
  const s = String(id);
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

// A "transaction" list item may itself be a cost row, or it may wrap a
// nested array of cost rows (estimate + actual). Handle both shapes.
function getCostRows(item) {
  const nested = pick(item, ['costs', 'costRows', 'cost_rows']);
  if (Array.isArray(nested)) return nested;
  return item ? [item] : [];
}

function txnId(item) {
  return pick(item, ['transactionId', 'transaction_id', 'id', 'txnId']);
}

function costId(row) {
  return pick(row, ['costId', 'cost_id', 'id']);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching accounts (before)...');
  const accountsBefore = await gov('/v1/accounts');

  const pollSnapshots = [];
  let llmDone = false;
  let llmDoneAt = null;
  const pollStart = Date.now();

  async function poller() {
    while (Date.now() - pollStart < MAX_POLL_MS) {
      if (llmDone && Date.now() - llmDoneAt >= POST_LLM_SETTLE_MS) break;
      try {
        const snapshot = await gov('/v1/transactions');
        pollSnapshots.push({
          t_ms: Date.now() - pollStart,
          timestamp: new Date().toISOString(),
          data: snapshot,
        });
      } catch (err) {
        console.error(`Poll error at t=${Date.now() - pollStart}ms:`, err?.message || err);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: 'estimate-test' });

  async function runLlmCall() {
    console.log('Firing LLM call via @sapiom/fetch...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await sapiomFetch('https://openrouter.services.sapiom.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [
            { role: 'user', content: 'Write a detailed 600-word essay on the history of double-entry bookkeeping.' },
          ],
          max_tokens: 900,
        }),
        signal: controller.signal,
      });
      console.log(`LLM call HTTP status: ${response.status}`);
      try {
        await response.json();
      } catch (err) {
        console.error('Failed to parse LLM response body:', err?.message || err);
      }
    } catch (err) {
      console.error('LLM call failed:', err?.message || err);
    } finally {
      clearTimeout(timeout);
      llmDone = true;
      llmDoneAt = Date.now();
      console.log('LLM call finished; will keep polling for another 5s to catch settlement.');
    }
  }

  await Promise.all([poller(), runLlmCall()]);

  console.log('Fetching final transactions and accounts (after)...');
  const finalTransactions = await gov('/v1/transactions');
  const accountsAfter = await gov('/v1/accounts');

  const result = {
    accounts_before: accountsBefore,
    accounts_after: accountsAfter,
    poll_snapshots: pollSnapshots,
    final_transactions: finalTransactions,
  };

  const outPath = new URL('./hypothesis_result.json', import.meta.url);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${outPath.pathname}`);

  printSummary(result);
}

function printSummary(result) {
  console.log('\n=== HYPOTHESIS TEST SUMMARY ===');

  const finalList = firstArray(result.final_transactions);
  if (finalList.length === 0) {
    console.log('No transactions found in final_transactions payload -- inspect hypothesis_result.json');
  } else {
    // Assume the API returns newest-first; if that assumption is wrong,
    // hypothesis_result.json still has everything needed to re-check by hand.
    const newest = finalList[0];
    const targetId = txnId(newest);
    console.log(`Newest transaction id: ${shortId(targetId)}`);

    const costRows = getCostRows(newest);
    console.log(`\nCost rows for newest transaction (${costRows.length}):`);
    for (const row of costRows) {
      const cId = shortId(costId(row));
      const fiatAmount = pick(row, ['fiatAmount', 'fiat_amount']);
      const isEstimate = pick(row, ['isEstimate', 'is_estimate']);
      const supersedes = pick(row, ['supersedesCostId', 'supersedes_cost_id']);
      const supersededAt = pick(row, ['supersededAt', 'superseded_at']);
      console.log(
        `  cost_id=${cId} fiatAmount=${fiatAmount ?? 'null'} isEstimate=${isEstimate ?? 'null'} ` +
          `supersedesCostId=${supersedes ? shortId(supersedes) : 'null'} supersededAt=${supersededAt ?? 'null'}`
      );
    }

    // Distinct cost rows seen across ALL poll snapshots for this transaction.
    const seenCostIds = new Set();
    for (const snap of result.poll_snapshots) {
      const list = firstArray(snap.data);
      for (const item of list) {
        const itemTxnId = txnId(item);
        if (targetId !== undefined && itemTxnId !== undefined && itemTxnId !== targetId) continue;
        for (const row of getCostRows(item)) {
          const cid = costId(row);
          if (cid !== undefined) seenCostIds.add(String(cid));
        }
      }
    }
    console.log(
      `\nDistinct cost rows seen across all ${result.poll_snapshots.length} poll snapshots for this transaction: ${seenCostIds.size}`
    );
    if (seenCostIds.size > 1) {
      console.log('  -> Multiple cost rows observed; an estimate row likely appeared mid-flight and was superseded.');
    } else {
      console.log('  -> Only one distinct cost row observed; no visible estimate->actual transition during polling window.');
    }
  }

  console.log('\nAccounts before/after (best-effort balance fields):');
  const balanceKeys = ['balance', 'balanceFiat', 'balance_fiat', 'availableBalance', 'available_balance'];
  const beforeAccounts = firstArray(result.accounts_before);
  const afterAccounts = firstArray(result.accounts_after);
  const beforeBalance =
    pick(result.accounts_before, balanceKeys) ?? (beforeAccounts.length ? pick(beforeAccounts[0], balanceKeys) : undefined);
  const afterBalance =
    pick(result.accounts_after, balanceKeys) ?? (afterAccounts.length ? pick(afterAccounts[0], balanceKeys) : undefined);

  if (beforeBalance !== undefined || afterBalance !== undefined) {
    console.log(`  before: ${JSON.stringify(beforeBalance)}`);
    console.log(`  after:  ${JSON.stringify(afterBalance)}`);
  } else {
    console.log('  No obvious top-level balance field found -- inspect hypothesis_result.json');
  }

  console.log('\nFull details written to hypothesis_result.json');
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
