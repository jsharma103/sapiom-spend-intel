# Failure-capture replication (N+3): does "errored call captures full hold, no refund" repeat?

Extends `dryrun/hold_linearity_extension.md`'s N=1 finding (the 128k-token rung
that hit a `502` and kept the full `$0.076803` hold as the final settled
cost). This run fires **3 more fresh, independent** `max_tokens=128000` /
`openai/gpt-4o-mini` calls, one at a time, via
`dryrun/failure_capture_n3_experiment.js` (same request shape as
`hold_linearity_extension_experiment.js`: same model, same short two-sentence
prompt, same OpenRouter service path). Raw data: `dryrun/failure_capture_n3_result.json`.

## Per-call results

| i | HTTP status | outcome | active cost | isEstimate | isActive | supersededAt | balance before | balance after | delta | verdict |
|---|---|---|---:|---|---|---|---:|---:|---:|---|
| 1 | 502 | error | $0.076803 | false | true | null | $4.432691 | $4.355888 | $0.076803 | **CAPTURED** |
| 2 | 502 | error | $0.076803 | false | true | null | $4.355888 | $4.279085 | $0.076803 | **CAPTURED** |
| 3 | 502 | error | $0.076803 | false | true | null | $4.279085 | $4.202282 | $0.076803 | **CAPTURED** |

All three transactions have exactly **one** cost row each — no second,
superseding row ever brought the cost down to the `$0.0001` floor the way
every successful call does. The active row is the original pre-authorized
hold itself, marked `isActive: true`, `supersededAt: null`.

## Tally

- **3/3 errored** (all `502 Bad Gateway` / `"OpenRouter API error"`, identical
  to the original N=1 case).
- **3/3 of those captured the full hold** (none floor-settled, none released).
- Combined with the original N=1: **4/4 observed errored-post-hold calls have
  captured the full hold.** Empirical capture-on-error rate: **100% (4/4)**.
- Mean captured amount across all 4: **$0.076803** (identical every time —
  zero variance, since it's mechanically `max_tokens × $0.0006/1k` with no
  usage-based adjustment).

## Extrapolation model

The finding is deterministic, not probabilistic, in its *capture mechanics*:
**IF** a call errors after the hold is placed, **THEN** the full hold is
captured, every time observed (4/4). The open probabilistic question is only
*how often* a call errors post-hold in the first place — that's a property of
the upstream gateway/model reliability, not of Sapiom's settlement logic.

**Inputs, labeled measured vs. assumed:**
- Hold size at 128k max_tokens: **measured** — $0.076803 (exact, 0% variance across all 4 observations).
- Capture-on-error rate (given a post-hold error occurs): **measured** — 100% (4/4 this experiment family; N is still small, but zero counterexamples).
- Post-hold failure rate (how often a call errors after the hold is placed) at 128k specifically: **not independently measured** — the 4 observations are all deliberately-provoked failures at 128k, not a random sample of 128k call attempts, so a raw failure-rate can't be derived from this batch alone.
- Fleet-wide failure rate: **assumed**, using the task's supplied reference figure of **2/81 ≈ 2.5%** (a general-purpose call-failure rate figure, not 128k-specific) as a stand-in for "how often does a random production call end up erroring post-hold."

**Linear compounding model:**

```
expected_loss(N calls) = N × P(post-hold failure) × P(capture | failure) × mean_captured_hold
                        = N × P(post-hold failure) × 1.00 × $0.076803
```

Using the fleet reference rate (2.5%) and the measured capture rate (100%):

| N calls | Expected failed-and-captured calls | Expected loss |
|---:|---:|---:|
| 5 | 5 × 0.025 = 0.125 | **$0.0096** |
| 10 | 10 × 0.025 = 0.25 | **$0.0192** |
| 100 (fleet, illustrative) | 100 × 0.025 = 2.5 | **$0.1920** |
| 1,000 (fleet, illustrative) | 1,000 × 0.025 = 25 | **$1.9201** |

**Caveat on the fleet numbers:** $0.076803 is the hold size *specifically at
`max_tokens=128000`* — it scales linearly with whatever `max_tokens` a given
production call actually requests (per `hold_linearity_extension.md`,
$0.0006/1k tokens, confirmed flat through 64k and still exact at 128k). A
fleet running smaller `max_tokens` values would see proportionally smaller
captured amounts per failure; a fleet that also uses 128k-scale requests would
see this exact per-failure cost. The 2.5% failure-rate input is carried over
from the task's supplied reference figure, not re-derived here, and is
labeled **assumed** for that reason. The capture mechanic itself (100%,
$0.076803 exact) is the **defensible, measured** part of this model — this is
the "scale version" of the finding: the mechanism is proven at N=4/4; the
fleet-dollar figures are a projection that inherits the uncertainty of the
external failure-rate input.

## Total spend this run

**$0.230409** (3 × $0.076803), under the $0.35 run cap. Combined with the
original N=1 ($0.077103, itself 3 successful floor-settles + 1 captured
failure), cumulative spend across the whole `failure_capture` investigation
line so far: **$0.307512**.

## New transaction IDs (for refund_watch tracking)

- `c2c2ef60-2a28-4abf-8e61-1bfcae805bd7` (iteration 1, cost row captured $0.076803)
- `0d248074-87fd-4f23-845f-c1c92e83fdf4` (iteration 2, cost row captured $0.076803)
- `2f8bec77-71f1-4f06-8f3e-9dcd562a1ba9` (iteration 3, cost row captured $0.076803)

(Original N=1 transaction, still tracked by `dryrun/refund_watch.js`:
`d59fb015-f55f-4501-a3cb-247b6e091366`.)

## Balances

| | availableBalance | totalBalance |
|---|---:|---:|
| Before iteration 1 | $4.432691 | $4.721228 |
| After iteration 1 / before iteration 2 | $4.355888 | $4.721228 |
| After iteration 2 / before iteration 3 | $4.279085 | $4.721228 |
| After iteration 3 (final) | $4.202282 | $4.721228 |

No aborts triggered — balance stayed well above the $2.75 floor throughout,
and no iteration's delta exceeded the $0.15 anomaly trip-wire (all three were
exactly $0.076803).
