# TOCTOU Scale Experiment — Does the Concurrency Race Get Worse at Higher N?

Date: 2026-07-04
Scope: live governance-rule experiment against `https://api.sapiom.ai/v1`, using real (small) money.
Builds directly on `dryrun/hold_vs_settlement_experiment.md`'s TOCTOU finding (2 of 3 concurrent
calls independently `ALLOWED` by a rule sized for exactly 1).

## Headline result

**No leak reproduced at N=10.** A `usage_limit` rule sized to permit exactly 1 call's hold and
deny the rest was hit with **10 concurrent calls**; reading each transaction's own
`ruleExecutions` record (not wallet delta), exactly **1 of 10 was `ALLOWED`** and **9 of 10 were
correctly `DENIED`** — the rule behaved exactly as designed, with zero evidence of a race window
at this concurrency level. **Dollars authorized through: $0.000303 against a $0.000454 limit —
leak factor 1x (no leak).** Per the run's own stop-condition ("if N=10 already denies everything
cleanly, report honestly and STOP — do not keep firing"), **N=20 was not attempted.**

This is a genuinely different outcome from the prior N=3 experiment (2 of 3 allowed — a real
leak). See "Why this doesn't confirm scaling" below for the likely explanation and why this is not
a contradiction of the original TOCTOU finding.

## Hypothesis being tested

If the hold-vs-settlement TOCTOU race (found at N=3, `dryrun/hold_vs_settlement_experiment.md`) is
a structural check-then-act bug, firing more concurrent calls at a rule sized for "permit 1, deny
the rest" should let *more than 1* through, and the gap between rule-intent and reality (dollars
authorized vs. the limit) should grow with N.

## Setup

- Dedicated throwaway agent: `race-scale-agent-n10` (`AG-019`,
  id `5428e9d6-d22e-432f-9a5d-f5cfdeef2af8`) — created via `POST /v1/agents`, never used for real
  traffic.
