# Sapiom Ledger Audit Report

## Overview

- Total transactions: **50**
- Distinct agents: **5**
- Total live spend: **$0.231882**
- Period: **2026-07-04 04:51:39.614000 → 2026-07-04 05:36:30.368000**

### Spend by agent

| Agent | Transactions | Live Spend |
|---|---|---|
| spend-runaway | 25 | $0.150000 |
| spend-researcher | 12 | $0.072000 |
| dryrun-researcher | 1 | $0.006000 |
| spend-writer | 10 | $0.002910 |
| estimate-test | 2 | $0.000972 |

## Check 1 — Double-count guard

✅ Naive sum (all cost rows, including superseded) vs live sum (superseded_at IS NULL only).

- Naive (all rows): **$0.237327**
- Live (active only): **$0.231882**
- Overstatement if naively summed: **+2.35%**

Sapiom restates costs via supersession chains (initial estimate → captured final). Summing every cost row double-counts every restated transaction; only the live row reflects money actually moved.

## Check 2 — Balance reconciliation

✅ Latest balance snapshot vs (initial_balance − live spend).

- Initial balance (parameterized): **$5.000000**
- Live spend to date: **$0.231882**
- Expected balance: **$4.768118**
- Actual latest balance (2026-07-04 05:46:54.235162): **$4.768118**
- Diff: **$0.000000**

## Check 3 — Revision analysis

Sapiom restates costs; here's how much, by service.

| Service | Revised Txns | Avg Revision % |
|---|---|---|
| sapiom_openrouter | 11 | -38.20% |

## Check 4 — Chain integrity

✅ **(a) Orphan superseded rows** (superseded but no row supersedes them): **0** found

✅ **(b) Completed transactions with zero cost rows**: **0** found

✅ **(c) Transactions with >1 live cost row (double-charge bug)**: **0** found

