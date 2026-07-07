import { createFetch } from '@sapiom/fetch';
import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Little's Law EMPIRICAL VALIDATION — the float_model.md formula, tested.
//
// float_model.md predicts: instantaneous frozen$ = lambda x W x hold$
// (arrival rate x hold lifetime x hold size). That formula has never been
// tested against the live ledger — only its inputs were measured.
//
// Method: fire N=24 LLM calls at a FIXED 2.5s pace (lambda = 0.4 calls/s),
// max_tokens=16000 (hold $0.0096 — big enough to see in the balance), while
// polling availableBalance every 400ms. Compare:
//   measured  = time-averaged (baseline - available(t)) over the firing window
//   predicted = lambda x W_measured x hold$   (W = mean call wall-time; holds
//               settle synchronously with completion, chaining experiment)
//
// MONEY SAFETY: balance pre-check (abort < $2.75); mid-run floor check in the
// poller; expected settle 24 x $0.0001 = $0.0024; worst case a 502 freezes one
// $0.0096 hold (16k is a verified-safe rung — succeeded in hold_linearity).
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}

const GOV_BASE = 'https://api.sapiom.ai';
const ROUTER_URL = 'https://openrouter.services.sapiom.ai/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOKENS = 16000; // hold = $0.0096 (measured linear rate)
const HOLD_USD = 16 * 0.0006;
const PROMPT = 'In exactly one short sentence, define "float" in payments.';
const AGENT_NAME = 'll-validation-agent';
const N_CALLS = 24;
const INTERVAL_MS = 2500; // lambda = 0.4 calls/s
const POLL_MS = 400;
const BALANCE_FLOOR = 2.75;
const LLM_TIMEOUT_MS = 30000;

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
  // --- baseline: 3 pre-run polls, must agree --------------------------------
  const pre = [];
  for (let i = 0; i < 3; i++) {
    pre.push(await availableBalance());
    await sleep(500);
  }
  const baseline = pre[pre.length - 1];
  console.log(`[ll] baseline availableBalance: $${baseline} (pre-polls: ${pre.join(', ')})`);
  if (!Number.isFinite(baseline) || baseline < BALANCE_FLOOR) {
    console.error(`[ll] ABORT: balance ${baseline} < floor ${BALANCE_FLOOR}`);
    process.exit(1);
  }
  if (Math.max(...pre) - Math.min(...pre) > 1e-9) {
    console.error('[ll] ABORT: balance moving before run starts (other traffic?) — need a quiet account for a clean baseline');
    process.exit(1);
  }

  // --- balance poller --------------------------------------------------------
  const series = [];
  let polling = true;
  let floorTripped = false;
  const poller = (async () => {
    while (polling) {
      const t = Date.now();
      const bal = await availableBalance().catch(() => null);
      if (Number.isFinite(bal)) {
        series.push({ t, available: bal, frozen: +(baseline - bal).toFixed(9) });
        if (bal < BALANCE_FLOOR) {
          floorTripped = true;
          polling = false;
        }
      }
      await sleep(POLL_MS);
    }
  })();

  // --- paced fire ------------------------------------------------------------
  const sapiomFetch = createFetch({ apiKey: API_KEY, agentName: AGENT_NAME });
  const calls = [];
  const inflight = [];
  const fireStart = Date.now();
  for (let i = 1; i <= N_CALLS; i++) {
    if (floorTripped) {
      console.error('[ll] floor tripped mid-run — stopping launches');
      break;
    }
    const rec = { i, startMs: Date.now(), endMs: null, status: null, error: null };
    calls.push(rec);
    inflight.push(
      (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        try {
          const res = await sapiomFetch(ROUTER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS }),
            signal: controller.signal,
          });
          rec.status = res.status;
          await res.text().catch(() => null);
        } catch (err) {
          rec.error = err?.message || String(err);
        } finally {
          clearTimeout(timeout);
          rec.endMs = Date.now();
        }
      })()
    );
    if (i < N_CALLS) await sleep(INTERVAL_MS);
  }
  await Promise.all(inflight);
  const fireEnd = Date.now();
  await sleep(8000); // tail: let last settlements land in the balance
  polling = false;
  await poller;

  // --- compute ---------------------------------------------------------------
  const ok = calls.filter((c) => c.status === 200);
  const failed = calls.filter((c) => c.status !== 200);
  const durations = ok.map((c) => (c.endMs - c.startMs) / 1000);
  const W_wall = durations.reduce((s, d) => s + d, 0) / (durations.length || 1);
  const windowSec = (fireEnd - fireStart) / 1000;
  const lambda = calls.length / windowSec;

  // time-averaged frozen over the firing window only (trapezoid over samples)
  const win = series.filter((s) => s.t >= fireStart && s.t <= fireEnd);
  let area = 0;
  for (let i = 1; i < win.length; i++) {
    area += ((win[i].frozen + win[i - 1].frozen) / 2) * (win[i].t - win[i - 1].t);
  }
  const measuredAvgFrozen = win.length > 1 ? area / (win[win.length - 1].t - win[0].t) : null;
  const peakFrozen = Math.max(...win.map((s) => s.frozen), 0);
  const predicted = lambda * W_wall * HOLD_USD;

  const endBalance = series.length ? series[series.length - 1].available : null;
  const netSpend = endBalance !== null ? +(baseline - endBalance).toFixed(9) : null;

  const result = {
    fetched_at: new Date().toISOString(),
    agent_name: AGENT_NAME,
    n_calls: calls.length,
    n_ok: ok.length,
    n_failed: failed.length,
    failed_detail: failed,
    lambda_calls_per_sec: lambda,
    W_mean_wall_sec: W_wall,
    hold_usd_nominal: HOLD_USD,
    predicted_avg_frozen_usd: predicted,
    measured_avg_frozen_usd: measuredAvgFrozen,
    measured_peak_frozen_usd: peakFrozen,
    ratio_measured_over_predicted: measuredAvgFrozen !== null && predicted > 0 ? measuredAvgFrozen / predicted : null,
    firing_window_sec: windowSec,
    baseline_available_usd: baseline,
    end_available_usd: endBalance,
    net_balance_drop_usd: netSpend,
    n_balance_samples: series.length,
    balance_series: series,
    calls,
    method_note:
      "Little's Law L = lambda x W applied to dollars: predicted avg frozen = (calls/s) x (mean call wall-time as hold-lifetime proxy) x (hold $). Measured = time-averaged (baseline - availableBalance) across the firing window, trapezoidal integration over ~400ms samples. Hold lifetime proxied by wall time because settlement completes synchronously with the call's own response (chaining experiment, RUN_LOG item 5a).",
  };
  await writeFile(new URL('./ll_validation_result.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(
    `[ll] wrote ll_validation_result.json — lambda=${lambda.toFixed(3)}/s W=${W_wall.toFixed(2)}s predicted=$${predicted.toFixed(6)} measured=$${measuredAvgFrozen?.toFixed(6)} ratio=${result.ratio_measured_over_predicted?.toFixed(3)} peak=$${peakFrozen.toFixed(6)} failed=${failed.length}`
  );
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
