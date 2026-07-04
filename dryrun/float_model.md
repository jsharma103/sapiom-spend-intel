# Aggregate Float Model — From Naked Ratio to Defensible Little's Law Model

Zero spend, pure math over already-measured numbers (`dashboard_data.json`, `export_dashboard.py`, `findings.md`, `advisor.md`, `dryrun/cap_experiment_result.json`, `dryrun/extrapolation_result.json`). Every number below is either **MEASURED** (traced to a source file) or **ASSUMED** (explicitly labeled, with sensitivity shown instead of a single guess).

---

## 1. The current naked number

The dashboard's hero tile (`dashboard_data.json` → `hero_capture_ratio`) says, verbatim:

> **"at $1M/day TPV → $4.57M customer capital frozen daily"**
> (`frozen_at_scale_usd: 4569827.931172469`, `ratio_pct: 17.95%`, subline: *"authorize $1.00 → capture $0.18"*)

The formula behind it (`export_dashboard.py:162`):

```python
frozen_at_scale_usd = SCALE_TARGET_DAILY_TPV / ratio - SCALE_TARGET_DAILY_TPV
```

where `ratio` = Σsettled / Σheld = 0.004998 / 0.027838 = 17.95% across the 27 supersession chains observed tonight.

**What this assumes, plainly:** that the ~18% settle/hold (capture) ratio measured on 27 chains tonight holds unchanged at 1,000,000× today's volume, and nothing else — no time dimension, no concurrency, no distribution of call sizes, no change in hold duration as volume grows. It is a single ratio, multiplied up. That's the weakness this document fixes: it's a **naked extrapolation**, not a model with named, checkable inputs.

---

## 2. Two framings of "frozen capital" — they are not the same thing

### (A) Capture-ratio framing — the dashboard's framing (accounting view)

```
frozen$ = TPV/capture_ratio − TPV
```

This answers: *"If $1 of settlement requires $1/ratio of holds to be placed (because holds get superseded down to a smaller final capture), how much MORE than the settled total gets held-and-released over the same period?"*

It is a **pure ratio effect** — dimensionally, it has no time variable in it at all. `capture_ratio` is unitless, so `frozen$` scales linearly with TPV regardless of how fast holds clear. Two systems with the same 18% ratio but wildly different hold durations (1 second vs. 1 month) produce the *identical* frozen-capital number under this formula. That's the tell that it isn't really measuring an *instantaneous* frozen balance — see the cross-check in §4.

### (B) Latency framing — Little's Law (the rigorous one)

```
frozen$ (instantaneous) = (hold arrival rate) × (avg hold lifetime) × (avg hold size)
                        = (calls/sec) × (avg seconds a hold is outstanding) × (avg hold $)
```

