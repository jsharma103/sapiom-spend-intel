# Experiment 01 — Hold Pricing Mechanism & Capture Ratio

**Status:** complete · **Dates:** 2026-07-04 (all paid calls) · **Total cost:** ~$0.005 settled + $0.307 frozen (see §4)
**Audience:** written so a Sapiom engineer can verify every claim against their own backend, or re-run the whole thing from scratch.
**Tenant:** `7234a7f9-4074-4aad-b13f-84e0e28b469a` · **Service under test:** `sapiom_openrouter` (`/v1/chat/completions`, model `openai/gpt-4o-mini` — one model only, see Limits)

---

## 1. Question

When Sapiom authorizes an LLM call, the ledger writes an initial cost row (the **hold**) that is later superseded by a settled row. **What prices the hold?** Three candidates:

- (a) requested `max_tokens` (caller-controlled worst case)
- (b) a platform estimate of likely usage
- (c) actual usage (hold would ≈ settle)

Falsifiable design: fire the **same prompt, same model, same endpoint**, varying **only `max_tokens`**. If (a), holds scale linearly with the cap while settles stay flat. If (b) or (c), holds track output, which is constant across rungs.

**How we read the ledger** (needed to reproduce): for each call, `GET /v1/transactions` (header `User-Agent: curl/8.6.0` required — Cloudflare blocks default agents) → within `costs[]`: hold row = `supersededAt != null`, settled row = `isActive: true`. Balance checks: `GET /v1/accounts` → `totalBalance / availableBalance / unavailableBalance`.

## 2. The ladder — every call fired, with ledger evidence

Prompts are pinned in each script (e.g. hold-linearity rung: *"In exactly two sentences, explain what double-entry bookkeeping is."*). All calls via `@sapiom/fetch` `createFetch({apiKey, agentName})`.

| max_tokens | txn_id | agent | hold_usd | settle_usd | $/1k (hold÷cap) | capture | http | txn outcome | actual_tokens_generated |
|---|---|---|---|---|---|---|---|---|---|
| 100 | `067d5875` | cap-test | *(single row)* | 0.000100 | — | — | 200 | success | *not persisted* |
| 400 | `c518db2c` | cap-test | 0.000243 | 0.000100 | 0.000608 | 41.2% | 200 | success | *not persisted* |
| 900 | `1571544c` | cap-test | 0.000543 | 0.000100 | 0.000603 | 18.4% | 200 | success | *not persisted* |
| 2,000 | `8e64e4c1` | scale-test | 0.001203 | 0.000100 | 0.000602 | 8.3% | 200 | success | *not persisted* |
| 8,000 | `cd3f6739` | scale-test | 0.004803 | 0.000100 | 0.000600 | 2.1% | 200 | success | *not persisted* |
| 16,000 | `fb82db75` | scale-test | 0.009603 | 0.000100 | 0.000600 | 1.0% | 200 | success | *not persisted* |
| 16,000 | `0e7c1a60` | hold-ext-test | 0.009603 | 0.000100 | 0.000600 | 1.0% | 200 | success | *not persisted* |
| 32,000 | `32246a5e` | hold-ext-test | 0.019203 | 0.000100 | 0.000600 | 0.5% | 200 | success | *not persisted* |
| 64,000 | `2db3e090` | hold-ext-test | 0.038403 | 0.000100 | 0.000600 | 0.3% | 200 | success | *not persisted* |
| 128,000 | `d59fb015` | hold-ext-test | 0.076803 | **none — hold froze** | 0.000600 | 0% | **502** | error | *not persisted* |
| 128,000 | `c2c2ef60` | failure-capture-n3-1 | 0.076803 | none — froze | 0.000600 | 0% | 502 | error | *not persisted* |
| 128,000 | `0d248074` | failure-capture-n3-2 | 0.076803 | none — froze | 0.000600 | 0% | 502 | error | *not persisted* |
| 128,000 | `2f8bec77` | failure-capture-n3-3 | 0.076803 | none — froze | 0.000600 | 0% | 502 | error | *not persisted* |

