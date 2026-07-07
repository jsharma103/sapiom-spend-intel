# Loss Rate — failures in payments language

Payments-executive framing: a "loss rate" is the chargeback/failed-settlement analog —
how much of total processed volume never actually settles cleanly. Free, read-only,
`spend.duckdb` only (no API spend).

## Numbers

- **Failed transactions:** 2 / 81 (**2.5%** of txn count)
- **Dollar-weighted loss rate:** $0.000000 failed-and-charged ÷ $0.277472 total live TPV =
  **0.0% (0 bps)**
- **Key question — does Sapiom charge for failures?** In this sample: **no.** Both failed
  transactions have **zero** cost rows attached — no hold, no settlement, no charge of any
  kind. There is nothing to auto-refund because nothing was ever charged.

## Why: root cause, not policy

Both failures are pre-settlement, gateway/client-level errors, not vendor-side failures
after money moved (see `reliability.md` for the full root-cause table):

| Transaction | Service | Root cause |
|---|---|---|
| `7333a425-6a4f-476d-9610-955c642b9c87` | sapiom_fal | Wrong endpoint path (pre-fix) → HTTP 404 before any image generation started |
| `eb918dba-a2b5-46b0-96e1-5aff42e92b76` | unknown (blaxel) | Compute host didn't resolve in DNS → client-side fetch failure before the request reached a real gateway |

Both were fixed same-session (see `RUN_LOG.md` item 1). Neither call ever reached the point
where a vendor could bill for partial work, so "0 bps loss rate" here is really "0 failures
that got far enough to cost anything" — it does **not** prove Sapiom would eat the cost of
a failure that happens *after* a hold is placed (e.g., vendor times out mid-generation).
That scenario wasn't present in this n=81 sample, but has since been directly observed:
`dryrun/hold_linearity_extension.md`'s 128k-token call errored (502) after its $0.076803
hold was authorized, and the full hold was RETAINED/FROZEN, not released — confirmed via an
exact $0.076803 `availableBalance` drop, while `totalBalance` never moved across that same
step (see `findings.md` §9) — so this is frozen, unavailable capital, not a confirmed
completed charge. Replicated 3 more times (N=4/4 total, `dryrun/failure_capture_n3.md`), same
result every time, zero variance. So the two-case answer is now complete: **fails before the
hold = $0, nothing ever held (this section, n=2); fails after the hold = the full hold is
retained/frozen, not released (n=4/4, see `findings.md` §9).** Lifecycle position, not
failure type, decides whether your capital gets frozen — the per-failure retention rate is
measured (4/4); how often calls fail *after* a hold is placed in live traffic is not.

## Reproducing these numbers

```sql
-- Total txns and failed txns
SELECT COUNT(*) FROM transactions;                                   -- 81
SELECT COUNT(*) FROM transactions WHERE outcome = 'error';            -- 2

-- Failed txns as % of txn count: 2/81 = 2.5%

-- Total live TPV (non-superseded cost rows only, matches dashboard TPV tile)
SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL;
-- 0.277472

-- Live TPV attributable to failed transactions
SELECT COALESCE(SUM(c.fiat_amount), 0)
FROM costs c JOIN transactions t ON t.id = c.transaction_id
WHERE t.outcome = 'error' AND c.superseded_at IS NULL;
-- 0  (no cost rows exist at all on either failed transaction)

-- Did EITHER failed transaction produce ANY cost row (held or settled, live or superseded)?
SELECT t.id, t.service_name, t.outcome, c.id AS cost_id, c.fiat_amount, c.superseded_at
FROM transactions t LEFT JOIN costs c ON c.transaction_id = t.id
WHERE t.outcome = 'error';
-- both rows: cost_id/fiat_amount/superseded_at all NULL -> zero cost rows of any kind
```

Loss rate (bps) = failed-and-charged $ ÷ total live TPV $ × 10,000 = 0 ÷ 0.277472 × 10,000
= **0 bps**. Failed-txn rate = 2 ÷ 81 × 100 = **2.5%** of txn count.

## Dashboard

One-line mini-tile appended to the "Auth → Capture Time" tile (same reliability theme):
"Loss rate: 0 bps of TPV — 2/81 txns failed (2.5%), 0/2 charged." Numbers regenerated via
`export_dashboard.py`'s `tile_loss_rate()`, which runs the same queries shown above.
