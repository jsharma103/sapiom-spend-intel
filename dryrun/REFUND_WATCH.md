# refund_watch — is the $0.076803 capture permanent?

## What this tracks and why

`dryrun/hold_linearity_extension.md` (the 128k-token rung of the hold-linearity
ladder) fired a real LLM call that errored **after** the hold was placed:
OpenRouter returned a `502` mid-flight, but the full `$0.076803` hold
(`128,000 × $0.0006/1k`) stayed `isActive: true` on cost row
`ec78f8a8-e02e-4c65-8a20-9c44acd3b6be` under transaction
`d59fb015-f55f-4501-a3cb-247b6e091366` — no superseding capture row ever
brought it down to the ~$0.0001 floor every successful call in the same
experiment landed on. `availableBalance` dropped by exactly `$0.076803` and
never bounced back at last check.

This is **Case B** in `findings.md` ("failure AFTER the hold is placed → the
FULL hold is captured, not refunded"), labeled N=1. This script exists to
answer one question over time: does that capture ever reverse, or is it
permanent?

## How to run

```
cd /Users/jay.sharma/projects/sapiom-spend-intel
node --env-file=.env dryrun/refund_watch.js
```

(Equivalent if your node version doesn't support `--env-file`:
`set -a && source .env && set +a && node dryrun/refund_watch.js`)

Each run is GET-only (`/v1/accounts`, `/v1/transactions/:id?include=costs`) —
no spend, no POST/PUT, safe to run as often as you like.

## How to read the log

`dryrun/refund_watch.log` gets one tab-separated line appended per run:

```
<ISO timestamp>	available=<x>	total=<y>	activeCost=<amt>	superseded=<bool>	verdict=<REFUNDED|STILL-CAPTURED>
```

- **`STILL-CAPTURED`** — cost row `ec78f8a8...` is still `isActive: true` /
  `supersededAt: null`, no new row supersedes it, `availableBalance` hasn't
  risen by ~$0.0768 relative to the `$4.432691` baseline, and the active cost
  hasn't dropped toward the `$0.0001` floor. The hold is still fully captured.
- **`REFUNDED`** — any of: the target row is now superseded/inactive, a new
  cost row appeared that supersedes it, `availableBalance` rose by ~$0.0768,
  or the active cost on the transaction dropped near the `$0.0001` floor.
- **`ERROR`** — a GET failed; the line records the HTTP status instead of a
  verdict. The script exits non-zero and does not guess.

## What to do with it

Run it a few times over the next hours/days (manually is fine — no daemon
needed). If it's still `STILL-CAPTURED` after ~24h, treat the capture as
**permanent** (this hardens Case B from N=1-observed to N=1-confirmed-durable).
If any run flips to `REFUNDED`, it means Sapiom eventually swept/released the
hold — a softer version of the finding (delayed reconciliation rather than a
permanent loss).

Optional cron line if you want it automatic (not installed — add manually with
`crontab -e` if desired):

```
# Run refund_watch every hour, loading .env inline (adjust paths as needed):
0 * * * * cd /Users/jay.sharma/projects/sapiom-spend-intel && /usr/bin/env bash -lc 'set -a && source .env && set +a && node dryrun/refund_watch.js >> dryrun/refund_watch.cron.log 2>&1'
```

## Seed run (first data point)

```
2026-07-04T18:10:12.292Z	available=4.432691	total=4.721228	activeCost=0.076803	superseded=false	verdict=STILL-CAPTURED
```

`availableBalance` matches the post-experiment baseline exactly and the
active cost is still the full `$0.076803` — as of this seed run, **not
refunded**.
