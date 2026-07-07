# Experiments — reproducible protocols

Each document here is written so a Sapiom engineer can either **re-run the experiment from
scratch** (scripts, prompts, budgets, tolerances included) or **skip reproduction entirely**
and verify against their own backend using the transaction UUIDs we cite.

Genre note: `analysis/` holds our conclusions; `experiments/` holds the evidence protocols
behind them — question, design, every call fired, raw ledger readings, hypotheses we could
not discriminate from outside, and the questions only Sapiom's server-side logs can answer.

| # | Doc | Question | Status |
|---|---|---|---|
| 01 | [Hold pricing & capture ratio](01_hold_pricing_and_capture_ratio.md) | What prices an LLM hold? What does the fleet-level 18% capture actually mean? | complete |
| 02 | [Frozen capital / orphan holds](02_frozen_capital_orphan_holds.md) | Do retained holds (post-hold crash, deny-after-hold) ever release? | complete |
| 03 | [Governance cumulative double-count](03_governance_cumulative_double_count.md) | Why did a $0.005 rule deny at $0.0037 of true spend? | complete |
| 04 | TOCTOU authorization race | Do concurrent calls leak past a budget? | planned — data exists (`dryrun/toctou_latency_experiment.md`) |

Inconclusive / low-signal runs (idempotency replay, etc.) are logged in [minor_probes.md](minor_probes.md), not given a numbered doc.

Tenant for all experiments: `7234a7f9-4074-4aad-b13f-84e0e28b469a` · window 2026-07-04 → 2026-07-07.

## Capture policy

Every experiment script from this point forward persists the **complete wire exchange**: response body (JSON), response headers, HTTP status code. Original ladder scripts (§2 of 01_hold_pricing) discarded bodies, costing us the `completion_tokens` field (the actual work measured) until the replicate run restored it — budget and complexity are negligible against the forensic value.
