# R5 — Rule-Boundary Drain: Blast Radius, Cap Utilization, and a Double-Counted Cumulative

Date: 2026-07-06/07 · Scripts: `r5_boundary.js` (run 1) + `r5_boundary2.js` (run 2) ·
Results: `r5_boundary_result.json`, `r5_boundary2_result.json`
Cost: 13 settled calls × $0.0001 = $0.0013 settled; one $0.002403 denied hold frozen. Rule paused after each run.

## Setup

- Throwaway agent `r5-boundary-agent`, rule `r5-boundary-rule`: `usage_limit`,
  `limitValue "0.005"`, `sum_transaction_costs`, 1-day rolling, `measurementScope: "rule"`,
  scoped via `agentIds`. Created over the undocumented REST surface (`governance_api_probe.md`).
- Sequential LLM calls (`max_tokens=4000` → hold $0.002403, settle $0.0001), 4.5s gaps —
  deliberately sequential so the TOCTOU race can't contaminate the boundary measurement.

## What happened

**Run 1: 8/8 calls ALLOWED.** Under hold-counted history the rule should have denied at call 3
(2×$0.002403 + $0.002403 = $0.007209 > $0.005). It didn't — the cumulative counts **live
(superseded-aware) history**: after settlement, a call's contribution drops from its $0.002403
hold to its $0.0001 settle. The same "filter, not sum" supersession logic the reconciliation
audit validated on the ledger is what the rule engine does for history.

**Run 2 (same rule reactivated): denial at the 14th lifetime call** (run-2 call 6), HTTP 402.
The engine's own violation record:

```
reason: "Total transaction costs including this transaction (0.01 USD) would exceed limit of 0.01 USD in 1 days"
violations: [{ limitValue: 0.005, currentValue: 0.005003 }]
```

## The double-count

At denial time the agent's true ledger history was 13 settled calls × $0.0001 = **$0.0013**,
plus the current call's $0.002403 hold → a supersession-correct cumulative of **$0.003703**.
The engine reported **$0.005003**.

The exact fit: `2 × $0.0013 + $0.002403 = $0.005003` — **settled history counted twice, the
current hold once**. The boundary condition confirms it on both sides:

| Call | history (settled) | 2×history + current hold | vs $0.005 limit | observed |
|---|---|---|---|---|
| run-2 #5 | 12 × $0.0001 | $0.004803 | under | ALLOWED ✓ |
| run-2 #6 | 13 × $0.0001 | $0.005003 | over | DENIED ✓ |

**Likely mechanism:** every x402 transaction carries **two** authorization requests (one at
transaction create, one at payment reauthorize — both visible in the ledger), and a cumulative
that joins costs through authorization requests fans out 2× — a classic join-multiplicity
double-count. The denial reason string doubles once more ("0.01 USD vs 0.01 USD" — both the
cumulative and the *limit* rendered at 2×), which points at the same multiplicity leaking into
the display layer.

**Implication:** a `usage_limit` budget of $X on chained/x402 services actually halts spend at
roughly **$X/2 of settled cost** — budgets deplete twice as fast as configured. Combined with
§8's hold-based current-call pricing, a customer's effective budget is
`(limit − current_hold) / 2` in settled dollars.

**Caveats:** one rule config, one service (`sapiom_openrouter`), one agent; the 2× model fits
the call-5/call-6 boundary exactly but is inferred from that boundary, not from an engine trace.
The ledger also contains `doublecount-fast`/`doublecount-slow` test agents from a parallel
session probing the same behavior — cross-check those results before reporting externally.

## Measured tile numbers (Section-2 placeholders can now be populated)

- **Blast Radius $** (this config): 13 calls authorized before stop — **$0.0013 settled /
  $0.031 in cumulative holds authorized** against an intended $0.005 cap. In settled dollars
  the cap bounded spend at ~26% of the configured limit (the double-count working "in the
  customer's favor" — stops early). Label: measured on one test agent + one rule config.
- **Cap Utilization** at denial: engine-reported 100.1% ($0.005003/$0.005); ledger-true
  utilization **74.1%** ($0.003703/$0.005) — the gap between the two IS the double-count.

## Denial placement — deny-after-hold

The denied transaction's own sequence: authReq #1 `authorized` (rule check passed) → System
Payment Authorization ALLOWED → **hold placed** → authReq #2 rule check **DENIED**. The denied
call's $0.002403 hold stayed live/frozen on the transaction. Denial does not prevent the freeze;
it happens after it. See `denial_analytics.md` — $0.221 of such denied-call holds remain frozen,
none released after 3+ days.
