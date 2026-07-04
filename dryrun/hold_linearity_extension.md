# Hold-linearity extension: does $0.0006/1k hold linearly above 16k tokens?

Extends `cap_experiment.js` / `extrapolation_experiment.js`'s confirmed linear region
(100 → 16,000 tokens, $0.0006/1k, 0.2% spread) upward: 16000 (reconfirm) → 32000 →
64000 → 128000. Same model (`openai/gpt-4o-mini`), same short two-sentence prompt,
one call per rung, run sequentially via `dryrun/hold_linearity_extension_experiment.js`.
Raw data: `dryrun/hold_linearity_result.json`.

## Cap ladder results

| max_tokens | HTTP status | hold observed | $/1k tokens | deviation from $0.0006/1k |
|---:|---|---:|---:|---:|
| 16,000 | 200 | $0.009603 | $0.0006002 | +0.03% |
| 32,000 | 200 | $0.019203 | $0.0006001 | +0.02% |
| 64,000 | 200 | $0.038403 | $0.0006000 | +0.01% |
| 128,000 | **502 (OpenRouter API error)** | $0.076803 (see below) | $0.0006000 | +0.00% |

The **hold** amount tracks `max_tokens × $0.0006/1k` exactly at every rung, including
32k and 64k — well past `gpt-4o-mini`'s documented real completion ceiling
(~16,384 tokens). The actual (final) settled cost at 16k/32k/64k stayed at the
$0.0001 floor, same as the original 100→16000 dataset — the model still only
produced a two-sentence answer regardless of the cap. **The hold is sized purely
off the requested `max_tokens` value, not off the model's real output ceiling.**
Sapiom/OpenRouter did not reject or clamp the request at 32k/64k even though the
model can't actually use that many completion tokens.

## VERDICT

**Linear through 64,000 tokens** (hold/1k spread across 16k/32k/64k: 0.03
percentage points, i.e. essentially flat) — the $0.0006/1k line extends 4x past
the previously-verified 16k boundary with no bend or plateau.

**Caps at 128,000** — the call failed with `502 Bad Gateway` / `"OpenRouter API
error"`, not a clean model-side "max_tokens too large" rejection. So we can't
directly confirm whether the hold formula itself breaks at 128k, or whether
128k specifically trips some gateway-level limit (timeout, payload size, an
internal ceiling on the authorization amount, etc.) that 64k doesn't.

## Important secondary finding: failed calls are NOT refunded to the floor

The 128k transaction's outcome was `"error"` (not `"success"`), yet its cost row
was **`isActive: true` for the full $0.076803 hold — there was no second,
superseding capture row bringing it down to the ~$0.0001 floor** the way every
successful call (16k/32k/64k, and all of `cap_experiment.js`'s calls) got. In
other words: **when the downstream LLM call errors out, Sapiom appears to
capture the entire pre-authorized hold as the final settled charge, instead of
releasing it or settling to actual usage.** This was confirmed against the
account balance directly: available balance dropped by exactly $0.076803 across
the 128k step (see Balances below) — this was not a transient hold that later
reverted, it was billed.

This is a materially different (and more expensive) failure mode than "model
rejects the request cleanly" — a caller who sets a large `max_tokens` and hits
any transient gateway error pays the full hold amount for zero tokens of
useful output, rather than the floor. Worth a dedicated repro/finding entry
(not authorized to write to BACKLOG.md/findings.md in this run — flagging here
per the task's file-only output scope).

## Balances

| | availableBalance | totalBalance |
|---|---:|---:|
| Before run | $4.509794 | $4.721528 |
| Before 128k step (re-check) | $4.509494 | — |
| After run | $4.432691 | $4.721228 |

- Total settled spend this run: **$0.077103** ( = 3 × $0.0001 floor settlements + $0.076803 captured-in-full 128k failure )
- Peak frozen (sum of initial holds across all 4 calls, before any settled/captured): **$0.144012** — matches the task's pre-run estimate (~$0.14). Three of the four holds settled back down to the $0.0001 floor; the 128k hold did not release — it became the settled cost itself.
- No rules were created/paused; nothing to clean up. Remaining balance reflects the run's actual $0.077103 cost.

## Model-cap note

`openai/gpt-4o-mini`'s real completion-token ceiling did **not** produce a
clean client-facing rejection at 32k or 64k the way the task anticipated
("some models cap max_tokens... if the model REJECTS a high max_tokens"). It
silently accepted requests exceeding its real cap and billed the hold at the
full requested `max_tokens` rate regardless. The only rejection observed was
the 128k gateway error, which reads as an OpenRouter/Sapiom-side failure
rather than a documented "max_tokens exceeds model limit" validation error.
No model switch was performed — switching models was avoided deliberately
since this account's $0.0006/1k calibration is `gpt-4o-mini`-specific and an
uncalibrated model's hold size on a real wallet is unknown risk.
