#!/usr/bin/env python3
"""BUILD 5 (advisor half) — per-agent max_tokens right-sizing advisor.
Writes advisor.md.

Zero spend: reads spend.duckdb only, no network calls, no API key needed.

THE PROBLEM (established finding, see report.md / findings.md): Sapiom's
pre-auth HOLD for an OpenRouter LLM call is priced linearly on the
REQUESTED max_tokens (~$0.0006 per 1,000), not on tokens actually used. A
padded max_tokens freezes far more balance than the call ever costs. This
advisor's job: recommend a tighter max_tokens per agent, grounded in that
agent's own OBSERVED usage.

METHODOLOGY / KEY ASSUMPTION: the ledger does not record the request's
max_tokens parameter or actual token counts anywhere (checked during BUILD 0
field-availability probing — no `usage` field, no `qualifiers` payload on
these transactions). What IS recorded is two dollar amounts per chained
call: the HOLD (`costs[].fiatAmount` on the row later superseded) and the
SETTLED/live amount. Both are inverted through the same $0.0006/1,000-token
rate (confirmed via two independent real data points in
dryrun/cap_experiment_result.json: max_tokens=900 -> hold $0.000543;
max_tokens=400 -> hold $0.000243; both ~$0.0006/1k within ~1%) to get:
  implied_requested_max_tokens = hold_amount / RATE_PER_TOKEN
  implied_actual_tokens_used   = settled_amount / RATE_PER_TOKEN
This assumes settlement uses the SAME per-token rate as the hold formula,
which is an approximation (OpenRouter's real settlement likely blends
different input/output per-token rates) — stated here explicitly per the
"state sample size + conditions" honesty rule, not fabricated as exact.

Usage:
    python advisor.py [--db spend.duckdb] [--out advisor.md] [--buffer 1.3]
"""
import argparse
import math
from decimal import Decimal

import duckdb

DEFAULT_DB = "spend.duckdb"
DEFAULT_OUT = "analysis/advisor.md"
RATE_PER_TOKEN_USD = Decimal("0.0006") / Decimal("1000")  # $/token, from cap_experiment_result.json
DEFAULT_BUFFER = 1.3


def fmt_usd(d) -> str:
    return f"${Decimal(d):,.6f}"


def percentile(values: list, pct: float):
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(pct / 100 * (len(s) - 1)))))
    return s[k]


def load_llm_chains(con) -> list:
    """One row per chained (hold -> settled) sapiom_openrouter transaction."""
    rows = con.execute("""
        WITH multi AS (
            SELECT transaction_id FROM costs GROUP BY transaction_id HAVING COUNT(*) > 1
        ),
        hold AS (
            SELECT c.transaction_id, c.fiat_amount AS hold_amount
            FROM costs c JOIN multi m ON m.transaction_id = c.transaction_id
            WHERE c.superseded_at IS NOT NULL AND c.supersedes_cost_id IS NULL
        ),
        final AS (
            SELECT c.transaction_id, c.fiat_amount AS final_amount
            FROM costs c JOIN multi m ON m.transaction_id = c.transaction_id
            WHERE c.superseded_at IS NULL
        )
        SELECT t.agent_name, h.hold_amount, f.final_amount
        FROM hold h JOIN final f ON f.transaction_id = h.transaction_id
        JOIN transactions t ON t.id = h.transaction_id
        WHERE t.service_name = 'sapiom_openrouter'
    """).fetchall()
    return [{"agent_name": r[0], "hold_amount": r[1], "final_amount": r[2]} for r in rows]