- Model: `openai/gpt-4o-mini`. Prompt: `"Reply with exactly one word: \"test\"."`. `max_tokens: 500`
  (small, per plan — both hold and settlement stay tiny; also a much faster round-trip than the
  original experiment's `max_tokens: 4000`).

## Step 0 — Pre-checks

`GET /v1/accounts` before touching anything: `availableBalance = $4.712816` (well above the
$2.75/$0.50 abort floors — note `unavailableBalance = $0.009612` was pre-existing residue from the
*prior* experiment's not-yet-released holds, not from this run).

`GET /v1/spending-rules?include=parameters,agents`: all 6 pre-existing rules (`RL-001`…`RL-006`)
were already `status: paused` from the prior experiment's cleanup — **clean slate confirmed, no
pause action needed.**

## Step 1 — Baseline call (measure the real hold at max_tokens=500)

Fired one call through `race-scale-agent-n10` with **no rule active**:

| max_tokens | HTTP | hold | settle |
|---|---|---|---|
| 500 | 200 | **$0.000303** | **$0.0001** |

`0.000303 / 500 * 1000 = $0.000606/1k` — matches the previously-confirmed `~$0.0006/1k` hold rate.

## Step 2 — Rule (RL-007, `race-scale-rule-n10`)

Sized to **1.5×** the measured baseline hold (strictly between 1 hold and 2 holds — the same
sizing logic as the original `RL-006`, just retuned for the new hold amount):

```json
POST /v1/spending-rules
{
  "name": "race-scale-rule-n10",
  "ruleType": "usage_limit",
  "agentIds": ["5428e9d6-d22e-432f-9a5d-f5cfdeef2af8"],
  "parameters": [{
    "limitValue": "0.000454",
    "measurementType": "sum_transaction_costs",
    "intervalValue": 1,
    "intervalUnit": "days",
    "isRolling": true,
    "measurementScope": "rule"
  }]
}
→ 201  {"id":"d8a6e148-8194-4c6d-8764-05f4da2d10f7","formattedId":"RL-007","status":"active","version":1,...}
```

`limitValue = $0.000454` permits exactly 1 call ($0.000303 < limit) and denies a 2nd
($0.000606 > limit).

## Step 3 — THE TEST: 10 concurrent calls

Fired via `Promise.all` (true parallelism, identical prompt/model/`max_tokens`) through
`race-scale-agent-n10`. Client-side HTTP outcomes: **9× `402`, 1× `200`** (only call index 2 of the
10 succeeded end-to-end).

## Step 4 — Reading each transaction's OWN rule-execution record

**Important correction made during analysis:** each transaction carries **two** `ruleExecutions`
for our rule — a phase-1 pre-negotiation check (always `ALLOWED`, because the hold amount isn't
known yet, per the two-phase flow documented in `hold_vs_settlement_experiment.md`) and a phase-2
post-negotiation check (the real decision). The live script's first-pass tally counted "any
`ALLOWED`" and wrongly reported `allowed=10`; the honest read takes the ruleExecution with the
**latest `completedAt`** per transaction as authoritative. That corrected tally is what's reported
here (and is independently confirmed by the client-side HTTP status: exactly 1 call got `200`,
9 got `402` — the two signals agree exactly).

| txn (creation order) | overall status | hold | final rule decision | final decision completedAt |
|---|---|---|---|---|
| 1 (`e8ee2010…`) | denied | $0.000303 | **DENIED** | 17:38:46.404Z |
| 2 (`7a0bf378…`) | denied | $0.000303 | **DENIED** | 17:38:46.212Z |
| 3 (`3e8fcc04…`) | **completed** | $0.000303 | **ALLOWED** | 17:38:45.930Z |
| 4 (`4a8f1de2…`) | denied | $0.000303 | **DENIED** | 17:38:46.487Z |
| 5 (`07d51bbe…`) | denied | $0.000303 | **DENIED** | 17:38:46.010Z |
| 6 (`e708d66b…`) | denied | $0.000303 | **DENIED** | 17:38:46.117Z |
| 7 (`75e8b2d7…`) | denied | $0.000303 | **DENIED** | 17:38:46.320Z |
| 8 (`5aaa9ab8…`) | denied | $0.000303 | **DENIED** | 17:38:46.611Z |
| 9 (`b20e4dea…`) | denied | $0.000303 | **DENIED** | 17:38:47.360Z |
| 10 (`93f73997…`) | denied | $0.000303 | **DENIED** | 17:38:47.375Z |

**1 of 10 `ALLOWED`, 9 of 10 `DENIED`.** Notably, the allowed transaction was the **3rd** by
creation timestamp (not the 1st) but had the **earliest** phase-2 `completedAt` among all 10 —
i.e. whichever transaction's final rule-check finalizes first (not whichever call the client fires
first) is the one that sees a zero cumulative and gets through. Every other transaction's final
check ran after that one's cost was already counted, and correctly denied. This is the rule
working *correctly*, not a leak: it was designed to permit exactly 1, and exactly 1 got through.

Verbatim denial (any of the 9 — identical shape):
```json
{
  "reason": "Total transaction costs including this transaction (0.00 USD) would exceed limit of 0.00 USD in 1 days",
  "decision": "DENIED",
  "metadata": {
    "ruleType": "usage_limit",
    "violations": [{"limitValue": 0.000454, "currentValue": 0.001109, "parameterName": null, "measurementType": "sum_transaction_costs"}],
    "parametersChecked": 1
  }
}
```
(`currentValue: 0.001109` — this particular denial saw ~3.7 holds' worth already counted by the
time it finalized, i.e. correctly serialized behind several siblings.)

Verbatim approval (the 1 allowed transaction, phase-2):
```json
{"reason": "All limits within acceptable range", "decision": "ALLOWED"}
```

## Headline math

- Rule limit: **$0.000454** (sized to permit ~1 call).
- Calls fired concurrently: **10**.
- Allowed by the rule: **1**.
- Dollars authorized through: **1 × $0.000303 = $0.000303** — *under* the $0.000454 limit.
- **Leak factor: 1x / no leak.**

## Why this doesn't scale the way the hypothesis expected

The prior experiment (N=3, `max_tokens=4000`, slower round-trip) saw 2 of 3 allowed — a genuine
leak. This run (N=10, `max_tokens=500`, faster round-trip) saw exactly the intended 1 of 10
allowed — no leak. The most likely explanation, based on the timing data above: a TOCTOU race
window's size is set by how long a transaction's authorization pipeline takes to go from
"hold negotiated" to "final rule decision recorded" — here, phase-2 `completedAt` timestamps
landed within roughly **480ms–1450ms** of each transaction's own hold being negotiated, and *most*
of that spread reflects transactions correctly queueing/serializing behind each other's now-visible
cost, not a wide-open race window. A **smaller `max_tokens`** (faster generation call, if the
platform's authorization step is at all coupled to request latency) plausibly narrows the race
window versus the original `max_tokens=4000` test. TOCTOU races are also inherently probabilistic —
one trial each at N=3 and N=10 is not enough to establish a monotonic "worse with more
concurrency" trend; a leak appearing in one run and not another is consistent with a *real but
non-deterministic* race, not a disproof of one. Per the run's explicit stop-condition, no attempt
was made to keep firing at N=20 or to retune parameters to force a reproduction — that would be
p-hacking, not honest reporting.

## Money spent this run

- `accounts_before`: `availableBalance=$4.712816, unavailableBalance=$0.009612, totalBalance=$4.722428`
- `accounts_after`: `availableBalance=$4.709889, unavailableBalance=$0.012339, totalBalance=$4.722228`
- **Total captured/settled this run: $0.0002** (`totalBalance` dropped by exactly $0.0002 =
  baseline call settlement $0.0001 + the 1 allowed race-call settlement $0.0001 — both calls that
  actually executed against OpenRouter).
- **Transient holds placed this run (not captured):** 9 denied calls × $0.000303 = **$0.002727**
  (`unavailableBalance` rose by exactly this much: $0.012339 − $0.009612 = $0.002727) — released on
  Sapiom's own timeline, same as the prior experiment's unresolved holds.
- **Well under the $0.25 cap.** Balance never approached the $2.75/$0.50 abort floors at any point.

## Cleanup

| Rule | Status after | Notes |
|---|---|---|
| RL-007 `race-scale-rule-n10` | **paused** (v2) | paused immediately after the test, confirmed via `GET` |

`GET /v1/spending-rules?include=parameters,agents` after cleanup shows **all 7 rules
(`RL-001`…`RL-007`) at `status: paused`** — no rule created this run (or any prior run) remains
active that could affect future real spend.

Agent `race-scale-agent-n10` (`AG-019`, id `5428e9d6-d22e-432f-9a5d-f5cfdeef2af8`) cannot be
deleted (no `DELETE`/`PUT`/`PATCH` route on `/v1/agents/{id}`, per the earlier API probe) — inert
test residue, scoped only to a now-paused rule, description explicitly flags it as safe-to-ignore.

## N=20 round: not attempted

Per the run's design (step 7): "If N=10 already denies everything cleanly (no leak reproduced),
report that honestly and STOP — do not keep firing." N=10 showed the rule working exactly as
intended (1 of 10 allowed, matching its "permit ~1 call" design), so no N=20 round was fired. This
keeps total spend for the run at $0.0002 and avoids chasing a reproduction that the data doesn't
support forcing.

## Raw data

Full request/response bodies (agent creation, baseline call, rule creation, all 10 concurrent
outcomes, every transaction's full `authorizationRequests`/`ruleExecutions` tree, and the final
rule-pause confirmation) are in `dryrun/toctou_scale_result.json` (API key never logged/printed —
nothing to redact). A copy of the same raw round data is also at
`dryrun/toctou_scale_n10_result.json`, written directly by the experiment script
(`dryrun/toctou_scale_experiment.js`).