Full UUIDs and timestamps: `dryrun/cap_experiment_result.json`, `dryrun/extrapolation_result.json` (exp A), `dryrun/hold_linearity_result.json` (fetched 2026-07-04T17:53Z), `dryrun/failure_capture_n3_result.json` (18:14Z). Each cost row's `costDetails.paymentTransactionId` links into the payment rails for tracing on your side.

The deliberately empty last column is itself a finding — the ledger never persists usage, and these ladder scripts discarded the response bodies that carried it. "Unknowable" would be wrong: it's *known at call time and dropped* — see §6.

### 2b. Replicate run with full capture (2026-07-07)

Same prompt and model re-fired across the same rungs (100 / 400 / 900 / 2,000 / 8,000 / 16,000 / 64,000 max_tokens) by agent `ladder-usage-replicate`; this run persisted the complete proxied response (body and headers), where §2's original ladder scripts had discarded them.

| max_tokens | completion_tokens (actual) | upstream vendor cost | Sapiom settle | Sapiom hold | hold ÷ vendor cost |
|---|---|---|---|---|---|
| 100 | 63 | $0.00004065 | $0.0001 | (single row) | (single row) |
| 400 | 54 | $0.00003525 | $0.0001 | $0.000243 | 7× |
| 900 | 62 | $0.00004005 | $0.0001 | $0.000543 | 14× |
| 2,000 | 57 | $0.00003705 | $0.0001 | $0.001203 | 32× |
| 8,000 | 69 | $0.00004425 | $0.0001 | $0.004803 | 108× |
| 16,000 | 61 | $0.00003945 | $0.0001 | $0.009603 | 243× |
| 64,000 | 58 | $0.00003765 | $0.0001 | $0.038403 | 1021× |

Requested caps grew 640× from 100 to 64,000 tokens, while actual completions remained constant at 54–70 tokens; every token beyond ~70 in the authorization ceiling was pure frozen float. The 64,000-cap rung held $0.038403 for work whose true vendor cost was $0.00003765, a 1021× multiplier. Source: `dryrun/ladder_usage_result.json`.

**Answer: (a).** `hold = max_tokens × $0.0006/1k`, linear from 100 → 128,000 requested tokens, max deviation **0.03pp** across the ladder. Settles flat at the $0.0001 floor throughout (the ~2-sentence answers never varied). Two corroborations:
- $0.0006/1k = OpenRouter's *public output price* for gpt-4o-mini ($0.60/1M) — the hold prices **every requested token as a worst-case output token**.
- The 100-cap call skipped the hold/settle chain entirely (single cost row) — consistent with a minimum-billing floor short-circuit.

Note: 32k and 64k are ~2–4× past gpt-4o-mini's documented max completion (16,384 tokens; vendor spec, not our measurement). Both were accepted and held in full — **no clamp to what the model can actually produce.**

## 3. Fleet-level result: the capture ratio

Across **all 27 hold→settle chains** in the ingested sample (n=81 txns, one evening — full chain list in Appendix A):

```
Σ held    = $0.027838
Σ settled = $0.004998
capture   = 17.95%   (dollar-weighted)   ·   overhang = 5.57×
```

Reproducible on any account (this is the SQL our pipeline runs against the mirrored ledger; translate to your store as needed):

```sql
WITH multi AS (SELECT transaction_id FROM costs GROUP BY transaction_id HAVING COUNT(*) > 1),
hold  AS (SELECT c.transaction_id, c.fiat_amount h FROM costs c JOIN multi USING(transaction_id)
          WHERE c.superseded_at IS NOT NULL AND c.supersedes_cost_id IS NULL),
final AS (SELECT c.transaction_id, c.fiat_amount f FROM costs c JOIN multi USING(transaction_id)
          WHERE c.superseded_at IS NULL)
SELECT SUM(f)/SUM(h) AS capture_ratio FROM hold JOIN final USING(transaction_id);
```

**Scenario ladder — capture is workload-shaped, not a platform constant:**

