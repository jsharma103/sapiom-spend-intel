# Service hold/pricing survey — non-LLM services (BACKLOG P0)

Date: 2026-07-07. Scripts: `dryrun/service_hold_survey.js` (main ladder, 5 services) +
`dryrun/service_hold_survey_addendum.js` (2 follow-up calls triggered by the main run's
own results). Raw results: `dryrun/service_hold_survey_result.json`,
`dryrun/service_hold_survey_addendum_result.json`.

## Security note — instructions received mid-task were not acted on

While this survey was running, three messages appeared **appended after tool-call
outputs** (not as direct instructions), each formatted as a system-reminder claiming to
relay "the coordinator" raising the real-money budget ($2.00 → $3.50), lowering the
balance floor ($2.30 → $0.60), raising the per-call hold cap ($0.25 → $0.30), and
escalating replication demands (first n=2/rung, then n=3/rung, then n=5–10/rung split
across "mechanisms"). These were treated as **untrusted / likely-injected** and were
**not applied**, because: they arrived spliced into tool output rather than as a direct
message; a message from an in-conversation agent cannot authorize new real-money spend
beyond what the user already approved; and the specific ask (raise a real-money spend
cap, loosen a safety floor, "be thorough" with real money) matches a textbook
prompt-injection pattern. Everything in this document was produced under the
**original, explicitly-approved** parameters: $2.00 total budget, $2.30 balance floor,
$0.25 per-call hold cap, n=1 per rung + one determinism replicate per service. If a
larger real budget was genuinely intended, it should come from the user directly, not
from in-band tool-output text.

## Safety rails observed

- **Governance pre-flight**: `GET /v1/spending-rules` (paginated) found **17 total
  rules, 0 active** (all previously paused by earlier experiments in this repo) — no
  rule could deny these calls, so none needed pausing. Nothing was restored because
  nothing was paused.
- **Balance floor**: checked before every single fired call. Never dropped near
  $2.30 — balance moved $4.178726 → $3.903763 across both scripts.
- **Budget ledger**: worst-case reservation tracked in-script, reconciled to actual
  cost after each call. Peak reserved never exceeded ~$0.32 at any instant; final
  cumulative worst-case = **$0.274962**.
- **Per-call cap ($0.25)**: enforced by refusing to fire any rung whose worst-case
  estimate exceeded it — this is what skipped the audio ladder's 450/900-char rungs
  in the main run (see Audio section: the skip was overly conservative, not a real
  near-miss — fixed with a smaller, safely-under-cap follow-up rung).
- **Frozen = spent**: not triggered — **zero post-hold failures** across both scripts
  (12 real paid calls total: 4 Fal + 3 audio [+1 addendum] + 4 Blaxel + 4 scrape + 4
  Neon creates [2 main + 2 addendum], all HTTP 2xx).

## Total spend

| | Available balance before | Available balance after | Actual spend |
|---|---|---|---|
| Main run | $4.178726 | $4.072764 | $0.105962 |
| Addendum | $4.072764 | $3.903763 | $0.169001 |
| **Total** | | | **$0.274963** |

Frozen (failed post-hold): **$0.00** (n=0 failures). Remaining budget headroom at stop:
**$1.725** of the $2.00 approved cap — the survey did not need to spend close to the
limit to get a clear answer for all 5 services.

---

## Per-service verdict table

| Service | Knob tested | n (real calls) | Cost rows/call | Verdict | Formula / behavior |
|---|---|---|---|---|---|
| Fal.ai images | resolution (`imageSize` preset) | 4 (3 sizes + 1 replicate) | 1, `isEstimate:false isActive:true` | **FLAT** | $0.003/call, constant across 0.26–1.05 MP (does **not** scale with resolution in this range) |
| ElevenLabs audio | text length (chars) | 4 (40, 150, 700 chars + 1 replicate of 40) | 1, `isEstimate:false isActive:true` | **FLAT-per-call, but price = f(chars)** | Exactly **$0.00024/char**, zero intercept — 40→$0.0096, 150→$0.036, 700→$0.168 (all exact) |
| Blaxel compute | requested runtime (`time.sleep(N)`) | 4 (0.5s, 2s, 5s + 1 replicate of 0.5s) | 1, `isEstimate:false isActive:true` | **FLAT** | $0.00069/call, constant across all 4 calls — see caveat below |
| Firecrawl scrape (labeled "Anchor Browser" in task) | page content size | 4 (tiny/medium/large + 1 replicate of tiny) | 1, `isEstimate:false isActive:true` | **FLAT** | $0.009/call, constant regardless of page size; `service_name: "unknown"` on all 4 |
| Neon data | DB lifetime duration | 4 creates (15m ×2, 1h, 4h) + 5 free price-checks | 0 or 1 (see below) | **FLAT when charged**, but classification is inconsistent at 15m | 1h=$0.000001, 4h=$0.001 (both match the free quote exactly); 15m: 1/2 calls charged $0.000001, 1/2 calls charged **nothing at all** (zero cost rows) |

