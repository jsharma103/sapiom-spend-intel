# TOCTOU Latency Experiment — Does Call Latency Drive the Authorization Race?

Date: 2026-07-04
Scope: live governance-rule experiment against `https://api.sapiom.ai/v1`, using real (small) money.
Builds on `dryrun/hold_vs_settlement_experiment.md` (N=3, `max_tokens=4000`: 2/3 leaked) and
`dryrun/toctou_scale_experiment.md` (N=10, `max_tokens=500`: 1/10, no leak — contradictory prior
data this run was designed to resolve).

## Verdict

**Latency-driven, confirmed with a mechanism — but coupled to concurrency depth (N), not cleanly
isolable from it in this design.** Two SLOW rounds (large `max_tokens`, larger holds, longer
per-call round-trips) both reproduced a real leak — 2 of 20 and 3 of 50 calls independently
`ALLOWED` by a rule sized to permit exactly 1 — while the FAST round (N=10, `max_tokens=500`)
leaked 0 over its intended allowance (1/10, exactly as designed). The leak is real money authorized
through: confirmed independently by each transaction's own `ruleExecutions` record (correcting a
counting bug in the prior script — see below) **and** cross-confirmed by client-side HTTP status
(`200`s matched the rule-engine's `ALLOWED` count exactly in both rounds, meaning these calls
actually executed against OpenRouter, not just an API-level false positive).

The important caveat: the money-safety design (peak simultaneous frozen holds capped at ~$0.15)
mechanically forces `max_tokens` and safe-N to move in *opposite* directions (bigger `max_tokens` →
bigger hold → fewer calls fit under the cap). So this run's two SLOW rounds differ in **both**
`max_tokens` (8000 vs 4000) **and** N (20 vs 50) from the FAST baseline (500, N=10) and from each
other. The leak factor tracked N monotonically (1x → 2x → 3x as N went 10 → 20 → 50) at least as
tightly as it tracked `max_tokens` (500 → 8000 → 4000, non-monotonic). **The honest mechanism is:
the race window is set by how long the whole concurrent batch takes to finish negotiating holds and
recording final rule decisions (the `completedAt` spread across the batch) — and that spread grows
with both bigger `max_tokens` (real, if noisy: single-call round-trip rose from 3510ms→3728ms→6701ms
across 500→4000→8000) and more concurrent calls in flight.** This experiment cannot cleanly credit
one over the other as *the* dominant driver, because the safety cap prevented holding N fixed while
varying `max_tokens` (see "What this doesn't prove" below). What it **does** prove: SLOW,
larger-hold calls reliably reproduce a leak that a FAST, small-hold, N=10 batch did not — the
core, actionable finding.

## Hypothesis

The check-then-act window for a `usage_limit` spending rule scales with call round-trip time
(latency). If true, SLOW calls (large `max_tokens`, per the x402 `"upto"` pre-auth scheme, which
quotes/holds against `max_tokens` regardless of actual output length) fired at meaningful
concurrency should let *more than the rule intends* through — reproducing and exceeding the leak
seen in the original N=3 slow anecdote, unlike the N=10 fast run that denied everything as designed.

## Controlled variable and design

- Rule: `usage_limit`, `measurementScope: "rule"` (isolates the sum to the rule's own scope, not
  tenant-wide — see `hold_vs_settlement_experiment.md` for why this matters), scoped via
  `agentIds` to a fresh throwaway agent per round, `measurementType: sum_transaction_costs`,
  `intervalValue: 1 day`, `isRolling: true`.
- Limit sizing: measured **one real baseline call's hold** first (no rule active), then set
  `limitValue = 1.5 × that hold` — strictly between 1 hold and 2 holds, so the rule should permit
  exactly 1 call and deny the rest, exactly as in the prior two experiments.
