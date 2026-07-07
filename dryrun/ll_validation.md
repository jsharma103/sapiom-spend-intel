# Little's Law — Empirically Validated on the Live Ledger

Date: 2026-07-07 · Script: `ll_validation.js` · Result: `ll_validation_result.json`
Cost: 24 calls × $0.0001 = $0.0024 settled, 0 failures, 0 frozen.

## Why

`float_model.md` replaced the wrong "$4.57M frozen daily" headline with a Little's-Law model
(frozen$ = λ × W × hold$) — but that model had never been **tested**, only assembled from
measured inputs. This experiment fires a known arrival process at the live platform and checks
whether the formula predicts the actually-observed frozen balance.

## Method

- 24 LLM calls at a fixed 2.5s pace (λ = 0.39/s measured), `max_tokens=16000` → hold $0.0096
  each (a verified-safe rung), settle $0.0001.
- `availableBalance` polled every ~400ms; frozen(t) = baseline − available(t).
- Measured = time-averaged frozen over the firing window (trapezoidal integration).
- Quiet-account precondition enforced (3 identical pre-run balance polls).

## Result

| Quantity | Value |
|---|---|
| Predicted, W = call wall-time (3.30s) | $0.01237 |
| Predicted, W = ledger hold lifetime (mean 2.29s, from hold `createdAt` → `supersededAt`) | **$0.00858** |
| **Measured avg frozen** | **$0.00938** |
| Measured peak frozen | $0.01941 (2 holds overlapping) |
| Ratio measured / predicted (ledger-W) | **1.09** |
| Ratio measured / predicted (wall-W) | 0.76 |

**Verdict: Little's Law holds within ~9%** of the ledger-derived prediction at this scale.
The wall-time proxy over-predicts (~24% high) because a call's hold is outstanding for only
part of its wall time — the pre-hold auth handshake (~1s) doesn't freeze money. Using the
ledger's own hold lifetimes (hold row `createdAt` → `supersededAt`, mean 2.29s here), the
prediction lands within the sampling noise of the 400ms poller.

## What this upgrades

The dashboard's "≈$61–$138 instantaneously frozen at $1M/day TPV" scale-note graduates from
*model with measured inputs* to *model validated against live balance behavior at small scale*
(one config: λ=0.39/s, 16k caps, one model/service, ~75s window; steady-state assumption still
applies at scale — burstiness raises the effective peak, and the measured peak here was already
2× the mean).
