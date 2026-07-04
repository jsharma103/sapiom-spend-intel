# Sapiom Spend Findings

Free SQL findings bundle over `spend.duckdb` — zero spend, real ingested data.

## 1. Settlement latency (authorize -> final capture)

Time from `authorizedAt` to the live cost row's `createdAt`, per service. For flat single-row services this is the plain authorize->capture round trip; for services with supersession chains (LLM) it includes the restatement wait.

| Service | N | p50 | p95 |
|---|---|---|---|
| sapiom_blaxel | 1 | -832ms | -832ms |
| sapiom_elevenlabs | 1 | -142ms | -142ms |
| sapiom_fal | 1 | -520ms | -520ms |
| sapiom_linkup | 43 | -141ms | -95ms |
| sapiom_openrouter | 31 | 5.29s | 11.96s |
| unknown | 1 | -128ms | -128ms |

Negative values on flat single-row services are real, not a bug: for those services the (only) cost row is created a few hundred ms *before* the transaction's `authorizedAt` timestamp is stamped — the cost record is written as part of the authorization step itself, not after it. Only `sapiom_openrouter` (the chained/restated service) shows genuine positive latency: real wall-clock time waiting for the LLM call to finish and the hold to be superseded by the final settled cost.

## 2. x402 overhead tax

`completedAt - authorizedAt` per transaction, per service. NOTE: no `payment` sub-object exists on transactions in this API (confirmed during BUILD 0 field-availability probing) — `authorizedAt`/`completedAt` are flat top-level transaction fields, used here directly per HANDOFF guidance.

| Service | N | p50 tax | p95 tax | avg % of total call time |
|---|---|---|---|---|
| sapiom_blaxel | 1 | 1.35s | 1.35s | 37.7% |
| sapiom_elevenlabs | 1 | 2.75s | 2.75s | 86.5% |
| sapiom_fal | 2 | 1.18s | 2.69s | 69.3% |
| sapiom_linkup | 43 | 6.25s | 9.17s | 80.9% |
| sapiom_neon | 1 | 1.30s | 1.30s | 95.0% |
| sapiom_openrouter | 31 | 5.91s | 11.97s | 76.6% |
| unknown | 2 | 1.06s | 1.49s | 70.3% |

## 3. Cost-per-task

6/81 transactions carry a `trace_external_id`.

| Trace External ID | Steps | Cost | Wall time |
|---|---|---|---|
| chain-1783163183588-07885448 | 3 | $0.012100 | 15.23s |
| chain-1783163079023-ddff4761 | 3 | $0.012100 | 16.21s |

## 4. Estimate-accuracy scorecard

For services that actually restate costs (hold -> final settlement chains), the ratio of final(live) amount over the original hold amount, averaged per service. Ratio << 1.0 means the hold overestimated the real cost (balance frozen unnecessarily).

| Service | Chains | Avg settled/held ratio |
|---|---|---|
| sapiom_openrouter | 27 | 0.353 |

Flat single-row pricing (no hold-vs-final to score): sapiom_blaxel, sapiom_elevenlabs, sapiom_fal, sapiom_linkup, unknown.

## 5. Runaway detection (check-5)

