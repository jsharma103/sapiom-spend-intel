# Experiment 03 — Governance Cumulative Double-Counts Settled History

**Status:** complete · **Dates:** 2026-07-07 (all paid calls) · **Total cost:** ~$0.004 settled + two frozen denied-holds ($0.002403 + $0.000243)
**Audience:** written so a Sapiom engineer can verify against their own backend, or re-run from scratch.
**Tenant:** `7234a7f9-4074-4aad-b13f-84e0e28b469a` · **Rule engine:** `usage_limit` / `sum_transaction_costs`, scoped per-agent via `agentIds`, `measurementScope: "rule"` · **Service:** `sapiom_openrouter`

---

## 1. Question

A `usage_limit` spending rule caps an agent's cumulative cost over a rolling window. **Does the cumulative count each transaction's cost correctly?**

Two falsifiable hypotheses, and a design that forces them apart:

- **NO BUG (correct sum):** at call *K*, the rule sees `cumulative = (K-1)·settled + this_call_hold`. Denies when that crosses the limit.
- **BUG (2× settled history):** the cumulative double-counts settled history — `cumulative = 2·(K-1)·settled + this_call_hold`.

The two predict denial at **far-apart call numbers** (see §3), so this is a discriminating test, not a curve fit.

**How we read the ledger** (needed to reproduce): `GET /v1/transactions?page[limit]=100&sort=-created_at` (header `User-Agent: curl/8.6.0` — Cloudflare blocks default agents). Per transaction: `authorizationRequests[]` carries `status` and, on a denial, `ruleExecutions[].outputData` with `decision`, `reason`, and `metadata.violations[].currentValue` — **the engine's own cumulative number**. A settled cost = the `isActive` cost row; a hold = the `supersededAt != null` row. Rules were created over the undocumented REST governance surface (`dryrun/governance_api_probe.md`); `measurementScope: "rule"` isolates the sum to the rule's own scope (the default `"all"` sums tenant-wide — a separate footgun, `analysis/findings.md` §8).

## 2. Point 1 — the boundary observation

Agent `r5-boundary-agent` (`a376c0cb`), rule `r5-boundary-rule` (`f5759057`), **limit $0.005**, `max_tokens=4000` (hold $0.002403, settle $0.0001). 13 sequential calls allowed (4.5s gaps — no concurrency, so no TOCTOU contamination), 14th denied. Every row below is a real ledger transaction.

| call | result | hold | settle | true history | no-bug (H+hold) | **BUG (2H+hold)** | vs $0.005 |
|---|---|---|---|---|---|---|---|
| 1 | ok | 0.002403 | 0.0001 | 0.000000 | 0.002403 | 0.002403 | |
| 2 | ok | 0.002403 | 0.0001 | 0.000100 | 0.002503 | 0.002603 | |
| 3 | ok | 0.002403 | 0.0001 | 0.000200 | 0.002603 | 0.002803 | |
| 4 | ok | 0.002403 | 0.0001 | 0.000300 | 0.002703 | 0.003003 | |
| 5 | ok | 0.002403 | 0.0001 | 0.000400 | 0.002803 | 0.003203 | |
| 6 | ok | 0.002403 | 0.0001 | 0.000500 | 0.002903 | 0.003403 | |
| 7 | ok | 0.002403 | 0.0001 | 0.000600 | 0.003003 | 0.003603 | |
| 8 | ok | 0.002403 | 0.0001 | 0.000700 | 0.003103 | 0.003803 | |
| 9 | ok | 0.002403 | 0.0001 | 0.000800 | 0.003203 | 0.004003 | |
| 10 | ok | 0.002403 | 0.0001 | 0.000900 | 0.003303 | 0.004203 | |
| 11 | ok | 0.002403 | 0.0001 | 0.001000 | 0.003403 | 0.004403 | |
| 12 | ok | 0.002403 | 0.0001 | 0.001100 | 0.003503 | 0.004603 | |
| 13 | ok | 0.002403 | 0.0001 | 0.001200 | 0.003603 | 0.004803 | |
| **14** | **DENIED** | 0.002403 *(frozen)* | — | 0.001300 | 0.003703 | **0.005003** | **OVER** |

Denied txn `c5d06c38`; engine `violations[].currentValue = 0.005003`, matching the **BUG** column to the micro-dollar. The **no-bug** column never reaches $0.005 — with correct math, call 14 is allowed and the agent would run to ~call 27. True footprint at denial: **$0.003703 (74% of the limit)** — denied over money it hadn't spent.

Every transaction carries exactly **2 `authorizationRequests`** — the structural fan-out (see §4).

