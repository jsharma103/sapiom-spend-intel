import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Ladder replicate WITH response-body capture — fills the actual-tokens column
// the original ladder scripts discarded. Same model + prompt as
// hold_linearity_extension; rungs 100 -> 64k (NO 128k — each attempt freezes
// $0.0768 with no release path, see experiments/01 §4).
// Captures per rung: full usage block, OpenRouter generation id, upstream
// cost, then the ledger's hold/settle rows for the same txn.
// MONEY SAFETY: balance pre-check (abort < $2.75); expected settle 7 x
// $0.0001 = $0.0007; largest transient hold $0.0384 (64k, verified-safe rung).
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) { console.error('SAPIOM_API_KEY not set'); process.exit(1); }

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const PROMPT = 'In exactly two sentences, explain what double-entry bookkeeping is.';
const AGENT_NAME = 'ladder-usage-replicate';
const RUNGS = [100, 400, 900, 2000, 8000, 16000, 64000];
const BALANCE_FLOOR = 2.75;
const GAP_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
  return res.json().catch(() => null);
}

async function availableBalance() {
  const body = await gov('/v1/accounts');
  return parseFloat((body?.data || [])[0]?.availableBalance);
}

async function main() {
  const bal0 = await availableBalance();
  console.log(`[ladder-usage] availableBalance pre-run: $${bal0}`);
  if (!Number.isFinite(bal0) || bal0 < BALANCE_FLOOR) {
    console.error(`[ladder-usage] ABORT: ${bal0} < ${BALANCE_FLOOR}`);
    process.exit(1);
  }

  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const rows = [];
  for (const cap of RUNGS) {
    let status = null, body = null, err = null, headers = null;
    try {
      const res = await sapiomFetch(ROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: cap }),
      });
      status = res.status;
      headers = Object.fromEntries(res.headers.entries());
      body = await res.json().catch(() => null);
    } catch (e) { err = e?.message || String(e); }
    const u = body?.usage || {};
    console.log(`[ladder-usage] cap=${cap} HTTP ${status} prompt=${u.prompt_tokens} completion=${u.completion_tokens} upstream=$${u.cost}`);
    rows.push({
      max_tokens: cap, http_status: status, error: err,
      generation_id: body?.id ?? null, model_echoed: body?.model ?? null,
      prompt_tokens: u.prompt_tokens ?? null, completion_tokens: u.completion_tokens ?? null,
      total_tokens: u.total_tokens ?? null, upstream_cost_usd: u.cost ?? null,
      finish_reason: body?.choices?.[0]?.finish_reason ?? null,
      response_chars: body?.choices?.[0]?.message?.content?.length ?? null,
      response_headers: headers,
      raw_response_body: body,
    });
    await sleep(GAP_MS);
  }

  // ledger truth for the same calls
  await sleep(6000);
  const tx = await gov('/v1/transactions?page[limit]=30&sort=-created_at');
  const mine = (tx?.data || []).filter((t) => (t.agent?.name || t.agentName) === AGENT_NAME);
  const ledger = mine.map((t) => {
    const costs = t.costs || [];
    const hold = costs.find((c) => c.supersededAt);
    const settle = costs.find((c) => c.isActive);
    return {
      txn_id: t.id, createdAt: t.createdAt, outcome: t.outcome,
      hold_usd: hold ? parseFloat(hold.fiatAmount) : null,
      settle_usd: settle ? parseFloat(settle.fiatAmount) : null,
      n_cost_rows: costs.length,
    };
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const result = { fetched_at: new Date().toISOString(), agent_name: AGENT_NAME, model: MODEL, prompt: PROMPT, rows, ledger };
  await writeFile(new URL('./ladder_usage_result.json', import.meta.url), JSON.stringify(result, null, 2));
  const balEnd = await availableBalance();
  console.log(`[ladder-usage] wrote ladder_usage_result.json — ${rows.length} rungs, ${ledger.length} ledger txns, balance $${bal0} -> $${balEnd}`);
}

main().catch((e) => { console.error('Fatal:', e?.stack || e); process.exit(1); });
