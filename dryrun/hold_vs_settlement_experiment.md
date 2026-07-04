# Do Spending Rules Evaluate on the HOLD or the SETTLEMENT?

Date: 2026-07-04
Scope: live governance-rule experiment against `https://api.sapiom.ai/v1`, using real (small) money.

## Answer

**Rules evaluate on the HOLD amount, not the settlement amount.**

A `usage_limit` rule with a limit set strictly between a call's known settlement (~$0.0001) and
its known hold (~$0.0024) **denied** the call. The denial's own `violations[].currentValue` was
`0.002403` — an exact match, to the микроdollar, with the independently-measured HOLD amount for
that call. If the rule had evaluated on settlement, `currentValue` would have been ~`0.0001` (or
`0`, since settlement of the *current* call isn't known until after it completes) and the call
would have been approved. It wasn't.

## Hypothesis

Sapiom's LLM calls price the pre-auth hold on `max_tokens` (flat ~$0.0006/1k, confirmed linear
2k→16k in `dryrun/extrapolation_result.json`), then settle on actual tokens used. This creates a
large hold/settlement gap for big-`max_tokens`/short-output calls. A `usage_limit` spending rule
sums `sum_transaction_costs` over a rolling window — the open question is whether that sum uses
the (large) hold or the (small) settlement for calls still in flight / just completed.

**Test design:** put the rule's limit strictly between the two numbers. If the call is DENIED,
the rule must be counting the hold (settlement isn't even known at decision time for the current
call). If APPROVED, the rule is not front-loading the projected hold — consistent with
settlement-based accounting.

## Setup

- Dedicated throwaway agent: `holdtest-agent-hvs` (`AG-018`,
  id `42979481-f64d-4f16-a50d-a12c94838519`) — created via `POST /v1/agents`, never used for real
  traffic, scoped to nothing but this experiment's rules.
- Model: `openai/gpt-4o-mini` (cheapest tier already used throughout this repo's experiments).
- Prompt: `"In exactly one sentence, define \"settlement\" in payments."` — a small, real prompt.
- `max_tokens: 4000`.

## Baseline (no rule active)

Balance check before any spend: `availableBalance = $4.722528` (well above the $2.75/$0.50 abort
floors).

Fired one LLM call through `holdtest-agent-hvs` with no governance rule yet active, to measure the
real hold/settlement numbers for this exact model/prompt/max_tokens combo:

| max_tokens | HTTP | hold | settle |
|---|---|---|---|
| 4000 | 200 | **$0.002403** | **$0.0001** |

`0.002403 / 4000 * 1000 = $0.00060075` per 1k tokens — matches the previously-confirmed
`~$0.0006/1k` rate (`dryrun/extrapolation_result.json`: 0.0006015 / 0.000600375 / 0.0006001875 at
2000/8000/16000 tokens) almost exactly. Settlement floor ($0.0001) also matches the flat minimum
observed in that earlier experiment.

This fixed the rule-limit target: **$0.001**, strictly between $0.0001 (settle) and $0.002403 (hold).

## Rule 1 (RL-004) — a false start: `measurementScope` matters

First rule created (`holdtest-rule-hvs`, limit `$0.001`, `agentIds: [holdtest-agent-hvs]`) used
the API's *default* `measurementScope`, which turned out to be `"all"`. Firing the gated call
against it got an immediate denial — but for the wrong reason:

```
"reason": "Total transaction costs including this transaction (0.28 USD) would exceed limit of 0.00 USD in 1 days",
"violations": [{"limitValue": 0.001, "currentValue": 0.277572, "measurementType": "sum_transaction_costs"}]
```

`currentValue: 0.277572` is the **entire tenant's historical spend** (matches this repo's
already-reported TPV of ~$0.2775), not anything specific to `holdtest-agent-hvs` (whose own prior
activity totaled $0.0001). **Finding:** `agentIds` scopes *which agent's calls trigger* a rule
check, but `measurementScope: "all"` (the default) sums costs **tenant-wide**, not agent-scoped —
a real governance footgun distinct from the hold-vs-settlement question. This test was
uninformative/contaminated; **RL-004 was immediately paused** and a corrected rule created.

Probing the parameter schema (free, no spend) revealed the enum:
`measurementScope must be one of the following values: all, rule`. `"rule"` is what properly
isolates the sum to the rule's own scope.

## Rule 2 (RL-005) — the real test

`holdtest-rule-hvs-2`: `ruleType: usage_limit`, `agentIds: [holdtest-agent-hvs]`,
`parameters: [{limitValue: "0.001", measurementType: "sum_transaction_costs", intervalValue: 1,
intervalUnit: "days", isRolling: true, measurementScope: "rule"}]`.