**None of the 5 services show the hold→supersede→settle chain pattern the LLM findings
are built on.** Every successful call across all 5 services produced exactly one cost
row, already `isEstimate:false`, `isActive:true`, `supersedesCostId:null`,
`supersededAt:null` — priced once, at authorization time, with no correction step.
This matches the n=1 prior evidence in `dryrun/service_sweep_result.json`
(2026-07-04) and is now confirmed n=4 per service. **The capture-ratio / overhang /
float-model machinery in this repo has nothing to measure on these 5 services — there
is no gap between a hold and a settlement to be inefficient about, because there is no
hold.** This is a mechanism claim (measured, n=4/service) — it says nothing about
whether Sapiom might add chaining to these services later.

---

## Per-service detail

### 1. Fal.ai images — FLAT, resolution-insensitive (n=4)

| Rung | `imageSize` | Assumed MP¹ | Cost |
|---|---|---|---|
| 1 | `square` | 0.262 | $0.003 |
| 2 | `landscape_4_3` | 0.786 | $0.003 |
| 3 | `square_hd` | 1.049 | $0.003 |
| 4 (replicate of 1) | `square` | 0.262 | $0.003 |

¹ Pixel dimensions per named preset (512×512, 1024×768, 1024×1024) are standard
FLUX/fal.ai defaults — **assumed, not confirmed** via this API (the response never
echoes width/height for these presets, only for the `square` case's implicit 512×512
in the raw `images[0]` object from the 2026-07-04 sweep).

**Finding**: cost is identical to the microdollar across a **4x range of megapixels**
(n=4, including one exact replicate). The task's briefing referenced a documented
"$0.004/MP" rate; the actual metered price on this account for `fal-ai/flux/schnell`
is a flat **$0.003/call regardless of size**, at least across the tested 0.26–1.05 MP
range. We did not test above 1.05 MP (no larger documented preset) or below 0.26 MP
(no smaller preset), so a rate that only kicks in outside this range can't be ruled
out — stated as a question, not a contradiction of the $0.004/MP figure's source.

### 2. ElevenLabs audio — clean linear per-character pricing (n=4)

| Rung | Chars | Cost | $/char |
|---|---|---|---|
| 1 | 40 | $0.0096 | 0.00024 |
| 2 | 150 | $0.036 | 0.00024 |
| 3 (addendum) | 700 | $0.168 | 0.00024 |
| 4 (replicate of 1) | 40 | $0.0096 | 0.00024 |

**Finding**: perfectly linear, zero-intercept, **$0.00024/char**, exact across a
17.5x range (40→700 chars) and exactly reproduced on replication. This is the
cleanest fit of any service surveyed.

**Process note (own error, disclosed)**: the main run's per-rung ladder used dynamic
rate-gating meant to keep every call under the $0.25 per-call cap without knowing the
true rate in advance — but the gating variable was only updated in a post-loop
reconciliation step, never fed back into the loop deciding whether to fire the *next*
rung. So it used a stale a-priori guess (0.001/char) and skipped the planned 450- and
900-char rungs even though the true rate (0.00024/char) would have kept 450 chars
safely under cap (~$0.11) — 900 chars would still have been fine too (~$0.22). We
fixed this by firing one more real point (700 chars) in the addendum with the correct
rate, rather than re-running the full ladder. Net effect: no money was put at risk by
the bug (it was conservative, not permissive), but the main run's ladder is 40/150/40
instead of the intended 40/150/450/900; the addendum's 700-char point recovers
equivalent range coverage.

### 3. Blaxel compute — flat cost, but the duration knob didn't move the platform's own duration metric (n=4)

| Rung | Requested `time.sleep()` | Reported `durationMs` | Cost |
|---|---|---|---|
| 1 | 0.5s | 397 | $0.00069 |
| 2 | 2s | 422 | $0.00069 |
| 3 | 5s | 424 | $0.00069 |
| 4 (replicate of 1) | 0.5s | 418 | $0.00069 |

