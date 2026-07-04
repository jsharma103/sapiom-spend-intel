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
| chain-1783163079023-ddff4761 | 3 | $0.012100 | 16.21s |
| chain-1783163183588-07885448 | 3 | $0.012100 | 15.23s |

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

