# Sapiom Spend-Optimization Advisor

Per-agent `max_tokens` right-sizing recommendation — the direct remedy for the hold/float finding (see report.md, findings.md). Zero spend, `spend.duckdb` only.

Rate used to convert dollars <-> tokens: **0.0006/1k tokens** (see METHODOLOGY in advisor.py docstring — inverted from real hold amounts in cap_experiment_result.json, applied to both hold and settled amounts as an approximation).
Buffer applied to recommended max_tokens: **1.3x** p95 observed usage.

## Per-agent recommendation

| Agent | N | Current typical max_tokens (p95 held) | Actual usage (p95) | Recommended max_tokens | Hold reduction if adopted |
|---|---|---|---|---|---|
| fleet-test | 10 | 905 | 167 | 217 | +76.0% |
| spend-writer | 9 | 808 | 757 | 984 | -21.7% |
| scale-test | 3 | 16005 | 167 | 217 | +98.6% |
| estimate-test | 2 | 907 | 833 | 1084 | -19.6% |
| cap-test | 2 | 905 | 167 | 217 | +76.0% |
| chain-task | 1 | 947 | 167 | 217 | +77.1% |

**Fleet-wide: adopting these recommendations would shrink total LLM hold size by an estimated +79.0%** across the 27 chained calls observed ($0.041346 -> $0.008698 in aggregate p95-based holds).

## Cheaper-provider suggestion

All observed LLM calls already use `openai/gpt-4o-mini` — OpenRouter's budget/mini tier, not a premium model. There isn't a meaningfully cheaper *model swap* available without a quality trade-off; the actual lever here is not provider choice but **request shape**: right-sizing `max_tokens` (above) shrinks the float/hold directly, and is the remedy this account's own data supports — not a switch to a different provider.

## Caveats

- n=27 chained calls across 6 agents, one evening, one model (`gpt-4o-mini`) — small sample, state before generalizing.
- Token counts are INFERRED from dollar amounts via a fitted rate, not read from a real `usage` field (none exists in this ledger) — treat implied token counts as approximate.
- Recommendation logic (p95 x buffer) is a standard capacity-planning heuristic, not tuned against this account's actual failure/truncation rate at tighter caps — a real rollout should monitor for truncated completions after tightening.