Fired the **identical** call (same agent, model, prompt, `max_tokens:4000`) through this rule.
Observed a two-phase authorization flow per transaction:

1. **AuthorizationRequest #1** (before the hold amount is known / before x402 negotiation):
   RL-005 → `ALLOWED`, `"All limits within acceptable range"` (no violation, no amount cited —
   at this point the call's own cost isn't known yet).
2. The SDK's `sapiomFetch` got the x402 challenge: `HTTP 402`,
   `accepts: [{"amount":"0.002403","scheme":"upto",...}]` — **exactly the measured hold**.
3. **AuthorizationRequest #2** (after the hold amount is negotiated, before the call executes):
   - `System: Payment Authorization` (a built-in system rule) → `ALLOWED`,
     `"Payment successfully authorized"` (payment token signed for `$0.002403`).
   - **RL-005 (our rule) → `DENIED`**:
     ```
     "violations": [{"limitValue": 0.001, "currentValue": 0.002403, "measurementType": "sum_transaction_costs"}]
     ```
   - Overall transaction status: `denied`. The SDK's own async completion step then failed:
     `"Transaction ... must be in authorized status to complete. Current status: denied"` — the
     rule denial raced ahead of the SDK's own follow-up call.

`currentValue: 0.002403` is an **exact match** to the independently-measured hold amount from the
baseline call — not the ~$0.0001 settlement that call would have produced had it gone through.
**This is the core evidence: the rule engine evaluates (and denies) on the projected HOLD, not the
settlement.**

### A real hold was placed despite denial

Even though the transaction's *overall* status was `denied` (no LLM call ever reached
OpenRouter), a cost row was created: `fiatAmount: 0.002403, isActive: true, supersededAt: null`.
Checking `/v1/accounts` immediately after: `availableBalance` dropped by exactly `$0.002403` and
`unavailableBalance` rose to exactly `$0.002403`, while `totalBalance` was unchanged — i.e. **real
spendable capital was frozen by a hold on a call that was ultimately denied and never executed**,
consistent with the x402 `"upto"` scheme's pre-auth semantics (`maxTimeoutSeconds: 300` was in the
`accepts` object — an auto-release window, not an instant one). No permanent capture occurred (see
Cleanup below for confirmation the holds released).

## TOCTOU variant (concurrency race)

Created a third rule, **RL-006** (`holdtest-rule-hvs-toctou`), limit `$0.003`,
`measurementScope: "rule"`, same agent — sized to allow exactly one call's hold (~$0.0024) through
but not two (~$0.0048). Fired **3 concurrent calls** (`Promise.all`, identical prompt/model/tokens)
through `holdtest-agent-hvs`.

**Process gap (disclosed honestly):** RL-005 ($0.001 limit) was still `active` at this point — it
should have been paused right after the primary test. Its overall denial of all 3 concurrent calls
is therefore **confounded** by RL-005 alone (any single $0.0024 hold already exceeds $0.001,
independent of concurrency). RL-005 was paused immediately after this was noticed.

However, each transaction's authorization record carries a **separate ruleExecution per active
rule**, so RL-006's own decisions can be read independently of RL-005's:

| txn (fire order) | RL-006 decision | RL-006 `currentValue` |
|---|---|---|
| 1st (17:20:24.978Z) | `ALLOWED` | (only its own ~$0.0024 counted) |
| 2nd (17:20:25.046Z) | **`DENIED`** | `0.004806` (= exactly 2 × $0.002403) |
| 3rd (17:20:25.193Z) | `ALLOWED` | (only its own ~$0.0024 counted) |

**Finding: 2 of 3 concurrent transactions were independently `ALLOWED` by RL-006**, each seeing
only its *own* hold and not its siblings' simultaneously in-flight holds — even though the
combined pending holds of all 3 ($0.007209) or even just 2 ($0.004806) exceed the $0.003 limit.
Only the transaction processed in the middle position saw a doubled cumulative and was correctly
denied. This is a genuine check-then-act race: concurrent authorization checks do not fully
serialize against each other's in-flight (not-yet-settled) holds — a real TOCTOU window, though in
this run it caused no actual overspend because the leftover RL-005 independently blocked all 3
calls anyway (a lucky confound, not a design feature).

All 3 concurrent calls ended up `denied` overall (0 approved / 3 denied), each placing a
$0.002403 hold (again, released per the x402 timeout, not captured).

## Money spent

- **Confirmed captured/settled**: **$0.0001** — the single baseline call (no rule active), which
  ran to completion and settled normally.
- **Transient holds placed (not captured)**: $0.002403 (gated RL-005 call) +
  3 × $0.002403 = $0.007209 (TOCTOU calls) = **$0.009612** total, all released back (see Cleanup).