## 3. Point 2 — the discriminating out-of-sample confirmation

Point 1 fit one boundary. To rule out coincidence, a **cold-start** run at a *different* `(max_tokens, limit)`, with the denial call **predicted in advance**:

Agent `doublecount-confirm-agent` (`5f6e9cb5`), rule `doublecount-confirm-rule` (`d55f4abc`), **limit $0.004**, `max_tokens=400` (hold $0.000243, settle $0.0001). Predictions:

- **BUG** → denies at call **20** (`2·19·0.0001 + 0.000243 = 0.004043 > 0.004`)
- **NO BUG** → denies at call **39** (`19·0.0001 + 0.000243` doesn't cross $0.004 until ~call 39)

19 calls apart — no overlap. **Observed: denied at call 20.**

| call | result | true history | no-bug (H+hold) | **BUG (2H+hold)** | vs $0.004 |
|---|---|---|---|---|---|
| 1 | ok | 0.000000 | 0.000243 | 0.000243 | |
| 2 | ok | 0.000100 | 0.000343 | 0.000443 | |
| 3 | ok | 0.000200 | 0.000443 | 0.000643 | |
| 4 | ok | 0.000300 | 0.000543 | 0.000843 | |
| 5 | ok | 0.000400 | 0.000643 | 0.001043 | |
| 6 | ok | 0.000500 | 0.000743 | 0.001243 | |
| 7 | ok | 0.000600 | 0.000843 | 0.001443 | |
| 8 | ok | 0.000700 | 0.000943 | 0.001643 | |
| 9 | ok | 0.000800 | 0.001043 | 0.001843 | |
| 10 | ok | 0.000900 | 0.001143 | 0.002043 | |
| 11 | ok | 0.001000 | 0.001243 | 0.002243 | |
| 12 | ok | 0.001100 | 0.001343 | 0.002443 | |
| 13 | ok | 0.001200 | 0.001443 | 0.002643 | |
| 14 | ok | 0.001300 | 0.001543 | 0.002843 | |
| 15 | ok | 0.001400 | 0.001643 | 0.003043 | |
| 16 | ok | 0.001500 | 0.001743 | 0.003243 | |
| 17 | ok | 0.001600 | 0.001843 | 0.003443 | |
| 18 | ok | 0.001700 | 0.001943 | 0.003643 | |
| 19 | ok | 0.001800 | 0.002043 | 0.003843 | |
| **20** | **DENIED** | 0.001900 | 0.002143 | **0.004043** | **OVER** |

Denied txn `eb9f1f01`; engine `currentValue = 0.004043` — the **BUG** column, exact. Engine believed **38** history calls existed; **19** did. True footprint at denial: **$0.002143 (54% of the limit).**

**Two independent points — different `max_tokens`, different limit, both cold-start, both predicted in advance — fit `2·history + hold` to the micro-dollar. The doubling is systematic.**

## 3b. Third-party corroboration — blast-test agents (different session)

A parallel session left three `blast-test-*` agents in the ledger, each under a separate $0.002 `usage_limit` rule, with different `max_tokens` — an independent reproduction we did not run. Reading their ledger traces:

| agent | max_tokens | hold | allowed | true spend at denial | engine currentValue | fit `2·hist + hold` |
|---|---|---|---|---|---|---|
| blast-test-500 | 500 | $0.000302 | 9 | $0.001202 | **0.002102** | 2·(9·0.0001)+0.000302 = **0.002102** ✓ |
| blast-test-2000 | 2000 | $0.001202 | 4 | $0.001602 | **0.002002** | 2·(4·0.0001)+0.001202 = **0.002002** ✓ |
| blast-test-8000 | 8000 | $0.004802 | 0 | — | 0.004802 | denied on call 1 (hold alone > limit) |

Two more exact micro-dollar fits, at `max_tokens` we never used, from a different operator — the double-count now reproduces across **6+ configurations by two independent sessions**. (Caveat: read from the ledger, not run by us; the parallel session's own result files, if on disk, would confirm intent.)

**Consequence — the "blast radius" of a budgeted agent collapses into this bug + hold pricing:**
- Small caps (blast-test-500): the agent is stopped at ~$0.0012 true spend against a $0.002 limit — **≈ limit/2**, because of the double-count.
- **Large caps (blast-test-8000): the agent is stopped at $0 — denied on its very first call.** Its single pre-auth hold ($0.004802) alone exceeds the $0.002 budget, so it cannot make one call, and that denied hold froze (experiment 02). A customer who sets a small agent budget and generous `max_tokens` gets an agent that **cannot operate at all** — the budget prevents operation rather than limiting spend.

## 4. Root cause (as far as observable from outside)

The over-count equals exactly one extra copy of the **settled history** (not the current call's hold — `2×(history+hold)` would give $0.007406 at Point 1, not the observed $0.005003). The current call is added once; prior settled calls are counted twice.

The structural signal is in every table row: **each transaction carries 2 `authorizationRequests`** (confirmed independently in `dryrun/r3_idempotency_result.json` — the SDK's x402 flow does a `POST /transactions` then a `POST /transactions/{id}/reauthorize`, each materializing an authorization request). A cumulative-cost query that joins transactions to their authorization requests — or otherwise walks auth requests — fans out 2× per historical transaction. The phrasing of the denial reason (*"Total transaction costs **including this transaction**"*) is consistent with history being summed via the fan-out while the current transaction is added as a separate single term.

We cannot see the query — this is the mechanism the external evidence points to, for you to confirm against the actual implementation.

## 5. Consumer impact

- A `usage_limit` budget of $X halts real spend at **≈ $X/2** of settled cost. Budgets deplete twice as fast as configured.
- Combined with the hold-not-settlement finding (`analysis/findings.md` §8 — rules evaluate the current call's *hold*, not its settlement), the effective budget in real settled dollars is **≈ (limit − current_hold) / 2**.
- This directly undermines "bounded": the bound a customer sets is not the bound they get, and the gap is not conservative in a predictable direction they'd expect.
- Denial-after-hold: the denied call's own hold still freezes (Point 1 call 14: $0.002403 unavailable). Denial does not prevent the freeze — see `dryrun/denial_analytics.md` ($0.221 frozen across 85 denied-call holds, none released).

## 6. Secondary finding — denial reason unusable at sub-cent limits

Point 2's denial `reason` string: *"Total transaction costs including this transaction (0.00 USD) would exceed limit of 0.00 USD in 1 days"* — the human-readable message rounds both the cumulative and the limit to `$0.00` at this scale, and additionally renders the limit doubled at Point 1 (*"0.01 USD"* for a $0.005 rule). The trustworthy number lives only in the structured `violations[].currentValue`; the display layer both rounds and doubles.

## 7. Questions for Sapiom engineering

1. Does the `usage_limit` cumulative query count each historical transaction once, or once per `authorizationRequest`? Two points (txns `c5d06c38`, `eb9f1f01`) show the engine's `currentValue` at exactly `2×settled_history + current_hold`.
2. Is enforcing on `2×history + current_hold` intended, or should the cumulative equal true settled spend? As measured, a usage_limit denies at ~half its configured value.
3. The denial `reason` string rounds to `$0.00` at sub-cent limits and shows a doubled limit at $0.005 — is the string computed separately from the structured `violations`? Which is authoritative for enforcement?
4. Does the doubling scale with the number of authorization requests per transaction (2 here)? Would a transaction that reauthorizes N times count its cost N× in later cumulatives?

## Appendix — reproduce

- **Environment:** Node ≥20, `@sapiom/fetch` (repo-pinned), `SAPIOM_API_KEY` (standard `sk_live_`, default permissions — same key does paid calls, ledger reads, AND governance writes). Governance/ledger GETs need `User-Agent: curl/8.6.0`.
- **Budget:** ~$0.002 settled per run + one frozen denied-hold (unrecoverable — no release endpoint, see experiment 02). Both scripts self-guard (balance pre-check, `MAX_CALLS` hard stop, sequential 4.5s gaps to avoid TOCTOU, rule paused in `finally`).
- **Scripts:** `dryrun/r5_boundary.js` + `dryrun/r5_boundary2.js` (Point 1), `dryrun/r5_doublecount_confirm.js` (Point 2 — self-scoring: predicts both denial calls, writes a `verdict`). Run: `node --env-file=.env dryrun/<script>`. Raw: `dryrun/r5_boundary_result.json`, `dryrun/r5_boundary2_result.json`, `dryrun/r5_doublecount_confirm_result.json`.
- **Independent corroboration on disk:** a parallel session left `doublecount-fast` / `doublecount-slow` agents (each 20 auth requests, 1 denial) in the ledger and `denial_analytics.md` — cross-check before quoting externally.
- **Shortcut for Sapiom engineers:** skip reproduction — pull denied txns `c5d06c38` (currentValue 0.005003, true 0.003703) and `eb9f1f01` (currentValue 0.004043, true 0.002143) in your backend; compare the rule engine's summed cost against the agent's true settled history (13 and 19 calls respectively) to see the 2× directly.