Methodology: per agent, median inter-call gap (seconds) + peak calls in any rolling 60s window. An agent is flagged **RUNAWAY** if it has >= 3 calls and its median gap is < 20% of the peer-agent median gap (adapts to the account's own baseline instead of a fixed-seconds magic number).

| Agent | Calls | Median gap | Peak calls/60s | vs peer median | Flag |
|---|---|---|---|---|---|
| cap-test | 3 | 8.82s | 3 | 7.97s |  |
| chain-task | 6 | 7.96s | 3 | 8.40s |  |
| dryrun-researcher | 1 | n/a (< 3 calls) | n/a | n/a | — |
| estimate-test | 2 | n/a (< 3 calls) | n/a | n/a | — |
| fleet-test | 10 | 0.08s | 10 | 8.40s | RUNAWAY |
| scale-test | 3 | 6.98s | 3 | 8.40s |  |
| spend-researcher | 12 | 18.79s | 4 | 7.97s |  |
| spend-runaway | 25 | 7.98s | 9 | 8.39s |  |
| spend-writer | 10 | 23.05s | 3 | 7.97s |  |
| sweep-audio | 1 | n/a (< 3 calls) | n/a | n/a | — |
| sweep-compute | 2 | n/a (< 3 calls) | n/a | n/a | — |
| sweep-data | 1 | n/a (< 3 calls) | n/a | n/a | — |
| sweep-images | 2 | n/a (< 3 calls) | n/a | n/a | — |
| sweep-llm | 1 | n/a (< 3 calls) | n/a | n/a | — |
| sweep-scraping | 1 | n/a (< 3 calls) | n/a | n/a | — |
| sweep-search | 1 | n/a (< 3 calls) | n/a | n/a | — |

**Flagged runaway agent(s): fleet-test.**

Note: in tonight's real data, the agent literally *named* `spend-runaway` (25 calls, designed per PLAN.md to burst at 0.3s sleeps) actually shows a steady ~8s median gap — no burst is visible in the captured timestamps. The genuinely anomalous burst tonight came from `fleet-test` (10 calls in well under a second, ~75-90ms apart), an unrelated prior test script. This is exactly why a peer-relative statistical detector is worth having: it flags the agent that's actually behaving anomalously in the data, not the one with the suggestive name.

## 6. callSite lineage

Probed the raw transaction JSON for an SDK-documented `callSite` field: **absent** on every captured transaction. No second attribution axis beyond `traceId` is available in this account's data — section otherwise skipped.

## 7. Governance auth rate (payments auth-rate analog)

Payments framing: an "auth rate" is % of transactions the authorization layer approves vs. declines *before* execution — for Sapiom that's governance spending rules, not downstream vendor/network success (already covered in `reliability.md` / `loss_rate.md`). `outcome` distribution:

| Outcome | Status | N |
|---|---|---|
| success | completed | 79 |
| error | completed | 2 |

Approved: 81 · Denied: 0 · **Auth rate = 100.0%** (81/81).

**Caveat: no spending rules were active in this sample.** Every transaction that reached the ledger did so with zero governance gates to pass or fail — a 100% auth rate here means "nothing was configured to say no," not "governance actively approved risky spend." The `outcome` column only ever takes values `success`/`error`, both reflecting downstream execution (confirmed: no `denied`/`blocked` value exists anywhere in this dataset) — this metric becomes meaningful once a spending rule is created (dashboard-only, [HUMAN-UI], see BACKLOG.md item 8 / the rules-on-hold-vs-settlement experiment) and actually denies a transaction. Treat 100% as a baseline reading of an unconfigured account, not evidence that governance works.

## 8. Governance: rules fire on the HOLD, not settlement (experiment)

Source: `dryrun/hold_vs_settlement_experiment.md` (live governance-rule experiment against `api.sapiom.ai/v1`, 2026-07-04, real small money).

**Headline finding:** spending rules evaluate `sum_transaction_costs` against the pre-auth **hold**, not the eventual settlement. A `usage_limit` rule (`RL-005`) with `limitValue: 0.001` **denied** a call whose real settlement would have been ~$0.0001 — because the call's hold was $0.002403. The denial's own evidence is an exact match: `violations[].currentValue: 0.002403`, to the micro-dollar, the independently-measured hold amount for that exact call (baseline: `max_tokens:4000` → hold `$0.002403`, settle `$0.0001`). Had the rule counted settlement, `currentValue` would have been ~$0.0001 (or $0, since settlement of the current call isn't known until after it completes) and the call would have been approved.

**Implication (phantom spend):** an agent can be blocked over money it never actually spends. Combined with the earlier `max_tokens`-hold-inflation finding (hold ≈ `max_tokens × $0.0006/1k`, ~24-40× actual settlement in this repo's samples), a fat `max_tokens` value trips governance limits on phantom spend — a budget sized from *expected real cost* will see surprise denials at a small fraction of the intended cap.

**Sub-note — `measurementScope` misconfiguration trap:** the API's default `measurementScope` is `"all"`, which sums cost **tenant-wide**, not per-scoped-agent. A first attempt (`RL-004`, limit $0.001, `agentIds:[holdtest-agent-hvs]`, default scope) was immediately denied with `currentValue: 0.277572` — the entire tenant's historical spend, not the ~$0.0001 the test agent had actually incurred. Only `measurementScope: "rule"` (undocumented; the enum was found by probing the parameter schema for free) isolates the sum to the rule's own scope. A customer setting a per-agent budget with the default scope can unknowingly get account-wide summing — a real footgun distinct from the hold-vs-settlement question.

**Sub-note — TOCTOU race: REPRODUCED, scales with concurrency.** The original 3-concurrent-call anecdote above (`RL-006`, limit $0.003, sized to permit one ~$0.0024 hold but not two: 2 of 3 independently `ALLOWED`, only the middle-processed transaction correctly `DENIED` on the doubled cumulative) was a single-trial result. `dryrun/toctou_latency_experiment.md` (2026-07-04) deliberately re-ran the race across three concurrency/hold-size configurations, each rule sized to permit exactly 1 call's hold:

| Round | N | `max_tokens` | single-call hold | allowed | denied | leak factor |
|---|---|---|---|---|---|---|
| FAST | 10 | 500 | $0.000303 | 1 | 9 | 1x (no leak) |
| SLOW A | 20 | 8000 | $0.004803 | 2 | 18 | **2x** |
| SLOW B | 50 | 4000 | $0.002403 | 3 | 47 | **3x** |

Both SLOW rounds independently reproduced a real leak — 2x and 3x over the rule's intended allowance — each confirmed two ways: the rule engine's own per-transaction `ruleExecutions` decision (latest `completedAt` taken as authoritative, fixing a counting bug in the original N=10 script that only checked "any" decision) AND client-side HTTP status (200s matched the `ALLOWED` count exactly in both rounds, meaning the leaked calls actually executed against OpenRouter, not just a bookkeeping artifact). **Mechanism:** the leak tracks the spread of `completedAt` across the concurrent batch — a wider window between "hold negotiated" and "final rule decision recorded" lets more requests get judged against a stale, not-yet-updated cumulative-cost ledger. That spread grows with both larger `max_tokens` (single-call round-trip rose 3510ms → 3728ms → 6701ms across 500 → 4000 → 8000 tokens) and, at least as strongly, with more concurrent calls competing for the same backend authorization pipeline (batch `completedAt` spread: 2.35s at N=20 vs. 6.64s at N=50). **Honest caveat:** the run's money-safety cap (peak simultaneous holds ≤ $0.15) mechanically coupled `max_tokens` and N in opposite directions, so this design cannot cleanly separate "per-call latency" from "concurrency depth" as the dominant driver — the leak factor tracked N monotonically (1→2→3 as N went 10→20→50) but not `max_tokens` monotonically (500→8000→4000). Both SLOW rounds are one trial each. Read this as: **a reproducible check-then-act race that scales with concurrency, mechanism identified, magnitude small (2-3x slip)** — not a large blowout. Source: `dryrun/toctou_latency_experiment.md` (builds on `dryrun/toctou_scale_experiment.md` and `dryrun/hold_vs_settlement_experiment.md`).

## 9. Failure lifecycle: does failing cost you money? (two-case refinement)

Source: `loss_rate.md` (this repo's ingested n=81 sample) + `dryrun/hold_linearity_extension.md` (live dry-run probe, 2026-07-04). The earlier headline — "failures cost $0" — was correct as far as it went, but incomplete: it only observed one of two possible failure timings. The full picture depends entirely on **where in the hold lifecycle** the failure happens.

**Case A — failure BEFORE the hold is placed → $0.** Both failures in the ingested n=81 sample died during client/gateway setup, before execution reached the point of pricing a hold: `sapiom_fal` (wrong endpoint path, HTTP 404 pre-fix) and `unknown`/`sapiom_blaxel` (compute host DNS resolution failure, client-side, pre-gateway). Both have **zero cost rows of any kind** (`loss_rate.md`) — no hold, no settlement. Nothing to refund because nothing was ever charged.

**Case B — failure AFTER the hold is placed → the FULL hold is captured, not refunded.** `dryrun/hold_linearity_extension.md`'s 128k-token rung of the hold-linearity ladder hit a `502 Bad Gateway` from OpenRouter mid-flight, after the $0.076803 hold (`128,000 × $0.0006/1k`) was already authorized. That transaction's outcome was `error`, yet its cost row stayed `isActive: true` for the entire hold — no superseding capture row ever brought it down to the ~$0.0001 floor the way every successful call in the same experiment did. Confirmed directly against the account balance: `availableBalance` dropped by exactly $0.076803 across that step, matching the hold exactly (not a transient dip that later reverted). Result: **the full pre-authorized hold was billed as the final settled cost, for zero tokens of useful output.**

**CONFIRMED, N=4/4 (2026-07-04).** `dryrun/failure_capture_n3.md` replicated this 3 more times: 3 fresh, independent `max_tokens=128000` calls, each hit a `502 Bad Gateway`, and each captured the full $0.076803 hold as its final settled cost — one cost row apiece, `isEstimate:false`, `isActive:true`, `supersededAt:null`, no floor-settle, no release on any. New transaction ids: `c2c2ef60-2a28-4abf-8e61-1bfcae805bd7`, `0d248074-87fd-4f23-845f-c1c92e83fdf4`, `2f8bec77-71f1-4f06-8f3e-9dcd562a1ba9`. Combined with the original: **4 of 4 (100%) errored-post-hold over-request calls captured the FULL inflated hold, mean $0.076803, zero variance across all four observations** — mechanically `max_tokens × $0.0006/1k`, no usage-based adjustment.

**Honest two-part framing — these are not the same claim, do not conflate them:**
1. **Deterministic capture mechanic (MEASURED, 4/4).** IF a call fails after the hold is placed, the full inflated hold is captured — guaranteed in our data (100%, zero variance, N=4). Combined with over-request pricing (§10 below — holds are priced on requested `max_tokens`, even past the model's real ~16k output ceiling), the worst case is: billed `max_tokens`-priced dollars for zero output.
2. **Fleet exposure (ASSUMPTION-HEAVY, not measured).** How often this actually bites a fleet is `frequency = P(fail AFTER hold is placed) × over-hold size` — and we do not have a measured P(fail-after-hold). Our only two *naturally occurring* failures (Case A above) were PRE-hold ($0, empty `costs[]`); all 4 post-hold failures here were deliberately FORCED via 128k over-requests, not sampled from ordinary traffic. `dryrun/failure_capture_n3.md`'s own extrapolation table uses the fleet's overall observed failure rate (2/81 ≈ 2.5%, from `loss_rate.md`) as a stand-in for "post-hold failure rate" — but that 2.5% is the TOTAL observed failure rate, and both of those 2 failures were PRE-hold, so it is not evidence of how often calls fail POST-hold. Any "$X/day fleet loss" number built on it is a sensitivity (`loss = assumed_failure_rate × over_hold_size`), not a measured figure — treat the dollar amounts in that table as illustrative, not authoritative.

**The combined story:** whether a failure costs you real money is a function of lifecycle position, not failure type. Pre-hold failures are free (2/2 observed). Post-hold failures bill the entire hold, every time observed (4/4, 100%, zero variance). The capture *mechanism* is proven; only its frequency in live, unforced traffic is unknown.

## 10. Hold linearity extended to 64k tokens; over-hold beyond the model's real completion ceiling

Source: `dryrun/hold_linearity_extension.md`. The previously-confirmed linear hold rate (`$0.0006/1k tokens`, verified 2k-16k in `cap_experiment_result.json` / `extrapolation_result.json`) was extended upward: 16k (reconfirm) → 32k → 64k → 128k, same model (`openai/gpt-4o-mini`), one call per rung.

**Linear through 64,000 tokens.** Hold tracked `max_tokens × $0.0006/1k` almost exactly at every rung — 32k ($0.019203) and 64k ($0.038403) deviated from the rate by ≤0.03 percentage points, essentially flat, extending the previously-verified boundary 4x past 16k. The actual settled cost at every rung stayed at the $0.0001 floor (the model produced the same two-sentence answer regardless of the cap) — **including at 32k and 64k, well past `gpt-4o-mini`'s real completion ceiling (~16,384 tokens).** The hold is sized purely off the *requested* `max_tokens`, not the model's real output ceiling — Sapiom/OpenRouter did not reject or clamp the oversized request at either rung.

**128k caps out**, but not cleanly: that call failed with a `502 Bad Gateway`, not a documented "max_tokens exceeds model limit" rejection, so whether the hold formula itself breaks at 128k or a gateway-level limit (timeout, payload size, an internal ceiling on the authorization amount) trips specifically at that rung is unresolved. See §9 above for what happened to that hold — captured in full, not refunded.