- **Total real spend this run: $0.0001** (well under the $0.25 cap; balance never dropped below
  $4.71 at any point, always far above the $2.75/$0.50 abort floors).

## Cleanup

| Rule | Status after | Notes |
|---|---|---|
| RL-004 `holdtest-rule-hvs` | **paused** (v2) | contaminated (`measurementScope: all`), paused immediately on discovery |
| RL-005 `holdtest-rule-hvs-2` | **paused** (v2) | primary test rule, paused after the TOCTOU test (should have been paused sooner — noted above) |
| RL-006 `holdtest-rule-hvs-toctou` | **paused** (v2) | TOCTOU rule, paused immediately after the test |

Verified via `GET /v1/spending-rules`: all three rules created this run (plus the pre-existing
`RL-001`/`RL-002`/`RL-003` from the earlier probe) show `status: paused`. **No active rule from
this experiment remains that could affect future real spend.**

The pending holds ($0.009612 total across the gated + TOCTOU calls) were polled via
`/v1/accounts` continuously after cleanup. As of report time, `unavailableBalance` had **not yet**
returned to `$0.000000` — even the oldest hold (gated call, placed 17:16:52Z) was still pending
~8+ minutes later, well past its `maxTimeoutSeconds: 300` (5 min) marker, suggesting release is on
a backend sweep/cron cadence rather than instantaneous at the timeout mark. Critically,
**`totalBalance` never moved from $4.722428 throughout** (only `available`/`unavailable` shifted),
which is the load-bearing fact: nothing was ever captured. This is a hold, not a loss — the
$0.009612 is temporarily illiquid, not spent, and requires no further action (it will release on
Sapiom's own timeline; no user action or API call can force/void it — no release/void endpoint
exists per the earlier probe). This is flagged as an open item for a future, longer-horizon check
rather than something blocking this report.

Agent `holdtest-agent-hvs` (`AG-018`) cannot be deleted (no `DELETE`/`PUT`/`PATCH` route exists on
`/v1/agents/{id}`, consistent with the earlier probe's finding) — it is inert test residue, scoped
to only paused rules, description explicitly flags it as safe-to-ignore test data.

## Key verbatim evidence (redacted of the API key)

Gated call HTTP response (x402 challenge, hold amount quoted before authorization):
```json
{"x402Version":2,"error":"Payment required","resource":{"url":"http://openrouter.services.sapiom.ai/v1/chat/completions","description":"OpenRouter chat completion","mimeType":"application/json"},"accepts":[{"scheme":"upto","network":"sapiom:main","amount":"0.002403","asset":"USD","payTo":"397b9395-d30d-42cc-abf9-0c56629d1c2f","maxTimeoutSeconds":300,"extra":{}}]}
```

Rule denial (the core finding):
```json
{
  "reason": "Total transaction costs including this transaction (0.00 USD) would exceed limit of 0.00 USD in 1 days",
  "decision": "DENIED",
  "metadata": {
    "ruleType": "usage_limit",
    "violations": [{"limitValue": 0.001, "currentValue": 0.002403, "measurementType": "sum_transaction_costs"}],
    "parametersChecked": 1
  }
}
```
(Note: the human-readable `reason` string rounds to 2 decimals, so it displays "$0.00" for both
the $0.001 limit and the $0.0024 current value — the authoritative numbers are in
`violations[].currentValue`/`limitValue`, not the rounded prose.)

TOCTOU race (2nd-processed transaction, the one that *did* see the doubled cumulative):
```json
{"reason":"Total transaction costs including this transaction (0.00 USD) would exceed limit of 0.00 USD in 1 days","decision":"DENIED","metadata":{"ruleType":"usage_limit","violations":[{"limitValue":0.003,"currentValue":0.004806,"measurementType":"sum_transaction_costs"}],"parametersChecked":1}}
```

Account balance during the pending-hold window (confirms hold = real frozen capital, not a
capture):
```
availableBalance: 4.720025   unavailableBalance: 0.002403   totalBalance: 4.722428  (unchanged)
```

## Raw data

Full request/response bodies for every step (agent creation, all 3 rule creations, baseline call,
both gated-call attempts, TOCTOU batch, and final rule-pause confirmations) are in
`dryrun/hold_vs_settlement_result.json`.

## Why this matters (one line, non-gotcha framing)

Because the pre-auth hold is priced on `max_tokens` (not actual usage) and rules enforce against
that inflated hold, a budget-conscious team sizing `usage_limit` rules from *expected real spend*
will get surprise denials at a small fraction of their intended budget — the rule is doing its job
correctly, but the number it's protecting against is ~24x larger (in this sample) than what the
call will actually cost.