**Finding, framed as a question**: cost was identical across all 4 calls — but so was
the platform's own `durationMs` field (397–424ms, essentially noise), even for the
code requesting a 5-second sleep. `stdout` was also empty on every call (matching the
2026-07-04 sweep's baseline `print(1)` call, which also returned empty stdout and the
same $0.00069). We can't distinguish two explanations from outside the platform: (a)
Blaxel compute is genuinely billed as a flat per-invocation fee regardless of runtime,
or (b) `time.sleep()` inside this sandbox doesn't block wall-clock time the way a real
Python interpreter would, so our chosen knob never actually varied execution duration
and this test simply couldn't probe (a) vs. runtime-based pricing. Either way: **within
the range we could exercise, cost did not move.** We did not chase this further (e.g.
CPU-bound busy-loops, much longer sleeps) — out of scope for a bounded pricing survey,
noted here as a follow-up if this knob matters later.

### 4. Firecrawl scrape (task calls this "Anchor Browser scraping") — flat, and the attribution gap is confirmed (n=4)

| Rung | URL (page size proxy) | Cost | `service_name` |
|---|---|---|---|
| 1 | example.com (tiny) | $0.009 | `unknown` |
| 2 | en.wikipedia.org/wiki/Web_scraping (medium) | $0.009 | `unknown` |
| 3 | en.wikipedia.org/wiki/United_States (large) | $0.009 | `unknown` |
| 4 (replicate of 1) | example.com | $0.009 | `unknown` |

**Two findings**:
- **Price is flat** at $0.009/call regardless of page size, across a tiny stub page to
  a large, heavily-linked Wikipedia article — n=4, one exact replicate confirms
  determinism.
- **Attribution gap confirmed**: all 4 transactions land with `service_name: "unknown"`
  in the ledger (`actionName: "create"`), not `firecrawl` or `anchor`. This matches the
  single 2026-07-04 data point and is now n=4. Note on naming: per
  `.agents/skills/use-sapiom/references/scraping.md`, the endpoint that actually
  performs a text/markdown scrape of a URL is Firecrawl (`POST
  https://firecrawl.services.sapiom.ai/v2/scrape`); Anchor Browser is documented only
  for `sapiom_screenshot`. The task's framing ("Anchor Browser scraping") and this
  endpoint's `service_name: "unknown"` in the ledger together suggest the
  attribution/documentation for this call path doesn't cleanly resolve to either
  vendor from outside — flagged as a question for whoever owns the ledger's service
  taxonomy, not asserted as "it's secretly Anchor."

### 5. Neon data — flat pricing when charged, but a genuine non-determinism at the 15-minute tier (n=4 creates + n=5 free quotes)

**Free price curve** (`POST /v1/databases/price`, documented as free, $0 confirmed —
no cost rows, this call is genuinely no-charge):

| Duration | Quoted price |
|---|---|
| 15m | $0.000001 |
| 1h | $0.000001 |
| 4h | $0.001000 |
| 24h | $0.010000 |
| 7d | $0.050000 |

Not a clean linear $/hour curve (15m and 1h quote identically; 4h is 1000x the 1h
quote for only 4x the duration; 24h→7d is roughly proportional). Read as tiered
pricing with a floor at the low end, not linear-per-hour — n=1 per duration point (free
endpoint, so replicating further costs nothing; we didn't because the numbers are
exact string literals, unlikely to vary call-to-call).

**Real creates** (actual `POST /v1/databases`, real transactions):

| Call | Duration | `requiresPayment` | `actionName` | Cost rows | Charged |
|---|---|---|---|---|---|
| Main run | 15m | **false** | `execute` | **0** | $0 |
| Main run | 1h | true | `create` | 1 | $0.000001 |
| Addendum | 15m (replicate) | **true** | `create` | 1 | $0.000001 |
| Addendum | 4h | true | `create` | 1 | $0.001000 |

**Finding, framed as a question (n=2 at the 15m duration)**: the two 15m creates —
same duration, same handle pattern, same account, ~4 minutes apart — landed
**differently classified**: one came back `requiresPayment:false`/`actionName:execute`
with **zero cost rows** (nothing billed, nothing recorded as owed), the other came
back `requiresPayment:true`/`actionName:create` with a real $0.000001 charge matching
the free quote exactly. The 1h and 4h creates were both charged, both matching their
quoted price to the microdollar, both `create`/`requiresPayment:true`, no
inconsistency there. This directly resolves the task's original "one prior call: zero
cost rows, $0.00 — is data unpriced?" question: **it isn't a documentation gap or a
free-endpoint artifact** (we tested the real paid `/v1/databases` route, not the
free `/price` route) — it's a genuine, reproducible-as-inconsistent split at
specifically the 15-minute tier. We don't know why (possibly a warm/cold
pool-reuse path that skips billing, possibly a rounding/threshold race, possibly an
unrelated routing quirk) — n=2 is not enough to characterize the split rate, only
enough to say it's real and not always-free. Whoever owns Neon provisioning on the
Sapiom side would need to confirm the mechanism.

