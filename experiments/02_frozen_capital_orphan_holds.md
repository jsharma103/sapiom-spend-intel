# Experiment 02 — Frozen Capital: Orphan Holds That Never Release

**Status:** complete · **Dates:** 2026-07-04 → 2026-07-07 (live re-verified) · **Frozen at write time:** $0.528502 (11.2% of a $4.707228 wallet)
**Audience:** written so a Sapiom engineer can verify against their own backend, or re-run from scratch.
**Tenant:** `7234a7f9-4074-4aad-b13f-84e0e28b469a` · **What this is:** money in a third state — not charged, not returned.

---

## 1. Question

Zerbib's public framing says agent-payment failures must be *bounded, visible, and recoverable*. **When a hold is placed and the transaction does not reach clean settlement, does the hold release?**

Falsifiable: poll the account and the specific transactions over days. Recovery = the held amount returns to `availableBalance` (or the cost row supersedes/clears). Failure = the hold stays `isActive`, `availableBalance` stays depressed, indefinitely.

**How we read it** (to reproduce): `GET /v1/accounts` → the wallet splits four ways, `totalBalance / availableBalance / unavailableBalance / pendingCreditBalance`. **`unavailableBalance` is the frozen total, exposed directly.** Per transaction: `GET /v1/transactions/{id}` (or the list endpoint for `authorizationRequests`); a live hold = a cost row with `isActive: true`, `supersededAt: null`, `costDetails.source: "payment_transaction"`.

## 2. The headline

As of 2026-07-07, live: **`unavailableBalance` = $0.528502, and it ties to the penny across two independent freeze paths:**

| Path | trigger | count | frozen | released in 3 days |
|---|---|---|---|---|
| **Crash-after-hold** | call places hold, then upstream 502s | 4 | $0.307212 | 0 |
| **Deny-after-hold** | rule places hold, then denies the call | 85 | $0.221290 | 0 |
| | | **89 holds** | **$0.528502** | **0** |

`$0.307212 + $0.221290 = $0.528502 = unavailableBalance` exactly. Both paths end in the same state: the hold's cost row is `isActive: true`, `totalBalance` never moved (not a charge), `availableBalance` dropped (not usable). Neither path has released a single hold across 3 days of polling (`dryrun/refund_watch.log`). No void/release/DELETE endpoint exists on transactions or their costs.

**The unifying mechanism:** any hold whose transaction does not reach clean settlement is **orphaned** — left `isActive` forever. Crash and denial are two triggers of the one orphan-hold bug.

## 3. Path A — crash-after-hold (the involuntary case)

Four `max_tokens=128000` calls (experiment 01 §4) each authorized a $0.076803 hold, then hit a `502 Bad Gateway` from OpenRouter *after* the hold was placed. Outcome `error`, but the hold never superseded to a settlement or a release. `availableBalance` dropped by exactly $0.076803 each time; `totalBalance` never moved. 4/4, zero variance.

Txn ids: `d59fb015`, `c2c2ef60`, `0d248074`, `2f8bec77`. Still `isActive: true`, re-verified live 2026-07-07 — 3 days frozen. Raw: `dryrun/failure_capture_n3_result.json`, `dryrun/hold_linearity_result.json`, `dryrun/refund_watch.log`.

This is the involuntary, organic-shaped case: a transient upstream error strands the caller's money. Its frequency in real traffic is unmeasured (all four were forced via oversized `max_tokens`), but the *mechanic* — a post-hold execution failure does not release the hold — is deterministic.

## 4. Path B — deny-after-hold (the governance case)

The 85 frozen denied-holds all came from our own experiment spending rules (TOCTOU race 74, hold-vs-settlement 5, blast-radius 3, double-count 3 — all `usage_limit` denials, "would exceed limit"). **A denial is expected behavior — a rule saying no. The bug is that the denial leaves a hold frozen behind it.**

### 4.1 Why a *denied* call freezes money — the timeline

A correct system denies *before* placing a hold, or rolls the hold back on denial. This does neither. Every denied transaction carries **two authorization requests**; the hold is placed between them and orphaned when the second denies. Traced on two independent experiments:

**Txn `eb9f1f01`** (double-count rule, 2026-07-07):

| time | event |
|---|---|
| 32.158 | transaction created |
| 32.309 | **auth check #1 → ALLOWED** (budget OK at this instant) |
| 33.481 | **hold placed — $0.000243** + auth check #2 created |
| 33.622 | **auth check #2 → DENIED** (`currentValue 0.004043`) |

**Txn `ee579f2c`** (TOCTOU race rule, 2026-07-04 — 3 days older, still frozen):