def render(con, buffer: float) -> str:
    chains = load_llm_chains(con)

    lines = []
    lines.append("# Sapiom Spend-Optimization Advisor")
    lines.append("")
    lines.append("Per-agent `max_tokens` right-sizing recommendation — the direct remedy for the "
                  "hold/float finding (see report.md, findings.md). Zero spend, `spend.duckdb` only.")
    lines.append("")

    if not chains:
        lines.append("No chained (hold -> settled) `sapiom_openrouter` transactions found — nothing to advise on yet.")
        return "\n".join(lines) + "\n"

    lines.append(f"Rate used to convert dollars <-> tokens: **{RATE_PER_TOKEN_USD * 1000:.4f}/1k tokens** "
                 "(see METHODOLOGY in advisor.py docstring — inverted from real hold amounts in "
                 "cap_experiment_result.json, applied to both hold and settled amounts as an approximation).")
    lines.append(f"Buffer applied to recommended max_tokens: **{buffer}x** p95 observed usage.")
    lines.append("")

    by_agent = {}
    for c in chains:
        implied_max = float(c["hold_amount"]) / float(RATE_PER_TOKEN_USD)
        implied_actual = float(c["final_amount"]) / float(RATE_PER_TOKEN_USD)
        by_agent.setdefault(c["agent_name"], []).append((implied_max, implied_actual))

    lines.append("## Per-agent recommendation")
    lines.append("")
    lines.append("| Agent | N | Current typical max_tokens (p95 held) | Actual usage (p95) | Recommended max_tokens | Hold reduction if adopted |")
    lines.append("|---|---|---|---|---|---|")
    total_current_hold = Decimal(0)
    total_recommended_hold = Decimal(0)
    for agent_name, pairs in sorted(by_agent.items(), key=lambda kv: -len(kv[1])):
        maxes = [p[0] for p in pairs]
        actuals = [p[1] for p in pairs]
        p95_max = percentile(maxes, 95)
        p95_actual = percentile(actuals, 95)
        recommended = max(1, math.ceil(p95_actual * buffer))
        current_hold_usd = Decimal(p95_max) * RATE_PER_TOKEN_USD
        recommended_hold_usd = Decimal(recommended) * RATE_PER_TOKEN_USD
        reduction_pct = ((current_hold_usd - recommended_hold_usd) / current_hold_usd * 100) if current_hold_usd else Decimal(0)
        total_current_hold += current_hold_usd * len(pairs)
        total_recommended_hold += recommended_hold_usd * len(pairs)
        lines.append(
            f"| {agent_name} | {len(pairs)} | {p95_max:.0f} | {p95_actual:.0f} | {recommended} | {reduction_pct:+.1f}% |"
        )
    lines.append("")

    overall_reduction = ((total_current_hold - total_recommended_hold) / total_current_hold * 100) if total_current_hold else Decimal(0)
    lines.append(f"**Fleet-wide: adopting these recommendations would shrink total LLM hold size by an estimated "
                 f"{overall_reduction:+.1f}%** across the {len(chains)} chained calls observed "
                 f"({fmt_usd(total_current_hold)} -> {fmt_usd(total_recommended_hold)} in aggregate p95-based holds).")
    lines.append("")

    lines.append("## Cheaper-provider suggestion")
    lines.append("")
    lines.append("All observed LLM calls already use `openai/gpt-4o-mini` — OpenRouter's budget/mini tier, not a "
                  "premium model. There isn't a meaningfully cheaper *model swap* available without a quality "
                  "trade-off; the actual lever here is not provider choice but **request shape**: right-sizing "
                  "`max_tokens` (above) shrinks the float/hold directly, and is the remedy this account's own "
                  "data supports — not a switch to a different provider.")
    lines.append("")

    lines.append("## Caveats")
    lines.append("")
    lines.append(f"- n={len(chains)} chained calls across {len(by_agent)} agents, one evening, one model "
                 "(`gpt-4o-mini`) — small sample, state before generalizing.")
    lines.append("- Token counts are INFERRED from dollar amounts via a fitted rate, not read from a real "
                 "`usage` field (none exists in this ledger) — treat implied token counts as approximate.")
    lines.append("- Recommendation logic (p95 x buffer) is a standard capacity-planning heuristic, not tuned "
                 "against this account's actual failure/truncation rate at tighter caps — a real rollout should "
                 "monitor for truncated completions after tightening.")
    lines.append("")

    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Per-agent max_tokens advisor over spend.duckdb")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--buffer", type=float, default=DEFAULT_BUFFER)
    args = ap.parse_args()

    con = duckdb.connect(args.db, read_only=True)
    report = render(con, args.buffer)
    con.close()

    with open(args.out, "w") as f:
        f.write(report)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
