# Take Rate — full 9-service table

Payments-executive framing: Sapiom is a payment/settlement layer sitting between an agent
and 9 underlying vendor APIs. Every call Sapiom settles has two prices — what the vendor
charges Sapiom (public list price) and what Sapiom charges the agent (settled cost in the
ledger). The spread is Sapiom's take rate, same concept as a card network's blended bps.

Source data: `dryrun/service_sweep_result.json` (ranAt 2026-07-04T10:48:40Z), one real
charged call per service, `actualCostUsd` = amount Sapiom actually settled. Vendor prices
below are each service's public list price for the **exact operation performed** (same
model/size/depth/character count as the sweep request), pulled from the vendor's own
pricing page (web research, zero API spend).

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
| search | Linkup | 1 query, `depth=standard`, `outputType=sourcedAnswer` | $0.006000 | $0.006000 ($5/1k standard + $1/1k sourcedAnswer premium = $6/1k) | +0.0% (1.00×) | HIGH | [Linkup pricing docs](https://docs.linkup.so/pages/documentation/platform/pricing) |
| llm | OpenRouter (`openai/gpt-4o-mini`) | 14 prompt + 2 completion tokens | $0.000100 | $0.0000033 (14×$0.15/1M + 2×$0.60/1M — matches OpenRouter's own embedded `usage.cost_details.upstream_inference_cost` in the response) | **+2,930.3%** (30.30×) | HIGH | [OpenRouter gpt-4o-mini pricing](https://openrouter.ai/openai/gpt-4o-mini) |
| images | Fal.ai (`fal-ai/flux/schnell`) | 1 image, `image_size=square` → confirmed 512×512 output (0.262 MP, rounds up to 1 MP) | $0.003000 | $0.003000 ($0.003/MP, billed rounding up to nearest MP) | +0.0% (1.00×) | HIGH | [fal-ai/flux/schnell model page](https://fal.ai/models/fal-ai/flux/schnell) |
| audio | ElevenLabs (`eleven_multilingual_v2`) | text-to-speech, 3 characters ("Hi.") | $0.001000 | $0.000300 ($0.10 / 1,000 chars × 3 chars) | +233.3% (3.33×) | HIGH | [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) |
| scraping | Firecrawl | 1 page scrape, `formats=[markdown]`, `creditsUsed=1` (confirmed in response metadata) | $0.009000 | $0.00083/page at Standard-plan credit rate (range across plans: $0.0006/pg Scale → $0.0032/pg Hobby — Sapiom's plan tier is unknown, so exact vendor cost is ambiguous) | +984.3% at Standard-plan reference (range: +181.2% to +1,400.0% across plans) | MED | [Firecrawl pricing](https://www.firecrawl.dev/pricing) |

**Blended take rate (HIGH-confidence rows only — search, llm, images, audio):**

- Σ Sapiom charged = $0.006000 + $0.000100 + $0.003000 + $0.001000 = **$0.010100**
- Σ vendor public = $0.006000 + $0.0000033 + $0.003000 + $0.000300 = **$0.009303**
- Margin = $0.010100 − $0.009303 = **$0.000797**
- **Blended take rate (margin ÷ Sapiom-charged TPV, Adyen-style)** = 0.000797 / 0.010100 = **7.89% ≈ 789 bps**
- (Supporting figure) blended markup over vendor cost (margin ÷ vendor cost) = 0.000797 / 0.009303 = **8.56% ≈ 856 bps**

The two numbers answer different questions: 789 bps is "what fraction of every settled
dollar is Sapiom's margin" (the payments take-rate framing); 856 bps is "how much extra
do you pay vs. buying the same operation direct from the vendor." Both are dollar-weighted
across the 4 HIGH rows, not a simple average of the 4 percentages (a simple average of
0%, 2930%, 0%, 233% would be dominated by the single tiny LLM call and is not shown).

**Notable finding:** two of four HIGH-confidence services (Linkup search, Fal.ai images)
settle at **exactly** vendor list price — 0% markup, i.e. Sapiom is not marking up the
compute-heavy, larger-dollar services in this sample. The entire blended margin comes from
the LLM row: $0.0001 charged against a $0.0000033 real cost is very likely a **per-call
minimum-billing floor** ($0.0001 = 1/100th of a cent, a suspiciously round number) rather
than a percentage markup — Sapiom's ledger probably rounds any settlement below some floor
up to $0.0001. That would explain why a $0.0000033 call becomes 30× "marked up" while a
$0.006 call isn't marked up at all. Worth confirming directly with Sapiom before quoting
2,930% publicly — it is arithmetically correct on this one sample but is a minimum-fee
artifact, not a genuine percentage-of-value margin.

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