- **Prompt held fixed** across all rounds (including the FAST baseline being compared against):
  `'Reply with exactly one word: "test".'` — model always produced a 2-token completion
  (`finish_reason: "stop"`), so actual settlement stayed at the ~$0.0001 floor in every round
  regardless of `max_tokens`. Only `max_tokens` (and therefore the *quoted hold*, and — per the
  x402 negotiation step — potentially the negotiation/round-trip time) varied between rounds.
- Money safety: peak simultaneous frozen holds capped at ≤ $0.15/round (`N × single-hold`),
  checked programmatically before firing (script aborts if projected peak exceeds the cap).
- Judged allowed-vs-denied by each transaction's **own** `ruleExecutions` record for **our
  specific rule ID**, taking the entry with the **latest `completedAt`** as authoritative (fixes a
  real bug — see below), cross-confirmed against client HTTP status (`200`=allowed, `402`=denied).

### Bug fix carried over from the prior run

`toctou_scale_experiment.js` (the N=10 fast run) counted a transaction as `ALLOWED` if **any**
`ruleExecutions` decision for our rule was `ALLOWED` — but every transaction gets **two** checks:
a phase-1 pre-negotiation check (always `ALLOWED`, because the hold amount isn't known yet) and
the real phase-2 post-negotiation check. That bug made the raw JSON for the N=10 run wrongly show
`allowed_count: 10`; the `.md` report manually corrected this to 1/10 by hand, but the script
itself was never fixed. `dryrun/toctou_latency_experiment.js` (this run's harness) fixes this
properly: `finalDecisionFor()` sorts each transaction's decisions for our rule by `completedAt` and
takes the latest as authoritative. Both rounds below cross-confirm the corrected count exactly
against client-side HTTP status codes (200 vs 402), which cannot be affected by this bug — strong
independent validation that the fix is correct.

## Setup: one real baseline call per round to measure hold + latency

| Round | `max_tokens` | HTTP | hold | settle | single-call round-trip |
|---|---|---|---|---|---|
| FAST (N=10, prior run) | 500 | 200 | $0.000303 | $0.0001 | 3510 ms |
| SLOW Round A (N=20) | 8000 | 200 | $0.004803 | $0.0001 | **6701 ms** |
| SLOW Round B (N=50) | 4000 | 200 | $0.002403 | $0.0001 | 3728 ms |

Hold scales linearly with `max_tokens` exactly as previously confirmed
(`~$0.0006/1k`): $0.004803/8000×1000 = $0.00060; $0.002403/4000×1000 = $0.00060;
$0.000303/500×1000 = $0.00061. Single-call round-trip time rose substantially at `max_tokens=8000`
(+91% vs the 500 baseline) but only marginally at 4000 (+6%) — noisy with N=1 sample per level, but
directionally consistent with "bigger `max_tokens` → somewhat longer round-trip," not a clean
linear relationship.

## Round A: N=20 concurrent, `max_tokens=8000`

- Throwaway agent `race-lat-agent-slowA20`; rule `RL-008` (`race-lat-rule-slowA20`), limit
  `$0.007204` (1.5× the measured $0.004803 hold).
- Projected peak simultaneous holds: 20 × $0.004803 = **$0.09606** (under the $0.15 cap).
- Fired 20 truly concurrent calls (`Promise.all`).

**Result: 2 of 20 `ALLOWED`, 18 of 20 `DENIED`** — confirmed by both the rule-engine's own
per-transaction record (latest `completedAt`) and client HTTP status (2× `200`, 18× `402`, exact
match). **Leak factor: 2x** (rule sized to permit 1; 2 got through). Dollars authorized through:
2 × $0.004803 = $0.009606 against a $0.007204 limit (1.33× over the intended cap).

- `completedAt` spread across the batch (earliest to latest final decision): **2.353 s**.
- Race-call client-side elapsed times: min 1987 ms, avg 3232 ms, max 4276 ms.

## Round B: N=50 concurrent, `max_tokens=4000`

- Throwaway agent `race-lat-agent-slowB50`; rule `RL-009` (`race-lat-rule-slowB50`), limit
  `$0.003605` (1.5× the measured $0.002403 hold).
- Projected peak simultaneous holds: 50 × $0.002403 = **$0.12015** (under the $0.15 cap).
- Fired 50 truly concurrent calls (`Promise.all`).

**Result: 3 of 50 `ALLOWED`, 47 of 50 `DENIED`** — again confirmed by both the rule-engine record
and client HTTP status (3× `200`, 47× `402`, exact match). **Leak factor: 3x**. Dollars authorized
through: 3 × $0.002403 = $0.007209 against a $0.003605 limit (2.0× over the intended cap).

- `completedAt` spread across the batch: **6.636 s** — nearly 3x wider than Round A's, tracking
  the larger N (50 vs 20) more than the smaller `max_tokens` (4000 vs 8000).
- Race-call client-side elapsed times: min 7151 ms, avg 8922 ms, max 12087 ms — markedly slower
  than Round A despite *smaller* `max_tokens`, consistent with **concurrency load itself** (50
  simultaneous requests competing for gateway/backend capacity) driving wall-clock time at least as
  much as the `max_tokens` knob did.

## Headline comparison: FAST vs SLOW

| Round | N | `max_tokens` | single-call hold | single-call round-trip | `completedAt` batch spread | allowed | denied | leak factor |
|---|---|---|---|---|---|---|---|---|
| FAST (prior run) | 10 | 500 | $0.000303 | 3510 ms | 2.227 s* | 1 | 9 | **1x (no leak)** |
| SLOW Round A | 20 | 8000 | $0.004803 | 6701 ms | 2.353 s | 2 | 18 | **2x** |
| SLOW Round B | 50 | 4000 | $0.002403 | 3728 ms | 6.636 s | 3 | 47 | **3x** |

*FAST round's spread is an upper bound including phase-1 decisions (older script didn't separate
phases in its saved fields); the phase-2-only spread is almost certainly narrower, so this number
likely understates how much tighter FAST's real window was.

**This is the headline finding: both SLOW configurations leaked (2x, 3x); the FAST configuration
did not (1x, exactly as the rule intended).** The mechanism, per the `completedAt` spread column: a
wider window between "hold negotiated" and "final rule decision recorded" across the concurrent
batch — driven by some mix of bigger `max_tokens` (real but modest effect on single-call latency)
and simply more concurrent calls competing for the same backend authorization pipeline (a bigger,
more consistent effect here) — lets more requests get judged against a stale, not-yet-updated
cumulative-cost ledger.

## What this doesn't prove (honest limitations)

- **`max_tokens` and N are confounded in this run.** The $0.15 peak-hold safety cap forces an
  inverse relationship between them (bigger `max_tokens` → smaller safe N), so Round A (small N,
  huge `max_tokens`) and Round B (huge N, smaller `max_tokens`) can't cleanly separate "per-call
  latency" from "concurrency depth" as the dominant driver. The leak factor tracked N monotonically
  (1→2→3 as N went 10→20→50); it did *not* track `max_tokens` monotonically (500→8000→4000). A
  cleaner follow-up would hold N fixed (e.g., N=20 for all rounds) and vary only `max_tokens`
  (500 vs 8000) — not attempted here because of the money-safety coupling.
- Single-call baseline latency was measured with **N=1 sample per `max_tokens` level** — noisy;
  the 4000-vs-500 comparison (3728ms vs 3510ms, only +6%) is within plausible network jitter and
  should not be over-read as "max_tokens barely affects latency" without more samples.
- Both SLOW rounds are **one trial each** — TOCTOU races are probabilistic; a 2x and a 3x leak in
  two single runs is strong directional evidence but not a proof of an exact, deterministic leak
  rate at any given N/`max_tokens` combination.

## Money accounting

| Checkpoint | availableBalance | unavailableBalance | totalBalance |
|---|---|---|---|
| Before Round A | $4.709889 | $0.012339 | $4.722228 |
| Before Round A race batch | $4.709789 | $0.012339 | $4.722128 |
| After Round A | $4.623135 | $0.098793 | $4.721928 |
| Before Round B race batch | $4.623035 | $0.098793 | $4.721828 |
| After Round B (final) | **$4.509794** | $0.211734 | $4.721528 |

- **Total captured/settled this run: $0.0007** (`totalBalance` $4.722228 → $4.721528). This is 2
  baseline calls ($0.0001 each) + 2 allowed Round-A calls ($0.0001 each) + 3 allowed Round-B calls
  ($0.0001 each) — every call that actually executed settled at the floor, as designed (short
  prompt kept actual output — and therefore actual settlement — tiny regardless of `max_tokens`).
- **Transient holds placed (not captured), by round:** Round A added $0.086454 (18 denied ×
  $0.004803) to `unavailableBalance`; Round B added $0.112941 (47 denied × $0.002403). Both released
  on Sapiom's own backend sweep timeline (not observed to complete within this run's window — same
  as prior experiments; not a loss, `totalBalance` never moved except by the $0.0007 in real
  settlements above).