| Fleet behavior | Capture | Wallet frozen per $1 settled | Basis |
|---|---|---|---|
| Right-sized caps (p95 of actual usage × buffer) | ~100% | ≈$0 | `analysis/advisor.md` — 79% hold reduction available on this very fleet |
| This test fleet (mixed 400–16k caps) | 18% | $5.57 | measured, 27 chains |
| Blanket 16k caps on short-answer work | ~1.0% | ~$96 | measured rungs (16k rows above) |
| 64k caps | 0.3% | ~$384 | measured rung |
| Over-request + post-hold failure | **0%** | **entire hold, frozen with no release path** | §4 |

Because holds clear in seconds, the *standing* frozen amount is flow × residence time: at $1M/day settled with this fleet's 5.57× overhang and 5.3–12.0s clearing, ≈ **$341–$771 frozen at any instant** (Little's Law — validated live within 9%, `dryrun/ll_validation.md`). The multiplier is entirely in the customer's hands via `max_tokens` — and nothing in the product surfaces that.

Two measured consequences that make cap hygiene more than a float nicety:
- Spending rules evaluate the **hold**, not the settle (`analysis/findings.md` §8) — sloppy caps trigger denials on money never spent.
- Post-hold failures freeze the **full** hold (§4) — sloppy caps set the blast radius of every transient error.

## 4. The 128k break — where linearity ends, dirty

All four 128,000-token calls (one original + three independent replications) followed the same sequence, established from ledger timestamps + client observation:

1. Authorization succeeded — hold **$0.076803** placed (`availableBalance` dropped by exactly that, every time)
2. Upstream execution failed — client saw `502 Bad Gateway`, body `"OpenRouter API error"`; txn `outcome: error`
3. **No supersession ever arrived.** Cost row still `isActive: true, supersededAt: null` — re-verified live 2026-07-07, 3 days later
4. `totalBalance` never moved → not a completed charge. `availableBalance` never recovered → not released. **Frozen: 4/4, $0.076803 each, zero variance.**

Where it broke, as observable from outside: after Sapiom's auth layer (hold landed), inside or beyond the OpenRouter integration. Hypotheses we cannot discriminate without server-side logs, ranked:

- **H1 — context-window collision:** gpt-4o-mini's *total* context is 128k; `max_tokens=128,000` + prompt tokens can't fit, upstream rejects, surfaced as 502. Explains why 64k passed and 128k didn't, and why the failure is dirty rather than a clean `max_tokens too large` 400.
- **H2 — gateway limit** (timeout / payload / internal ceiling) that happens to sit between 64k and 128k.
- **H3 — hold-amount ceiling** in the payment layer. Least likely: the hold *authorized fine*; execution failed after.

⚠️ **Reproduction warning:** each 128k attempt freezes $0.0768 with, as far as we can find, **no release path** — no void/release/DELETE endpoint exists, and no backend sweep has touched these four holds in 3 days (`dryrun/refund_watch.log`, `dryrun/REFUND_WATCH.md`).

## 5. Untested edges (known unknowns)

- **Other models:** everything above is gpt-4o-mini. If hold rate = model output price (§2 corroboration), a gpt-4o fleet holds ~16× more per token, Claude-class more still. One cheap ladder on a second model confirms or kills the pricing hypothesis. *(BACKLOG P0)*
- **Other services:** images/compute/audio are also variable-priced; our 9-service sweep used one tiny request each and saw only flat single-row costs. Never-holds vs too-small-to-trigger — undetermined. *(BACKLOG P0)*
- **Upper bound:** no hold-size cap found through 64k. Whether a single call's hold can exceed `availableBalance` (reject cleanly, or freeze the whole wallet?) is deliberately untested — given §4, the failure mode would be unrecoverable by the account holder.

## 6. The missing column — known at call time, discarded by the ledger

`metadata.model` is null on **all 31** LLM transactions in our sample; `costs[]` carries no token counts. But the data isn't unknowable — it's **dropped**: the LLM call's own HTTP response (which transits Sapiom's proxy) carries the full OpenAI-format `usage` block — `prompt_tokens`, `completion_tokens` — *and* OpenRouter's upstream `cost`. Verified in 8 of our sibling experiments that saved response bodies (e.g. `dryrun/hvs_baseline_result.json`: 20 prompt + 37 completion tokens, upstream cost $0.0000252, Sapiom settle $0.0001). Our ladder scripts in §2 discarded response bodies — hence "not persisted" in that column — but the platform itself sees this data on every call and does not write it to the transaction record.

