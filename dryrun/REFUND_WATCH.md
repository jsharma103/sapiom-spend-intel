# refund_watch — do the failure-capture holds ever release?

## What this tracks and why

Two experiments found the same failure mode:

- `dryrun/hold_linearity_extension.md` (N=1): the 128k-token rung of the
  hold-linearity ladder fired a real LLM call that errored **after** the hold
  was placed — OpenRouter returned a `502` mid-flight — but the full
  `$0.076803` hold (`128,000 × $0.0006/1k`) stayed `isActive: true` on its
  cost row under transaction `d59fb015-f55f-4501-a3cb-247b6e091366`. No
  superseding row ever brought it down to the ~$0.0001 floor every
  successful call in the same experiment landed on. `availableBalance`
  dropped by exactly `$0.076803` and never bounced back.
- `dryrun/failure_capture_n3.md` (+3): three fresh, independent repeats of
  the same `max_tokens=128000` call, one at a time. All three hit the same
  `502` and captured the same `$0.076803` hold, 3/3. Combined with N=1:
  **4/4 observed errored-post-hold calls captured the full hold, 0/4
  reversed** as of that check.

This is **Case B** in `findings.md` ("failure AFTER the hold is placed → the
FULL hold is captured, not refunded"). `refund_watch.js` (v2) exists to
answer, over time, two questions:

1. **Per hold**: does any individual `$0.076803` capture ever reverse?
2. **In aggregate**: does the account's total frozen gap
   (`totalBalance − availableBalance`) ever shrink — including money frozen
   for reasons *other* than these 4 known holds?

v1 of this script (2026-07-04, now superseded) tracked only `d59fb015...`
against hardcoded baseline constants. v2 tracks all 4 known failure-capture
holds plus the account-wide frozen gap, and compares each run to the
*previous log line* instead of a fixed historical baseline.

## The 4 tracked holds

| label | transaction id | origin |
|---|---|---|
| `d59fb015` | `d59fb015-f55f-4501-a3cb-247b6e091366` | `hold_linearity_extension.md`, N=1 |
| `c2c2ef60` | `c2c2ef60-2a28-4abf-8e61-1bfcae805bd7` | `failure_capture_n3.md`, iteration 1 |
| `0d248074` | `0d248074-87fd-4f23-845f-c1c92e83fdf4` | `failure_capture_n3.md`, iteration 2 |
| `2f8bec77` | `2f8bec77-71f1-4f06-8f3e-9dcd562a1ba9` | `failure_capture_n3.md`, iteration 3 |

Each froze ~`$0.076803`; combined that's `$0.307212` of the account's total
frozen gap. As of the seed run below, the *actual* aggregate gap is
`$0.518946` — about `$0.21` more than these 4 holds alone account for, i.e.
there is other money stuck in the frozen state from earlier experiments too.
The aggregate check exists precisely to see that whole picture, not just
these 4 transactions.

## How to run

```
cd /Users/jay.sharma/projects/sapiom-spend-intel
node --env-file=.env dryrun/refund_watch.js
```

(Equivalent if your node version doesn't support `--env-file`:
`set -a && source .env && set +a && node dryrun/refund_watch.js`)

Each run is GET-only (`/v1/accounts`, `/v1/transactions/:id?include=costs` ×
4) — no spend, no POST/PUT, safe to run as often as you like. On any GET
failure the script logs the HTTP status for that call and exits non-zero; it
never retries (there is nothing to retry into — every endpoint here is a
read).

## How to read the log

`dryrun/refund_watch.log` is append-only. The **first line is the old v1
format** (kept for history, not rewritten). A comment line marks where the
format changes:

```
# --- format changed 2026-07-04: v2 tracks all 4 failure-capture holds + aggregate frozen gap (see REFUND_WATCH.md) ---
```

Every line after that marker is v2 format, one tab-separated line per run:

```
<ISO timestamp>	available=<x>	total=<y>	frozen=<gap>	holdsSum=<sum of the 4 holds>	residual=<gap minus holdsSum>	<label>=<STATE>($amt)|...	rollup=<n> FROZEN / <n> RELEASED / <n> GONE	prevFrozen=<prior gap or NA>	frozenDelta=<change vs prior line or NA>
```

The 4 per-hold states (pipe-separated within their own field) are one of:

- **`FROZEN`** — the hold's original cost row is still `isActive: true`,
  `supersededAt: null`, no second cost row has appeared for it, and the
  account's `totalBalance` hasn't dropped since the previous check. Still
  fully captured, not yet resolved either way.
- **`RELEASED`** — the original row has been superseded / marked inactive,
  or a second cost row now exists for the transaction (Sapiom closed out the
  hold some other way). Shown as `RELEASED($live,was$original)` so you can
  see what it settled to. This is the "eventual sweep" outcome.
- **`GONE`** — the hold's row still looks like an untouched, uncontested
  capture (same as `FROZEN`'s local signal), but `totalBalance` itself
  dropped since the previous reading — i.e. the account stopped treating it
  as a hold-in-limbo and recognized it as an actual settled charge instead.
- **`ERROR`** — that transaction's GET failed; the log records the HTTP
  status instead of a state, and the run exits non-zero.

Aggregate fields:

- **`frozen`** = `total − available`, the full frozen picture right now
  (not just these 4 holds).
- **`holdsSum`** = sum of the 4 holds' original captured amounts (a fixed
  reference, ~`$0.307212`, regardless of their current state).
- **`residual`** = `frozen − holdsSum` — frozen money *not* explained by
  these 4 holds. If this shrinks over time while the 4 holds stay `FROZEN`,
  something else is being swept even though these aren't.
- **`prevFrozen`** / **`frozenDelta`** — the previous line's frozen gap and
  the change since then. Works across the v1→v2 format boundary (v1 lines
  have `available=`/`total=` too, so the very first v2 line can still diff
  against the old seed line). Negative = shrinking = something released.

The stdout line each run prints a one-line human summary: total frozen,
how many of the 4 holds are still `FROZEN`, and whether the aggregate gap
grew, shrank, or held steady since the last run.

## What to do with it — the timeline matters

Run it now, again in a few hours, and once more tomorrow morning. What each
outcome means:

- **All 4 still `FROZEN` after ~24h** → treat the capture as **permanent**
  (hardens Case B from "observed" to "confirmed-durable"). This is the
  **hard** version of the finding: money that's captured on a post-hold
  error does not come back.
- **Any hold flips to `RELEASED`** → Sapiom eventually swept/released that
  hold. This is the **soft** version: delayed reconciliation rather than a
  permanent loss. Note *which* one released and how long it took.
- **Any hold flips to `GONE`** → the backend recognized it as a real,
  final charge (`totalBalance` moved). Different from `RELEASED` — the
  money didn't come back, it was formally booked as spent.
- **`residual` shrinks while all 4 holds stay `FROZEN`** → this is the
  **sharpest** version of the finding: Sapiom's sweep/reconciliation process
  *does* release other frozen money over time, but specifically skips (or
  is much slower on) failure-capture holds like these 4. That would mean
  the permanent-freeze behavior isn't "nothing ever sweeps," it's "this
  specific failure mode falls outside whatever does sweep."

Optional cron line if you want it automatic (not installed — add manually
with `crontab -e` if desired):

```
# Run refund_watch every hour, loading .env inline (adjust paths as needed):
0 * * * * cd /Users/jay.sharma/projects/sapiom-spend-intel && /usr/bin/env bash -lc 'set -a && source .env && set +a && node dryrun/refund_watch.js >> dryrun/refund_watch.cron.log 2>&1'
```

## Seed run (v1 → v2 transition, first data point)

```
2026-07-04T18:10:12.292Z	available=4.432691	total=4.721228	activeCost=0.076803	superseded=false	verdict=STILL-CAPTURED
# --- format changed 2026-07-04: v2 tracks all 4 failure-capture holds + aggregate frozen gap (see REFUND_WATCH.md) ---
2026-07-04T18:54:29.244Z	available=4.202282	total=4.721228	frozen=0.518946	holdsSum=0.307212	residual=0.211734	d59fb015=FROZEN($0.076803)|c2c2ef60=FROZEN($0.076803)|0d248074=FROZEN($0.076803)|2f8bec77=FROZEN($0.076803)	rollup=4 FROZEN / 0 RELEASED / 0 GONE	prevFrozen=0.288537	frozenDelta=+0.230409
```

Reading this: aggregate frozen gap is **`$0.518946`** (~`$0.52`), up
`$0.230409` from the v1 baseline — exactly the 3 additional holds captured
by `failure_capture_n3.md` since that baseline was taken
(`3 × $0.076803 = $0.230409`). All 4 known holds are `FROZEN` at their full
`$0.076803` each (`holdsSum = $0.307212`). The `$0.211734` residual is frozen
money from other, earlier experiments not covered by these 4 transactions —
part of the full picture this script now watches too.