| time | event |
|---|---|
| 34.964 | transaction created |
| 35.104 | **auth check #1 → ALLOWED** |
| 39.397 | **hold placed — $0.002403** + auth check #2 created |
| 39.538 | **auth check #2 → DENIED** (`currentValue 0.007409`) |

Same fingerprint, 3 days apart, different experiment: **pre-check passes → hold placed → re-check denies → hold never released.** (The gap between pass and deny is the re-check latency: 1.2s vs 4.4s here — the second is the deliberately "slow" TOCTOU variant, so its race window is wider.)

### 4.2 The control that proves it — deny-*before*-hold is clean

**Txn `ae314161`** was denied at the **first** auth request (a tenant-wide-scope misconfig, `currentValue 0.277572`, denied instantly). It has **zero cost rows — no hold was ever placed — and froze $0.00.** This is the control: when denial happens *before* the hold, nothing is stranded. Only deny-*after*-hold orphans money. The mechanism is therefore about *when* the denial lands, not *why* the rule denied.

### 4.3 The circularity (the sharp part)

The stranded hold is the *same* hold whose placement pushed the (double-counted, experiment 03) cumulative over the limit and triggered the denial. The call is denied *because of* a hold that the denial then refuses to release. A governance system meant to protect budgets freezes customer money on a call it simultaneously refuses to run.

## 5. Honest accounting — what's defensible vs what's ours

- **Mechanism (bulletproof):** both a post-hold crash and a post-hold denial orphan the hold; 0/89 released in 3 days; no release API. Proven on 5 traced txns + the deny-before-hold control.
- **The $0.307 crash total** is the sharper number — involuntary failures, the case a customer can't avoid.
- **The $0.221 denial total and the count of 85** are **inflated by our own test volume** — 74 of 85 are from concurrency experiments that deny-by-design (fire 50 at a rule sized for 1). Do not present this as an organic loss rate. The per-event mechanic is real; the frequency in normal traffic is unmeasured.
- **No `$/day` figure** should be quoted from either path — we measured *what happens when* a hold orphans, not *how often* holds orphan in live traffic.

## 6. Bounded / visible / recoverable — scored against the platform's own words

- **Bounded?** The frozen amount is bounded by `max_tokens` — which is unclamped past the model's real ceiling (experiment 01 §2/§4).
- **Visible?** Only as one opaque `unavailableBalance` number. The ledger does not surface *which* holds are frozen or *why* without the per-transaction dig this document did.
- **Recoverable?** Measured: **0 of 89 in 3 days**, no API to force release.

## 7. Questions for Sapiom engineering

1. Is hold-placement atomic with the authorization decision? Two auth requests per transaction, with the hold placed between an ALLOWED pre-check and a DENIED re-check (txns `eb9f1f01`, `ee579f2c`), suggests not.
2. On denial after a hold, is the hold meant to be released? None of 85 have released in 3 days; `ae314161` (denied pre-hold) correctly froze nothing.
3. On a post-hold execution failure (502), is the hold meant to release? 4/4 (`d59fb015` et al.) retained in full, 3 days.
4. Is there any release path — sweep, TTL, support action — for `unavailableBalance` that is holds-on-failed/denied transactions? What cadence?
5. Should `unavailableBalance` be decomposable by the customer (which holds, which transactions, why frozen)? Today it is one number.

## Appendix — reproduce

- **Read-only, free:** `GET /v1/accounts` for `unavailableBalance`; `GET /v1/transactions/{id}` for a hold's `isActive`/`supersededAt`/`costDetails.source`. Header `User-Agent: curl/8.6.0`.
- **Watcher:** `dryrun/refund_watch.js` polls the four known crash-holds + the aggregate frozen gap over time; log `dryrun/refund_watch.log`, notes `dryrun/REFUND_WATCH.md`. Analytics over all denied-holds: `dryrun/denial_analytics.js` → `denial_analytics.md`.
- **To reproduce a fresh orphan (deny path), free-ish:** create a `usage_limit` rule (`dryrun/governance_api_probe.md` recipe), fire calls until denied (`dryrun/r5_boundary.js`), then inspect the denied txn — its hold cost row is `isActive: true`. To reproduce the crash path costs a frozen $0.0768 per 128k attempt (unrecoverable — see experiment 01 §4 warning).
- **Shortcut for Sapiom engineers:** pull `unavailableBalance` for this tenant and decompose it — every frozen dollar is one of the 4 crash-holds ($0.076803 each) or one of the 85 denied-holds. Trace `eb9f1f01` (deny-after-hold, frozen) against `ae314161` (deny-before-hold, clean) to see the orphan condition directly.