Consequences:
- Token usage can't be audited **from the ledger** — we back-derived implied tokens by inverting the $0.0006/1k rate (`analysis/advisor.md`), an approximation the ledger forces on everyone downstream.
- No per-model cost attribution, no per-model take-rate audit, no model-mix analytics from ledger data alone — even though the upstream vendor cost per call is right there in the proxied response.
- The one field that *explains hold size* (which model's price × cap) is the one field absent.

A 2026-07-07 replicate run (§2b, `dryrun/ladder_usage_result.json`) persisted the complete wire surface — response body, headers, and HTTP status code — closing this capture gap for the upstream integration.

## 7. Questions for Sapiom engineering

1. Is `hold = max_tokens × model output price` the intended design, and does the formula live in your layer or the OpenRouter integration?
2. Is there a reason not to clamp holds at the model's real completion ceiling (16,384 here)? Today the caller can be held for tokens the model can't physically produce.
3. What actually failed on the four 128k calls (txn ids in §2 — our H1/H2/H3 above)? And is hold-retention the *intended* failure semantics of the x402 `upto` scheme, or should a gateway-level failure release the hold?
4. Is there any release path — sweep, TTL, support action — for the $0.307 frozen on those four transactions? (3 days, no movement.)
5. Why aren't `model` and token usage persisted on the transaction? Your proxy passes the full OpenAI `usage` block (and OpenRouter's upstream cost) through on every response — the ledger drops both. Deliberate, or a gap?

## Appendix A — the 27 chains behind the 17.95%

`fdb23e45`, `945ac7f8` (estimate-test) · `32941e1a`, `615e4c78`, `c76d00ba`, `46efeeb2`, `9c192906`, `241e8d07`, `064e75b2`, `f9bbc36b`, `b7fe399c` (spend-writer) · `c518db2c`, `1571544c` (cap-test) · `8e64e4c1`, `cd3f6739`, `fb82db75` (scale-test) · `c0b714ee`, `33b3cf16`, `a4099ae6`, `581b9664`, `b95f8823`, `d87ad117`, `8cf1ecba`, `81b6d3ee`, `41b1e9c0`, `8e9a32ad` (fleet-test) · `e15848db` (chain-task)

(8-char prefixes; full UUIDs in `data/spend.duckdb` `transactions` table and the result JSONs.)

## Appendix B — reproduce from scratch

- **Environment:** Node ≥20 (`--env-file` support), `@sapiom/fetch` (repo-pinned version in `package-lock.json`), `SAPIOM_API_KEY` (standard `sk_live_`, default permissions — same key does paid calls AND governance/ledger reads). Governance/ledger GETs need header `User-Agent: curl/8.6.0`.
- **Budget:** ~$0.01 settled for the full 100→64k ladder; **plus $0.0768 frozen per 128k attempt (unrecoverable — see §4 warning)**. Guard pattern (balance pre-check, per-run cap) in every script.
- **Scripts, in order:** `dryrun/cap_experiment.js` (100/400/900) → `dryrun/extrapolation_experiment.js` (2k/8k/16k + the 10-way concurrency float check) → `dryrun/hold_linearity_extension_experiment.js` (16k→128k) → `dryrun/failure_capture_n3_experiment.js` (128k ×3). Run: `node --env-file=.env dryrun/<script>`.
- **Expected replication tolerance:** hold ÷ max_tokens = $0.0006/1k ± 1%; settle = $0.0001 for ~2-sentence outputs; 128k behavior may differ if the upstream cause (§4 H1–H3) has changed — that difference would itself be informative.
- **Shortcut for Sapiom engineers:** skip all of it — pull the txn ids in §2 from your own backend; the server-side trace of `d59fb015-f55f-4501-a3cb-247b6e091366` answers §7 Q3 directly.
