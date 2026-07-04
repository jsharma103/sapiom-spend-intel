# Take Rate — full 9-service table

NOT shown on dashboard — vendor-list-price ≠ Sapiom COGS assumption too weak to display.

Payments-executive framing: Sapiom is a payment/settlement layer sitting between an agent
and 9 underlying vendor APIs. Every call Sapiom settles has two prices we can observe — the
**vendor's published retail list price** and **what Sapiom charges the agent** (settled cost
in the ledger). The spread between those two is what this document computes below.

**Read the CAVEAT section before treating that spread as a "take rate."** We do not know
Sapiom's actual cost (it likely pays less than vendor retail on volume), and Sapiom publishes
no price list of its own to reconcile against — so, strictly, this document measures
vendor-retail vs. Sapiom-retail (a build-vs-buy question), not Sapiom's margin over its own
COGS (the actual definition of a take rate). See the **CAVEAT** section near the bottom for
the full explanation before quoting any number here as Sapiom's margin.

Source data: `dryrun/service_sweep_result.json` (ranAt 2026-07-04T10:48:40Z), one real
charged call per service, `actualCostUsd` = amount Sapiom actually settled. Vendor prices
below are each service's public list price for the **exact operation performed** (same
model/size/depth/character count as the sweep request), pulled from the vendor's own
pricing page (web research, zero API spend).

**N is not uniformly 1.** The sweep itself is one call per service, but the **search**
(Linkup) row can be checked against every historical Linkup transaction in the ledger, not
just the sweep call — see the footnote on that row. The other three HIGH rows (llm, images,
audio) are genuinely N=1: no other `sapiom_openrouter`/`sapiom_fal`/`sapiom_elevenlabs`
transaction in `spend.duckdb` was run with the identical request shape (same
tokens/size/character-count) needed for an apples-to-apples markup calc, so they cannot be
corroborated the same way without spending more money.

## Method

For each of the 9 swept services: identify the underlying vendor + the exact operation
(model, size, depth, character/token count); find that vendor's public list price for the
same operation; `markup % = (sapiom_charged − vendor_public) / vendor_public`. Confidence:
- **HIGH** — operation matched exactly (same model/params), vendor price stated in USD per
  unit with no plan-tier ambiguity.
- **MED** — operation matched, but the vendor's per-unit price varies by Sapiom's (unknown)
  subscription tier — shown with a range.
- **DROP** — no clean apples-to-apples price exists (missing a required parameter, or the
  call was never actually charged) — excluded from the table and the dashboard, listed in
  the appendix instead.

## Main table (HIGH + MED — used for the dashboard / blended rate)