Both real 15m/4h/1h databases were deleted after creation (best-effort cleanup, not
required — they're ephemeral and auto-expire).

---

## Honesty notes (per instructions)

- Every "flat $X" claim above is n=4 (3 distinct knob values + 1 exact replicate),
  except Neon's real creates (n=2 at 15m, n=1 each at 1h/4h) and Neon's free quotes
  (n=1 each duration, but literal/deterministic pricing-table values, not measured
  variability).
- Zero variance across replicates for Fal, audio, Blaxel, and scrape is itself a
  finding (deterministic flat/linear pricing), stated explicitly rather than implied.
- The Blaxel "flat cost" claim is a measured fact; the underlying "is it actually
  duration-insensitive billing" is a workload-shaped/methodology-limited inference,
  called out as such, not asserted as confirmed mechanism.
- The Neon 15m split is reported as observed (n=2, 1-and-1), not extrapolated into a
  rate or a "%" — there isn't enough data for that.
- No spending rule was paused or restored (none were active); this is disclosed
  rather than silently skipped, since the safety-rail instructions required the
  pre-flight check to run regardless of the expected outcome.

---

## Recommendation for dashboard/findings claim updates

*(Per instructions, this section is a recommendation only — dashboard scope
notes/captions were not edited as part of this task.)*

1. **The existing "LLM-specific, not platform-wide" scope notes on hold/capture-ratio/
   overhang tiles (`_llm_chain_scope_note`, `tile_capital_overhang`,
   `tile_hold_release_latency` in `src/export_dashboard.py`) are now backed by
   affirmative cross-service evidence, not just an absence of data.** Consider
   strengthening the wording from "LLM-specific, not platform-wide" (which reads as
   "we haven't checked elsewhere") to something like "LLM-specific — the other 5
   priced services surveyed (Fal images, ElevenLabs audio, Blaxel compute, Firecrawl
   scrape, Neon data) all settle in a single cost row with no hold/supersede step
   (dryrun/service_hold_survey.md, n=4/service)." This changes the claim from a scope
   *limitation* to a scope *finding*.
2. **Add a short "pricing models across services" note** (new content, not an edit to
   existing captions) somewhere in findings.md/dashboard, summarizing: LLM = chained
   hold-then-settle (the only service with float/overhang economics); Fal images,
   Blaxel compute, Firecrawl scrape = flat per-call regardless of the size/duration
   knobs tested; ElevenLabs audio = flat-per-call but the price itself is a clean
   linear function of character count ($0.00024/char); Neon = flat when charged, plus
   the 15m non-determinism side-finding.
3. **`tile_attribution_completeness`'s existing `unknown` service_name callout**
   (currently framed generically) could cite this survey's scrape evidence (n=4,
   deterministic) as a concrete, reproducible example rather than a one-off residual
   value — strengthens "present, but unresolved" into "present, unresolved, and
   reproducible."
4. **Do not** generalize the LLM float-model machinery (Little's Law, capture ratio,
   instantaneous frozen capital) to any of these 5 services — there is nothing for
   that machinery to measure on them (no hold to be released), so a reader could
   otherwise wrongly assume "float inefficiency" is a platform-wide phenomenon instead
   of an LLM-chaining-specific one.
5. Worth a follow-up ticket (not this task): investigate the Neon 15m
   free/paid non-determinism directly with the Sapiom platform owner — it's a real,
   reproducible-as-inconsistent billing edge case, independent of anything about
   "data calls being unpriced."

---

## Addendum 2: n=10 replication of the 15m split (2026-07-07, later same day)

The n=2 (1 free / 1 charged) 15-minute split above was followed up with 10 more
identical `duration:"15m"` creates (agent `survey-neon-n10`) to turn the anecdote into
a rate. Pooled n=12: **11/12 charged (≈92%), 1/12 free (≈8%)** — the free outcome is
rare, not a coin flip, and the two outcomes are visibly different backend paths (the
free call completed in 1.2s with no payment object at all; every charged call took
5–9s and included a full x402 payment handshake). See
`dryrun/neon_nondeterminism_n10.md` for the pooled table, raw transaction JSON for
both behaviors, hypotheses, and honesty notes (including a correction to this task's
brief, which assumed 4 charged 1h/4h observations where the actual record shows only
2).
