import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// R3 — idempotency replay: replay the same request twice — charged once or
// double?
//
// Method: monkey-patch globalThis.fetch BEFORE importing @sapiom/fetch so we
// capture every request the SDK makes (incl. X-Idempotency-Key on its POSTs).
// Fire ONE tiny LLM call (max_tokens=100 -> hold ~$0.00006, settle $0.0001
// floor). Then replay the captured payment-layer POST byte-for-byte (same
// idempotency key, same body) via raw fetch. Compare returned transaction ids
// and, after settling, count ledger txns + cost rows for the test agent.
//
// Fallback (if the SDK doesn't route through globalThis.fetch and we capture
// nothing): POST /v1/transactions twice ourselves with an identical
// X-Idempotency-Key and compare ids — still a valid test of the API's
// idempotency layer.
//
// MONEY SAFETY: balance pre-check (abort < $2.75). Worst case: dedupe fails
// AND the replay executes a second paid call -> 2 x ~$0.0001.
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 100;
const PROMPT = 'Reply with the single word: idempotent';
const AGENT_NAME = 'r3-idem-agent';
const BALANCE_FLOOR = 2.75;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- capture layer, installed before the SDK loads -------------------------
const captured = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const isReq = typeof Request !== 'undefined' && input instanceof Request;
  const url = isReq ? input.url : String(input);
  const method = (init?.method || (isReq ? input.method : 'GET')).toUpperCase();
  const headers = {};
  try {
    new Headers(init?.headers || (isReq ? input.headers : {})).forEach((v, k) => (headers[k] = v));
  } catch {}
  let body = init?.body;
  if (body != null && typeof body !== 'string') body = '[non-string body]';
  const entry = { url, method, headers, body, ts: Date.now(), status: null, responseBody: null };
  captured.push(entry);
  const res = await realFetch(input, init);
  entry.status = res.status;
  if (url.includes('api.sapiom.ai') && method !== 'GET') {
    try {
      entry.responseBody = await res.clone().json();
    } catch {}
  }
  return res;
};

const { createFetch } = await import('@sapiom/fetch');

async function gov(path, opts = {}) {
  const res = await realFetch(`${GOV_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'curl/8.6.0',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function availableBalance() {
  const { body } = await gov('/v1/accounts');
  return parseFloat((body?.data || [])[0]?.availableBalance);
}

async function agentTxns() {
  const { body } = await gov('/v1/transactions?page[limit]=100&sort=-created_at');
  return (body?.data || body?.transactions || []).filter(
    (t) => (t.agent?.name || t.agentName) === AGENT_NAME
  );
}

async function main() {
  const bal0 = await availableBalance();
  console.log(`[r3] availableBalance pre-run: $${bal0}`);
  if (!Number.isFinite(bal0) || bal0 < BALANCE_FLOOR) {
    console.error(`[r3] ABORT: balance ${bal0} < floor ${BALANCE_FLOOR}`);
    process.exit(1);
  }

  // --- 1. one tiny paid call via SDK, capturing its wire traffic -----------
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const res = await sapiomFetch(ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS }),
  });
  console.log(`[r3] original call HTTP ${res.status}`);
  await res.text().catch(() => null);
  await sleep(6000);

  const txnsAfterOriginal = await agentTxns();
  console.log(`[r3] ledger txns for agent after original call: ${txnsAfterOriginal.length}`);

  // --- 2. find captured SDK POSTs carrying an idempotency key --------------
  const sdkPosts = captured.filter(
    (e) =>
      e.url.includes('api.sapiom.ai') &&
      e.method === 'POST' &&
      Object.keys(e.headers).some((k) => k.toLowerCase() === 'x-idempotency-key')
  );
  console.log(`[r3] captured ${captured.length} requests total; ${sdkPosts.length} SDK POSTs with X-Idempotency-Key`);

  let replayMode = null;
  const replays = [];

  if (sdkPosts.length > 0) {
    // --- 3a. true replay of the SDK's own payment POST ---------------------
    replayMode = 'sdk-capture-replay';
    for (const post of sdkPosts) {
      const r = await realFetch(post.url, { method: 'POST', headers: post.headers, body: post.body });
      const rb = await r.json().catch(() => r.text().catch(() => null));
      replays.push({
        url: post.url,
        idempotency_key: post.headers['x-idempotency-key'] || post.headers['X-Idempotency-Key'],
        original_status: post.status,
        original_txn_id: post.responseBody?.id ?? post.responseBody?.data?.id ?? null,
        replay_status: r.status,
        replay_txn_id: rb?.id ?? rb?.data?.id ?? null,
        replay_body_excerpt: JSON.stringify(rb)?.slice(0, 500),
      });
      console.log(`[r3] replayed ${post.url} -> HTTP ${r.status}`);
    }
  } else {
    // --- 3b. fallback: manual double-POST /v1/transactions -----------------
    replayMode = 'manual-double-post';
    const key = crypto.randomUUID();
    const txnBody = JSON.stringify({
      serviceName: 'openrouter',
      agentName: AGENT_NAME,
      metadata: { r3: 'idempotency-fallback-probe' },
    });
    for (let i = 1; i <= 2; i++) {
      const r = await gov('/v1/transactions', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': key },
        body: txnBody,
      });
      replays.push({ attempt: i, idempotency_key: key, status: r.status, txn_id: r.body?.id ?? r.body?.data?.id ?? null, body_excerpt: JSON.stringify(r.body)?.slice(0, 500) });
      console.log(`[r3] manual POST ${i} -> HTTP ${r.status} id=${replays[i - 1].txn_id}`);
      await sleep(1500);
    }
  }

  await sleep(6000);

  // --- 4. ledger truth: how many txns / cost rows / dollars? ---------------
  const txnsFinal = await agentTxns();
  const perTxn = txnsFinal.map((t) => ({
    id: t.id,
    createdAt: t.createdAt,
    status: t.status,
    outcome: t.outcome,
    n_cost_rows: (t.costs || []).length,
    live_usd: (t.costs || []).filter((c) => c.isActive).reduce((s, c) => s + parseFloat(c.fiatAmount || 0), 0),
  }));
  const totalCharged = perTxn.reduce((s, t) => s + t.live_usd, 0);

  const dedupe =
    replayMode === 'sdk-capture-replay'
      ? replays.every((r) => r.original_txn_id && r.original_txn_id === r.replay_txn_id)
      : replays.length === 2 && replays[0].txn_id && replays[0].txn_id === replays[1].txn_id;

  const result = {
    fetched_at: new Date().toISOString(),
    agent_name: AGENT_NAME,
    replay_mode: replayMode,
    replays,
    ledger_txns: perTxn,
    n_ledger_txns: perTxn.length,
    total_live_charged_usd: totalCharged,
    dedupe_verdict: dedupe ? 'DEDUPED — same txn id on replay' : 'NOT DEDUPED — replay produced a different/new result',
    captured_request_log: captured.map(({ url, method, status }) => ({ url, method, status })),
  };
  await writeFile(new URL('./r3_idempotency_result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(`[r3] wrote r3_idempotency_result.json — mode=${replayMode} verdict=${result.dedupe_verdict} txns=${perTxn.length} charged=$${totalCharged.toFixed(6)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