| Service | Provider | Operation (exact) | Sapiom charged | Vendor public price | Markup | Confidence | Source |
|---|---|---|---|---|---|---|---|
| search | Linkup | 1 query, `depth=standard`, `outputType=sourcedAnswer` | $0.006000 | $0.006000 ($5/1k standard + $1/1k sourcedAnswer premium = $6/1k) | +0.0% (1.00×) — **N=43**¹ | HIGH | [Linkup pricing docs](https://docs.linkup.so/pages/documentation/platform/pricing) |
| llm | OpenRouter (`openai/gpt-4o-mini`) | 14 prompt + 2 completion tokens | $0.000100 | $0.0000033 (14×$0.15/1M + 2×$0.60/1M — matches OpenRouter's own embedded `usage.cost_details.upstream_inference_cost` in the response) | **+2,930.3%** (30.30×) | HIGH | [OpenRouter gpt-4o-mini pricing](https://openrouter.ai/openai/gpt-4o-mini) |
| images | Fal.ai (`fal-ai/flux/schnell`) | 1 image, `image_size=square` → confirmed 512×512 output (0.262 MP, rounds up to 1 MP) | $0.003000 | $0.003000 ($0.003/MP, billed rounding up to nearest MP) | +0.0% (1.00×) | HIGH | [fal-ai/flux/schnell model page](https://fal.ai/models/fal-ai/flux/schnell) |
| audio | ElevenLabs (`eleven_multilingual_v2`) | text-to-speech, 3 characters ("Hi.") | $0.001000 | $0.000300 ($0.10 / 1,000 chars × 3 chars) | +233.3% (3.33×) | HIGH | [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) |
| scraping | Firecrawl | 1 page scrape, `formats=[markdown]`, `creditsUsed=1` (confirmed in response metadata) | $0.009000 | $0.00083/page at Standard-plan credit rate (range across plans: $0.0006/pg Scale → $0.0032/pg Hobby — Sapiom's plan tier is unknown, so exact vendor cost is ambiguous) | +984.3% at Standard-plan reference (range: +181.2% to +1,400.0% across plans) — **plan tier unknown, do not headline this number** | MED | [Firecrawl pricing](https://www.firecrawl.dev/pricing) |

¹ **N=43, not N=1** — upgraded from the sweep's self-stated N=1 (adversarial-audit fix). Every
one of the 43 `sapiom_linkup` transactions in the ledger has exactly one active cost row, and
every one of those 43 rows is exactly $0.006000000000000000 — zero variance, zero other
amounts. Read-only, reproducible against `spend.duckdb`:
```sql
SELECT c.fiat_amount, count(*) AS n
FROM transactions t JOIN costs c ON c.transaction_id = t.id
WHERE t.service_name = 'sapiom_linkup' AND c.is_active = true
GROUP BY c.fiat_amount;
-- => 0.006000000000000000 | 43   (one row, one amount, one confidence: HIGH)
```
This is the only row in the table with N > 1 corroboration. The other three HIGH rows (llm,
images, audio) are genuinely N=1 in the ledger too — `sapiom_fal` and `sapiom_elevenlabs` each
have exactly one active cost row total, and none of `sapiom_openrouter`'s 31 transactions
share the sweep's exact 14-prompt/2-completion-token shape needed for an apples-to-apples
markup recompute without spending more money.

**Blended take rate (HIGH-confidence rows only — search, llm, images, audio):**

- Σ Sapiom charged = $0.006000 + $0.000100 + $0.003000 + $0.001000 = **$0.010100**
- Σ vendor public = $0.006000 + $0.0000033 + $0.003000 + $0.000300 = **$0.009303**
- Margin = $0.010100 − $0.009303 = **$0.000797**
- **Blended take rate (margin ÷ Sapiom-charged TPV, Adyen-style)** = 0.000797 / 0.010100 = **7.89% ≈ 789 bps**
- (Supporting figure) blended markup over vendor cost (margin ÷ vendor cost) = 0.000797 / 0.009303 = **8.56% ≈ 856 bps**

**789/856 bps is NOT a defensible headline — it is derived entirely from the two
floor-artifact rows.** Per the margin-share table below, 100% of the $0.000797 blended
margin comes from `llm` (~12%) and `audio` (~88%) — the two rows flagged as near-certain
minimum-billing-floor artifacts, not real percentage markups. `search` and `images`, the two
real-dollar-volume rows, each contribute exactly $0 to that margin. A single blended bps
number built entirely out of floor artifacts is not a statistically-grounded unit-economics
read, and it is N=1 per service on top of that. This blended figure is kept here only as
backing arithmetic/audit-trail for the dashboard's Take Rate tile — the dashboard itself does
not show 789/856 bps as a headline number (adversarial-audit fix) — see "Notable finding"
below, which corrects an earlier factual error in this same section (and in `NARRATIVE.md`)
about *which* row drives the blended margin.

The two numbers answer different questions: 789 bps is "what fraction of every settled
dollar is Sapiom's margin" (the payments take-rate framing); 856 bps is "how much extra
do you pay vs. buying the same operation direct from the vendor." Both are dollar-weighted
across the 4 HIGH rows, not a simple average of the 4 percentages (a simple average of
0%, 2930%, 0%, 233% would be dominated by the single tiny LLM call and is not shown).

**Margin share by row (recomputed directly from this table):**

| Service | Margin $ | Share of $0.000797 blended margin |
|---|---:|---:|
| search (Linkup) | $0.000000 | 0% |
| llm (OpenRouter) | $0.0000967 | **~12%** |
| images (Fal.ai) | $0.000000 | 0% |
| audio (ElevenLabs) | $0.0007000 | **~88%** |

**Notable finding:** two of four HIGH-confidence services (Linkup search, Fal.ai images)
settle at **exactly** vendor list price — 0% markup, i.e. Sapiom is not marking up the
compute-heavy, larger-dollar services in this sample. The entire blended margin comes from
the other two rows (llm, audio) — but **not evenly, and not mostly from the LLM row**: per
the table above, audio/ElevenLabs contributes ~88% of the blended margin and llm/OpenRouter
contributes ~12%. (**Correction:** an earlier version of this document, and `NARRATIVE.md`,
claimed the opposite — that the blended margin was "driven almost entirely" by the LLM row.
That was backwards; this section and `NARRATIVE.md` are both corrected.) Both floor-artifact
rows are very likely a **per-call minimum-billing floor** rather than a percentage markup:
llm's $0.0001 charged against a $0.0000033 real cost, and audio's $0.0010 charged against a
$0.0003 real cost, are both suspiciously round numbers consistent with a ledger that rounds
any settlement below some floor up to a fixed minimum. That would explain why a $0.0000033
call reads as 30× "marked up" and a $0.0003 call reads as 3.3× "marked up" while a $0.006 or
$0.003 call isn't marked up at all. Worth confirming directly with Sapiom before quoting
either 2,930% or 233% publicly as if they were real percentage margins — both are
arithmetically correct on this one sample (N=1 per service) but are minimum-fee artifacts,
not genuine percentage-of-value margins.

## CAVEAT — this table is build-vs-buy, not Sapiom's true take rate

Every "vendor public price" in this document is the vendor's **published retail list price**
— the rate anyone signing up today would pay for that exact operation. It is **not**
Sapiom's actual cost basis (COGS). Sapiom is very likely a large enough buyer to negotiate
volume/committed-spend discounts below retail with these vendors (this is normal for any
API-reseller/aggregator business) — if so, Sapiom's real spread over its own cost is smaller
than every number in this table, and we have no way to know by how much from public data.

We also checked whether Sapiom publishes its **own** per-call/per-operation pricing
anywhere in its docs or marketing site, which would let us reconcile this table against
Sapiom's stated numbers instead of guessing — **it does not.** No such price list exists
publicly as of this writing.

The practical consequence: everything in this document answers "if an agent bought this
operation directly from the vendor at list price instead of through Sapiom, would it pay
more or less?" — a **build-vs-buy** question, useful on its own terms. It does **not** answer
"what is Sapiom's margin over its own cost?" — the actual definition of a take rate. Calling
this table "Sapiom's take rate" to a payments audience is a category error: a real take rate
is measured against the seller's own COGS, not against a public retail price the seller may
never actually pay. Read every "markup %"/"spread" figure in this document as **vendor-retail
vs. Sapiom-retail**, not **Sapiom-COGS vs. Sapiom-retail**.

## Appendix — excluded rows (DROP / not charged)

| Service | Provider | Why excluded |
|---|---|---|
| compute | Blaxel | Charged $0.000690 for a 418ms `print(1)` Python execution. Blaxel's public pricing is per **GB-second** ($0.0000115/GB·s per [blaxel.ai/pricing](https://blaxel.ai/pricing)), but the sweep response never discloses the memory tier the sandbox ran at (docs confirm CPU/price scale with memory but the run response has no memory field). Any vendor-cost number requires *guessing* a memory tier — that is fudging an apples-to-oranges comparison, so this row is dropped rather than estimated. |
| data | Neon | `requestBody.duration=15m` returned a **price quote** (`responseSample.price = "$0.000001"`), not an actual settlement — `charged: false`, `actualCostUsd: null` in the sweep. No Sapiom-side dollar amount exists to compare against, so there is nothing to take a rate on. |
| messaging | QStash | `keyWorks: "SKIPPED"` — the sweep target (`not-a-valid-destination`) was intentionally invalid; `httpStatus: null`, `charged: false`. No real operation was performed. |
| verify | Prelude | `keyWorks: "SKIPPED"` — the sweep target was a fake phone number; `httpStatus: null`, `charged: false`. No real operation was performed. |

## Reproducing this table

```
jq -c '.results[] | {service, provider, requestBody, charged, actualCostUsd}' dryrun/service_sweep_result.json
```

Vendor prices are cited inline above with source URLs; the LLM row's vendor cost is also
independently confirmed by the sweep response itself
(`usage.cost_details.upstream_inference_cost = 0.0000033`, embedded by OpenRouter). Note:
`responseSample` for the `llm` row is truncated mid-string in the stored JSON file (the
sweep script caps sample length) — `prompt_tokens: 14`, `completion_tokens: 2`, and
`cost_details.upstream_inference_cost: 0.0000033` all appear intact before the truncation
point; verify with `jq -r '.results[] | select(.service=="llm") | .responseSample' dryrun/service_sweep_result.json`.