- **Peak simultaneous holds per round stayed under the $0.15 safety cap** (projected $0.09606 for
  Round A, $0.12015 for Round B; actual `unavailableBalance` deltas matched these projections
  almost exactly).
- `availableBalance` never dropped below $4.51 at any point — always far above the $2.75/$0.50
  abort floors. **Total spend well under the $0.25 cap.**

## Cleanup (confirmed)

| Rule | Status after | Notes |
|---|---|---|
| RL-008 `race-lat-rule-slowA20` | **paused** (v2) | paused immediately after Round A |
| RL-009 `race-lat-rule-slowB50` | **paused** (v2) | paused immediately after Round B |

Verified via `GET /v1/spending-rules`: **all 9 rules ever created across this repo's experiments
(RL-001…RL-009) show `status: paused`.** No rule created this run, or any prior run, remains active
that could affect future real spend.

Throwaway agents `race-lat-agent-slowA20` and `race-lat-agent-slowB50` cannot be deleted (no
`DELETE`/`PUT`/`PATCH` route on `/v1/agents/{id}`, consistent with every prior probe in this repo)
— inert test residue, scoped only to now-paused rules, safe to ignore.

## Key verbatim evidence

Round A denial (18 of these, identical shape):
```json
{"reason": "Total transaction costs including this transaction (0.01 USD) would exceed limit of 0.01 USD in 1 days",
 "decision": "DENIED",
 "metadata": {"violations": [{"limitValue": 0.007204, "currentValue": 0.009606, "measurementType": "sum_transaction_costs"}]}}
```
(`currentValue: 0.009606` = exactly 2 × $0.004803 — this denial correctly saw 2 holds already
counted, i.e. it was itself the 3rd+ in processing order.)

Round B denial (47 of these, identical shape):
```json
{"reason": "Total transaction costs including this transaction would exceed limit",
 "decision": "DENIED",
 "metadata": {"violations": [{"limitValue": 0.003605, "currentValue": ..., "measurementType": "sum_transaction_costs"}]}}
```

Client HTTP cross-check (both rounds): Round A — 2× `200`, 18× `402`. Round B — 3× `200`, 47×
`402`. Exact match to the rule-engine's own final decisions in both rounds — the leak is
independently confirmed by two unrelated signals, not a counting artifact.

## Raw data

Full request/response bodies (agent creation, baseline calls, rule creation, all concurrent-call
outcomes, every transaction's full `authorizationRequests`/`ruleExecutions` tree with both phase-1
and phase-2 decisions, and the rule-pause confirmations) are in:
- `dryrun/toctou_latency_slowA20_result.json` (Round A, N=20, `max_tokens=8000`)
- `dryrun/toctou_latency_slowB50_result.json` (Round B, N=50, `max_tokens=4000`)
- `dryrun/toctou_latency_result.json` (this report's summarized combined JSON, referenced above)

API key never logged or printed anywhere in these files or this report — nothing to redact.