This is the textbook queuing-theory relationship (Little's Law: L = λW) applied to money instead of customers-in-a-store. It answers: *"At any single instant, how much money is sitting in the 'held, not yet settled' state?"* — the actual balance a customer would see frozen if you froze the clock right now.

**Why (B) is the defensible one:** every input is either directly measured in this repo, or explicitly flagged as an assumption with a sensitivity range — no single unverified ratio is silently multiplied by a million.

**They answer different questions.** (A) is a per-day flow/accounting quantity — roughly "how much hold-volume gets placed and released over a day to generate $1M of settlement." (B) is a snapshot stock — "how much is frozen right now." Conflating them is exactly the naked-extrapolation risk in §1.

---

## 3. The explicit formula for (B), every input named

```
instantaneously_frozen$ = (calls_per_day / 86400) × avg_hold_lifetime_sec × avg_hold_$
```

| Input | Value | Status | Source |
|---|---|---|---|
| `calls_per_day` | 1,000,000 and 10,000,000 (parameterized) | Scale target (chosen) | Round-number scale targets, analogous in magnitude to the dashboard's $1M/day but denominated in **call volume**, not dollars — see the bridge in §4 for why this distinction matters. |
| `avg_max_tokens` per call | 2k / 8k / 16k (parameterized) | **ASSUMED** | We do not record per-chain `max_tokens` in the ledger; no single true average exists. Shown as a 3-point sensitivity instead of one guess. |
| `hold_rate` | $0.0006 / 1k tokens | **MEASURED** | `dryrun/cap_experiment_result.json` (rows show `holdPer1kTokens` ≈ 0.0006015 @ 2k tokens, 0.000600 @ 8k, 0.0006002 @ 16k) and `dryrun/extrapolation_result.json` → `experiment_a.verdict`: *"HOLDS ~LINEAR at scale — hold/cap ratio roughly constant (rel. spread 0.2%)"*, confirmed at 2k/8k/16k `max_tokens`. **Flag:** linearity beyond 16k is being confirmed separately in `hold_linearity_extension.md` — treat this rate as verified only up to 16k tokens; update this doc if that file changes the picture. |
| `avg_hold_lifetime` | p50 = 5.295s, p95 = 11.961s | **MEASURED** | `findings.md` §1 / `dashboard_data.json.tile_hold_release_latency` — `sapiom_openrouter`, n=31 chained calls, one evening, one model (`gpt-4o-mini`). Small sample; both p50 and p95 shown rather than picking one. |
| Concurrency / arrival assumption | Steady-state arrivals (Little's Law requires this) | **ASSUMED** | Little's Law (L = λW) holds in steady state regardless of arrival distribution — but the model implicitly assumes hold arrivals are roughly continuous at the stated rate, not bursty/batched. Directionally validated: `dryrun/extrapolation_result.json` → `experiment_b.verdict`: *"FLOAT REAL — balance dipped by holds mid-flight then recovered"* (fleet-test agent, 10 concurrent calls, balance genuinely dipped from $4.767518 to a low of $4.763074 and recovered to $4.766518 as holds superseded) — confirms the float is a real, observable mid-flight phenomenon, not an accounting artifact, on a small n=10 sample. |

Formula, restated with the table's inputs:

```
frozen$ = (calls_per_day / 86400) × avg_hold_lifetime_sec × (avg_max_tokens/1000 × $0.0006)
```

---

## 4. Sensitivity table

### 4a. Primary table — calls/day × avg_max_tokens (as specified), p50 latency

| calls/day | avg_max_tokens | hold $/call | frozen$ (p50 = 5.295s) |
|---|---|---|---|
| 1,000,000 | 2k | $0.0012 | **$0.07** |
| 1,000,000 | 8k | $0.0048 | **$0.29** |
| 1,000,000 | 16k | $0.0096 | **$0.59** |
| 10,000,000 | 2k | $0.0012 | **$0.74** |
| 10,000,000 | 8k | $0.0048 | **$2.94** |
| 10,000,000 | 16k | $0.0096 | **$5.88** |

### 4b. Same table, p95 latency (worst-observed hold duration)

| calls/day | avg_max_tokens | hold $/call | frozen$ (p95 = 11.961s) |
|---|---|---|---|
| 1,000,000 | 2k | $0.0012 | **$0.17** |
| 1,000,000 | 8k | $0.0048 | **$0.66** |
| 1,000,000 | 16k | $0.0096 | **$1.33** |
| 10,000,000 | 2k | $0.0012 | **$1.66** |
| 10,000,000 | 8k | $0.0048 | **$6.65** |
| 10,000,000 | 16k | $0.0096 | **$13.29** |

Range across the full grid: **$0.07 – $13.29** depending on call volume, request size, and which latency percentile you take as "typical."

### 4c. The bridge — putting (A) and (B) on the same $/day axis

The tables above use `calls_per_day` (a call-volume scale), not `$/day TPV` (a dollar-volume scale) — those are different axes, and at these small per-call LLM hold sizes ($0.0012–$0.0096), 1–10M calls/day corresponds to only ~$1.2K–$96K/day of *held* dollar volume, nowhere near $1M/day. To compare directly against the dashboard's $1M/day TPV scale target, restate Little's Law in dollar-volume terms — note `avg_max_tokens` cancels out entirely:

```
frozen$ (instantaneous) = held_dollar_volume_per_day × (avg_hold_lifetime_sec / 86400)
```

| Held $ volume/day | frozen$ (p50 = 5.295s) | frozen$ (p95 = 11.961s) |
|---|---|---|
| $1,000,000 | **$61.28** | **$138.44** |
| $10,000,000 | **$612.85** | **$1,384.38** |

**This is the headline defensible comparison:** at the *same* $1M/day scale the dashboard uses, the rigorous Little's-Law instantaneous-frozen number is **~$61–$138**, not $4.57M — four to five orders of magnitude smaller. (For reference, reaching $1M/day of *held* volume at 8k-token calls would take ≈208M calls/day — 1M/10M calls/day is a comparatively small-volume scenario, which is why §4a/4b's dollar figures look small in isolation.)

### 4d. Why the gap is so large — the naked number's implied hold lifetime

Force framing (A)'s $4.57M into Little's-Law terms and back out what hold lifetime it *implies*:

```
implied_lifetime = (frozen$ / TPV_per_day) × 86400s = (1/ratio − 1) × 86400s
                 = 4.5698 × 86400s ≈ 394,833s ≈ 4.57 DAYS
```

That is, the dashboard's naked $4.57M number is only a correct *instantaneous stock* if the average hold sat outstanding for **~4.57 days**. The measured reality (`findings.md` §1) is **5.3–12.0 seconds** — roughly **33,000× shorter**. This is the concrete, falsifiable reason framing (A) overstates instantaneous frozen capital: it's really a per-day flow quantity (total hold-and-release volume needed to net $1M of settlement in a day), not a snapshot balance, and reading it as "frozen right now" silently assumes hold durations measured in days that nothing in the data supports.

---

## 5. Assumptions & caveats (explicit)

- **hold_rate = $0.0006/1k tokens** — MEASURED, verified linear from 2k–16k tokens (`cap_experiment_result.json`, `extrapolation_result.json` experiment_a). Not yet confirmed above 16k tokens — `hold_linearity_extension.md` is the pending follow-up; revisit this doc if that changes the rate.
- **avg_hold_lifetime (p50=5.295s, p95=11.961s)** — MEASURED, but from a small sample: one evening, one model (`gpt-4o-mini`), n=31 chained calls, one service (`sapiom_openrouter`). Not yet validated across models, providers, or load conditions.
- **avg_max_tokens (2k/8k/16k)** — ASSUMED. No per-chain `max_tokens` is recorded in the ledger; `advisor.md` infers token counts from dollar amounts via the fitted rate, not from a real `usage` field. Shown as a 3-point sensitivity rather than a single point estimate for exactly this reason.
- **Ratio/rate stability across volume** — ASSUMED for framing (A); Little's Law (B) sidesteps this by not requiring the ratio to be constant, only that arrivals/lifetimes are steady-state (also an explicit assumption, partially corroborated by the real mid-flight balance dip in `extrapolation_result.json` experiment_b, n=10).
- **Governance fires on the hold, not settlement** — MEASURED (`findings.md` §8, live experiment against `api.sapiom.ai/v1`, real money): a `usage_limit` rule denied a call based on its $0.002403 hold when the real settlement was ~$0.0001. This means the "frozen" number in this model isn't just an accounting curiosity — it **is the effective budget-pressure number** customers actually collide with, since spending rules are evaluated against held amounts, not settled ones.
- **Steady-state / non-bursty arrivals** — ASSUMED, required for Little's Law to apply cleanly; real traffic has burstiness (see `findings.md` §5 runaway detection) that this model doesn't capture.
- **calls_per_day as a scale axis is distinct from $/day TPV** — noted explicitly in §4c; the two scale targets (1M/10M calls vs. $1M/day) are not the same quantity and are bridged, not conflated, in this document.

---

## 6. The one-line interview takeaway

> Frozen capital isn't a fixed percentage — it's **arrival_rate × hold_lifetime × hold_size** (Little's Law). At the dashboard's own $1M/day scale, with holds measured to clear in 5.3–12.0 seconds, the rigorous instantaneously-frozen figure is **≈$61–$138**, not $4.57M — the naked ratio number implicitly assumes holds sit outstanding for **~4.57 days**, when the measured reality is **seconds**. The two levers that actually shrink real frozen capital are hold_lifetime (settle faster) and hold_size (right-size `max_tokens` — `advisor.md` shows ~79% hold reduction is achievable today from this account's own data).
