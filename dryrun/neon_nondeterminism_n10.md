# Neon 15-minute non-determinism — n=10 replication (pooled n=12)

Date: 2026-07-07. Script: `dryrun/neon_nondeterminism_n10.js`. Raw results:
`dryrun/neon_nondeterminism_n10_result.json` (10 new calls, full raw
transaction JSON per call) + the 2 pre-existing 15m calls pulled from
`dryrun/service_hold_survey_result.json` and
`dryrun/service_hold_survey_addendum_result.json` (re-fetched live via `GET
/v1/transactions/{id}` to get their full raw JSON too, since the original
scripts only stored a flattened `analyzeCostRows`/`analyzeTxn` view).

## Pre-flight (per instructions)

- **Governance**: `GET /v1/spending-rules` → **17 total, 0 active** (same as
  the original survey's pre-flight). No rule could deny these calls.
- **Balance floor**: available balance at start = **$3.903763**, held
  constant (only moved by $0.00001 total, this run's actual spend) — never
  close to the $2.00 abort floor.
- **Budget**: $0.25 approved cap for this task; actual spend was
  **$0.00001** (10 × $0.000001, each call matching Neon's free `/price`
  quote for 15m exactly, same as every previously-charged Neon create).

## Pooled result: 11/12 charged (91.7%), 1/12 free (8.3%)

| # | Source | Call | `requiresPayment` | `actionName` | Cost rows | Amount | Txn id | createdAt → completedAt (Δs) |
|---|---|---|---|---|---|---|---|---|
| 1 | main survey run | 15m | **false** | **execute** | **0** | **$0** | `c548decd-9c01-4c6b-8c0f-bf323b51170e` | 15:42:05.743 → 15:42:06.948 (**1.205s**) |
| 2 | addendum | 15m (replicate) | true | create | 1 | $0.000001 | `73d38681-aae9-438a-b125-a0310aaeb7f1` | 15:46:34.341 → 15:46:41.661 (7.320s) |
| 3–12 | **this run (n10)** | 15m ×10 | true (10/10) | create (10/10) | 1 (10/10) | $0.000001 (10/10) | see below | 5.03s – 9.33s, mean ≈6.8s |

n10 call detail (all 10, sequential, agent `survey-neon-n10`):

| n10 # | handle | HTTP | Txn id | Amount | createdAt → completedAt (Δs) |
|---|---|---|---|---|---|
| 1 | survey-neon-n10-1 | 201 | `834519ce-e7cd-4119-8b21-672601f78566` | $0.000001 | 7.332s |
| 2 | survey-neon-n10-2 | 201 | `1e79b84d-c4b1-4765-b96e-ce208de98158` | $0.000001 | 9.329s |
| 3 | survey-neon-n10-3 | 201 | `591ecb12-ef8a-487d-9081-42294c38335f` | $0.000001 | 5.027s |
| 4 | survey-neon-n10-4 | 201 | `5c23cca7-7683-4541-9d22-7ab1a83cdf2a` | $0.000001 | 7.195s |
| 5 | survey-neon-n10-5 | 201 | `8e3541f7-49a8-4c75-b839-870a8501bedc` | $0.000001 | 7.101s |
| 6 | survey-neon-n10-6 | 201 | `daa44ff1-fc81-4d70-915d-52fa7cf2e39a` | $0.000001 | 5.262s |
| 7 | survey-neon-n10-7 | 201 | `c4bfe56b-6300-4901-a4d1-6c0040f98468` | $0.000001 | 7.059s |
| 8 | survey-neon-n10-8 | 201 | `17c31e53-56c3-4920-a03c-eab0c7060719` | $0.000001 | 6.495s |
| 9 | survey-neon-n10-9 | 201 | `50a3b044-2f3b-497b-a571-829b8d9cb5bc` | $0.000001 | 6.237s |
| 10 | survey-neon-n10-10 | 201 | `4b211cc4-be54-458a-8c42-76982308497b` | $0.000001 | 6.414s |

All 10 new databases created successfully (HTTP 201), all matched to a
transaction for `survey-neon-n10` within the settle window, all deleted
afterward (`DELETE /v1/databases/{id}`, best-effort, same cleanup pattern as
the prior survey — not required, they auto-expire).

**Headline: replicating at n=10 did NOT reproduce the free/`execute` outcome
even once.** The original n=2 (1 free, 1 charged — a 50% rate) was
consistent with a coin flip, but pooling with n=10 more identical calls
moves the observed rate to **1/12 (≈8%)**. The n=2 baseline overstated how
often the free path occurs — this is the expected behavior of a rare event
sampled at very small n, not evidence the mechanism changed between runs.

## Raw evidence — one call of each behavior

### The one FREE/`execute` call (main survey run, 15m)

```json
{
  "id": "c548decd-9c01-4c6b-8c0f-bf323b51170e",
  "serviceName": "sapiom_neon",
  "actionName": "execute",
  "resourceName": "database",
  "status": "completed",
  "requiresPayment": false,
  "metadata": { "preemptiveAuthorization": true },
  "createdAt": "2026-07-07T15:42:05.743Z",
  "preparingAt": "2026-07-07T15:42:05.785Z",
  "authorizedAt": "2026-07-07T15:42:05.838Z",
  "completedAt": "2026-07-07T15:42:06.948Z",
  "outcome": "success",
  "currentPaymentTransactionId": null,
  "costs": [],
  "paymentTransactions": []
}
```

Full lifecycle (`createdAt`→`completedAt`) took **1.2 seconds**. There is no
`payment` object and `costs` is an empty array — not a cost row that got
waived, but a transaction that never entered the payment/x402 flow at all.

### A representative CHARGED/`create` call (this run, n10 call #1)

```json
{
  "id": "834519ce-e7cd-4119-8b21-672601f78566",
  "serviceName": "sapiom_neon",
  "actionName": "create",
  "resourceName": "database",
  "status": "completed",
  "requiresPayment": true,
  "metadata": { "preemptiveAuthorization": true },
  "createdAt": "2026-07-07T15:58:41.454Z",
  "preparingAt": "2026-07-07T15:58:42.916Z",
  "authorizedAt": "2026-07-07T15:58:43.001Z",
  "completedAt": "2026-07-07T15:58:48.786Z",
  "outcome": "success",
  "costs": [
    { "fiatAmount": "0.000001000000000000", "isEstimate": false, "isActive": true,
      "supersedesCostId": null, "supersededAt": null }
  ],
  "paymentTransactions": [
    { "protocol": "x402", "network": "sapiom", "amount": "0.000001000000000000",
      "scheme": "exact", "status": "completed" }
  ]
}
```

Full lifecycle took **7.3 seconds**, and includes a full x402 payment
handshake (`authorizationPayload`, JWT-signed payment token, a
`paymentTransactions[0]` record with its own `preparingAt`/`authorizedAt`/
`completedAt`). This is the same shape as every other charged Neon create
seen in this repo (main run's 1h, addendum's 15m replicate and 4h — see
below), and now confirmed 10/10 more times.

## A pattern was found: timing, not ordering, cleanly separates the two outcomes

This wasn't asked for as the headline, but it fell out of pulling full raw
transactions instead of the flattened summaries the prior scripts saved:

| Call | Outcome | `createdAt`→`completedAt` |
|---|---|---|
| main 15m | **free** | **1.205s** |
| main 1h | charged | 7.164s |
| addendum 15m | charged | 7.320s |
| addendum 4h | charged | 7.259s |
| n10 #1–10 | charged (all) | 5.03s – 9.33s |

**Every charged call (11/11 with timing data) took ≥5.0 seconds. The one
free call took 1.2 seconds** — 4x faster than the fastest charged call, and
with a completely different code shape (no `payment` object, no
`paymentTransactions`, `costs: []`, `actionName: "execute"` instead of
`"create"`). This is not "the same request randomly got billed or not" —
it's two visibly different backend paths, one of which happens to skip
billing. Ordering doesn't correlate (the free call was chronologically
first among the 12, but nothing else about early calls in this run or the
n10 batch was different — n10 call #1 was charged and slow like every other
n10 call).

## Hypotheses (stated as questions, not conclusions)

- **Cache-hit / warm-resource-reuse path?** Is `actionName: "execute"` a
  distinct backend branch — e.g., reusing an already-provisioned/warm Neon
  branch or pooled compute slot instead of provisioning a new one — and does
  that branch simply not carry a billable event? The ~1.2s vs ~5–9s timing
  gap is consistent with "skip actual provisioning," but we have no visibility
  into Neon's or Sapiom's internals to confirm this from outside.
- **Idempotency-key or request-fingerprint reuse?** Could the free call have
  matched some short-lived dedup/idempotency window against a very recent
  prior request (even though the `handle` field differed each time —
  `survey-neon-15m` vs `survey-neon-addendum-15m` vs `survey-neon-n10-N`)? We
  didn't find any shared identifier between the one free call and any other
  call in this dataset — but we also don't have access to whatever key the
  backend might dedup on internally (e.g., a nonce, a rate-limit token, an
  API-key-level in-flight-request key).
- **Free-tier / promotional heuristic at the smallest priced tier?** The
  quoted price for both 15m and 1h is identically $0.000001 (see
  `service_hold_survey.md`'s free price curve) — the lowest priced tier in
  the ladder. Is there a heuristic that occasionally treats sub-$0.00001
  requests as "not worth billing" and routes them to a cheaper/faster
  internal path? If so, why did 11/12 of the identically-priced 15m requests
  still go through full billing?
- **Race/threshold condition tied to backend load or timing at request
  time?** The free call fired at 15:42:05.743Z, close in time to the very
  first Neon call of the whole survey session (this was the first real
  paid-route Neon call in the entire evening's testing, per
  `service_hold_survey.md`). Is a "first call of a session/burst" or
  "backend still warming up" condition relevant? We can't test this cleanly
  without deliberately varying position-in-burst, which this run didn't do
  (n10 fired call #1 as also the fastest-arriving-after-idle call in *this*
  run, and it was charged normally — weak evidence against a pure
  "first-call-is-free" theory, but n=1 either way).

None of these can be confirmed or ruled out from outside the platform. We
did not find a reproducible trigger — we found that the free outcome is
**rare** (1/12 ≈ 8%) and **visibly a different code path** (timing,
`actionName`, presence of a payment object), which narrows the hypothesis
space from "random billing flakiness" toward "an occasionally-taken fast
path that happens not to bill," without identifying what selects that path.

## Honesty notes

- **One account, one evening.** All 12 fifteen-minute-duration observations
  (2 original + 10 new) come from the same Sapiom account, within roughly a
  90-minute window on 2026-07-07 (15:42–16:00 UTC). This is not evidence
  about other accounts, other times of day, or long-run stability.
- **One duration value.** All 12 replicate calls used `duration: "15m"`
  specifically — the split has only ever been observed at this duration.
- **Correction to the task's framing on 1h/4h:** the task brief stated "1h/4h
  were 4/4 consistently charged." Checking the actual records
  (`service_hold_survey_result.json`, `service_hold_survey_addendum_result.json`),
  this repo has exactly **one** 1h create (main run, charged, txn
  `f1148d15-0fbe-4414-930a-85f35f14030e`) and **one** 4h create (addendum,
  charged, txn `e90b9306-0aba-480a-bf60-87cc3fdf138b`) — **2/2 charged, not
  4/4.** Both took ~7.2s (7.164s and 7.259s respectively), matching the
  "charged" timing signature above. We did not fire additional 1h/4h calls
  in this run (out of scope — the task asked specifically for 15m
  replication), so we can't say whether 1h/4h would show the same ~8% free
  rate at n=12 — only that the 2 observations that exist are both charged
  and both timing-consistent with the charged path. Is 15m special, or would
  1h/4h show the same rare free-path at higher n? Unknown — this would need
  its own n≈12 replication to check.
- **n=12 is enough to say the rate is not 50%, not enough to pin down a
  precise rate.** A one-sided rate of 1/12 has a wide confidence interval
  (roughly 0.2%–35% at 95% CI, Wilson score) — "≈8%" is a point estimate,
  not a precise measurement. More replicates would narrow it, but weren't
  fired here (n=10 was the approved replication size, cost was already
  proven immaterial at ≤$0.000001/call).
- **No spending rule was paused or restored** — none were active, consistent
  with every prior run in this repo today.
- Every dollar figure above is a real transaction on the live Sapiom API,
  not simulated. Total spend for this run: **$0.00001** (10 × $0.000001).

## Does this survive as "non-deterministic pricing"?

**Partially, reframed.** The original n=2 framing ("a genuine,
reproducible-as-inconsistent split at the 15-minute tier," rate unstated) is
now more precise: **it is real** (n=12, 1 free call with a distinctly
different transaction shape, not a data-entry error or a free-endpoint
mixup — we hit the real paid `/v1/databases` route all 12 times) **but it is
rare, not a coin flip.** The clean timing/shape separation (free calls
finish in ~1.2s with no payment object; charged calls take 5–9s with a full
x402 payment handshake) suggests this resolves into "two different backend
code paths, one of which is charged and typical, one of which is fast and
free and rare" rather than "the same code path randomly decides whether to
bill." That's a narrower, more explainable-sounding shape than pure
non-determinism — but *why* a request takes the fast/free path 1-in-12
times is still unknown from outside the platform, so it isn't fully resolved
into an explained mechanism either.
