# Sapiom Ledger Audit Report

## Overview

- Total transactions: **75**
- Distinct agents: **15**
- Total live spend: **$0.253272**
- Period: **2026-07-04 04:51:39.614000 → 2026-07-04 10:48:25.001000**

### Spend by agent

| Agent | Transactions | Live Spend |
|---|---|---|
| spend-runaway | 25 | $0.150000 |
| spend-researcher | 12 | $0.072000 |
| sweep-scraping | 1 | $0.009000 |
| dryrun-researcher | 1 | $0.006000 |
| sweep-search | 1 | $0.006000 |
| sweep-images | 2 | $0.003000 |
| spend-writer | 10 | $0.002910 |
| sweep-audio | 1 | $0.001000 |
| fleet-test | 10 | $0.001000 |
| estimate-test | 2 | $0.000972 |
| sweep-compute | 2 | $0.000690 |
| cap-test | 3 | $0.000300 |
| scale-test | 3 | $0.000300 |
| sweep-llm | 1 | $0.000100 |
| sweep-data | 1 | $0.000000 |

## Check 1 — Double-count guard

✅ Naive sum (all cost rows, including superseded) vs live sum (superseded_at IS NULL only).

- Naive (all rows): **$0.280542**
- Live (active only): **$0.253272**
- Overstatement if naively summed: **+10.77%**

Sapiom restates costs via supersession chains (initial estimate → captured final). Summing every cost row double-counts every restated transaction; only the live row reflects money actually moved.

## Check 2 — Balance reconciliation

✅ Latest balance snapshot vs (initial_balance − live spend).

- Initial balance (parameterized): **$5.000000**
- Live spend to date: **$0.253272**
- Expected balance: **$4.746728**
- Actual latest balance (2026-07-04 10:51:46.946728): **$4.746728**
- Diff: **$0.000000**

## Check 3 — Revision analysis

Sapiom restates costs; here's how much, by service.

| Service | Revised Txns | Avg Revision % |
|---|---|---|
| sapiom_openrouter | 26 | -64.04% |

## Check 4 — Chain integrity

✅ **(a) Orphan superseded rows** (superseded but no row supersedes them): **0** found

❌ **(b) Completed transactions with zero cost rows**: **3** found

| Transaction ID | Service | Completed At |
|---|---|---|
| 7333a425-6a4f-476d-9610-955c642b9c87 | sapiom_fal | 2026-07-04 10:23:37.379000 |
| eb918dba-a2b5-46b0-96e1-5aff42e92b76 | unknown | 2026-07-04 10:23:45.875000 |
| f4c02c1f-f9b0-4198-bfea-8d082001d2bf | sapiom_neon | 2026-07-04 10:23:49.330000 |

✅ **(c) Transactions with >1 live cost row (double-charge bug)**: **0** found

