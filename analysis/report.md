# Sapiom Ledger Audit Report

## Overview

- Total transactions: **326**
- Distinct agents: **35**
- Total live spend: **$0.821274**
- Period: **2026-07-04 04:51:39.614000 → 2026-07-07 05:19:32.158000**

### Spend by agent

| Agent | Transactions | Live Spend |
|---|---|---|
| spend-runaway | 25 | $0.150000 |
| race-lat-agent-slowB50 | 51 | $0.113341 |
| race-lat-agent-slowA20 | 21 | $0.086754 |
| hold-ext-test | 4 | $0.077103 |
| failure-capture-n3-2 | 1 | $0.076803 |
| failure-capture-n3-1 | 1 | $0.076803 |
| failure-capture-n3-3 | 1 | $0.076803 |
| spend-researcher | 12 | $0.072000 |
| chain-task | 6 | $0.024200 |
| holdtest-agent-hvs | 6 | $0.009712 |
| sweep-scraping | 1 | $0.009000 |
| sweep-search | 1 | $0.006000 |
| dryrun-researcher | 1 | $0.006000 |
| blast-test-8000 | 1 | $0.004802 |
| bounded-test-agent | 39 | $0.003800 |
| r5-boundary-agent | 14 | $0.003703 |
| sweep-images | 2 | $0.003000 |
| race-scale-agent-n10 | 11 | $0.002927 |
| spend-writer | 10 | $0.002910 |
| ll-validation-agent | 24 | $0.002400 |
| doublecount-confirm-agent | 20 | $0.002143 |
| blast-test-2000 | 5 | $0.001602 |
| ladder-usage-replicate | 14 | $0.001400 |
| doublecount-fast | 10 | $0.001202 |
| blast-test-500 | 10 | $0.001202 |
| doublecount-slow | 10 | $0.001202 |
| fleet-test | 10 | $0.001000 |
| sweep-audio | 1 | $0.001000 |
| estimate-test | 2 | $0.000972 |
| sweep-compute | 2 | $0.000690 |
| cap-test | 3 | $0.000300 |
| scale-test | 3 | $0.000300 |
| sweep-llm | 1 | $0.000100 |
| r3-idem-agent | 2 | $0.000100 |
| sweep-data | 1 | $0.000000 |

## Check 1 — Double-count guard

✅ Naive sum (all cost rows, including superseded) vs live sum (superseded_at IS NULL only).

- Naive (all rows): **$1.343751**
- Live (active only): **$0.821274**
- Overstatement if naively summed: **+63.62%**

Sapiom restates costs via supersession chains (initial estimate → captured final). Summing every cost row double-counts every restated transaction; only the live row reflects money actually moved.

## Check 2 — Balance reconciliation

❌ Latest balance snapshot vs (initial_balance − live spend).

- Initial balance (parameterized): **$5.000000**
- Live spend to date: **$0.821274**
- Expected balance: **$4.178726**
- Actual latest balance (2026-07-07 07:18:07.236364): **$4.707228**
- Diff: **$0.528502**

## Check 3 — Revision analysis

Sapiom restates costs; here's how much, by service.

| Service | Revised Txns | Avg Revision % |
|---|---|---|
| sapiom_openrouter | 177 | -76.09% |

## Check 4 — Chain integrity

✅ **(a) Orphan superseded rows** (superseded but no row supersedes them): **0** found

❌ **(b) Completed transactions with zero cost rows**: **3** found

| Transaction ID | Service | Completed At |
|---|---|---|
| 7333a425-6a4f-476d-9610-955c642b9c87 | sapiom_fal | 2026-07-04 10:23:37.379000 |
| eb918dba-a2b5-46b0-96e1-5aff42e92b76 | unknown | 2026-07-04 10:23:45.875000 |
| f4c02c1f-f9b0-4198-bfea-8d082001d2bf | sapiom_neon | 2026-07-04 10:23:49.330000 |

✅ **(c) Transactions with >1 live cost row (double-charge bug)**: **0** found

