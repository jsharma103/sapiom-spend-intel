#!/usr/bin/env python3
"""Stage 3 — reconciliation audit over spend.duckdb. Writes report.md.

Usage:
    python audit.py [--db spend.duckdb] [--initial-balance 5.00] [--out report.md]
"""
import argparse
from decimal import Decimal

import duckdb

DEFAULT_DB = "spend.duckdb"
DEFAULT_OUT = "analysis/report.md"
DEFAULT_INITIAL_BALANCE = Decimal("5.00")
BALANCE_TOLERANCE = Decimal("0.000001")


def q1_double_count_guard(con) -> dict:
    naive = con.execute("SELECT COALESCE(SUM(fiat_amount), 0) FROM costs").fetchone()[0] or Decimal(0)
    live = con.execute(
        "SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL"
    ).fetchone()[0] or Decimal(0)
    overstatement_pct = ((naive - live) / live * 100) if live != 0 else Decimal(0)
    passed = naive >= live  # naive should never be less than live
    return {
        "passed": passed,
        "naive": naive,
        "live": live,
        "overstatement_pct": overstatement_pct,
    }


def q2_balance_reconciliation(con, initial_balance: Decimal) -> dict:
    row = con.execute(
        "SELECT fetched_at, balance FROM balance_snapshots ORDER BY fetched_at DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return {"passed": False, "error": "no balance_snapshots rows found"}
    fetched_at, latest_balance = row
    live = con.execute(
        "SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL"
    ).fetchone()[0] or Decimal(0)
    expected = initial_balance - live
    diff = abs(latest_balance - expected)
    return {
        "passed": diff < BALANCE_TOLERANCE,
        "fetched_at": fetched_at,
        "latest_balance": latest_balance,
        "initial_balance": initial_balance,
        "live_spend": live,
        "expected_balance": expected,
        "diff": diff,
    }


def q3_revision_analysis(con) -> list:
    """For each transaction with >1 cost row, compare superseded ('initial') amount
    to the live ('final') amount. Grouped per service."""
    rows = con.execute("""
        WITH multi AS (
            SELECT transaction_id
            FROM costs
            GROUP BY transaction_id
            HAVING COUNT(*) > 1
        ),
        initial_cost AS (
            SELECT c.transaction_id, c.fiat_amount AS initial_amount
            FROM costs c
            JOIN multi m ON m.transaction_id = c.transaction_id
            WHERE c.superseded_at IS NOT NULL AND c.supersedes_cost_id IS NULL
        ),
        final_cost AS (
            SELECT c.transaction_id, c.fiat_amount AS final_amount
            FROM costs c
            JOIN multi m ON m.transaction_id = c.transaction_id
            WHERE c.superseded_at IS NULL
        )
        SELECT t.service_name, ic.transaction_id, ic.initial_amount, fc.final_amount
        FROM initial_cost ic
        JOIN final_cost fc ON fc.transaction_id = ic.transaction_id
        JOIN transactions t ON t.id = ic.transaction_id
        ORDER BY t.service_name, ic.transaction_id
    """).fetchall()

    by_service = {}
    for service_name, txn_id, initial_amount, final_amount in rows:
        pct = ((final_amount - initial_amount) / initial_amount * 100) if initial_amount != 0 else Decimal(0)
        by_service.setdefault(service_name, []).append(pct)

    result = []
    for service_name, pcts in sorted(by_service.items()):
        avg_pct = sum(pcts) / len(pcts)
        result.append({"service_name": service_name, "revised_count": len(pcts), "avg_revision_pct": avg_pct})
    return result


def q4_chain_integrity(con) -> dict:
    orphan_superseded = con.execute("""
        SELECT id, transaction_id, fiat_amount, superseded_at
        FROM costs
        WHERE superseded_at IS NOT NULL
          AND id NOT IN (
              SELECT supersedes_cost_id FROM costs WHERE supersedes_cost_id IS NOT NULL
          )
        ORDER BY transaction_id
    """).fetchall()

    zero_cost_completed = con.execute("""
        SELECT t.id, t.service_name, t.completed_at
        FROM transactions t
        WHERE t.status = 'completed'
          AND t.id NOT IN (SELECT DISTINCT transaction_id FROM costs)
        ORDER BY t.id
    """).fetchall()

    double_live = con.execute("""
        SELECT transaction_id, COUNT(*) AS live_count, SUM(fiat_amount) AS total
        FROM costs
        WHERE superseded_at IS NULL
        GROUP BY transaction_id
        HAVING COUNT(*) > 1
        ORDER BY transaction_id
    """).fetchall()

    return {
        "orphan_superseded": orphan_superseded,
        "zero_cost_completed": zero_cost_completed,
        "double_live": double_live,
    }


def header_stats(con) -> dict:
    n_txns = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    n_agents = con.execute("SELECT COUNT(DISTINCT agent_id) FROM transactions").fetchone()[0]
    live_spend = con.execute(
        "SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL"
    ).fetchone()[0] or Decimal(0)
    period = con.execute("SELECT MIN(created_at), MAX(created_at) FROM transactions").fetchone()
    per_agent = con.execute("""
        SELECT t.agent_name, COUNT(DISTINCT t.id) AS txn_count,
               COALESCE(SUM(c.fiat_amount), 0) AS live_spend
        FROM transactions t
        LEFT JOIN costs c ON c.transaction_id = t.id AND c.superseded_at IS NULL
        GROUP BY t.agent_name
        ORDER BY live_spend DESC
    """).fetchall()
    return {
        "n_txns": n_txns,
        "n_agents": n_agents,
        "live_spend": live_spend,
        "period_start": period[0],
        "period_end": period[1],
        "per_agent": per_agent,
    }


def fmt_usd(d) -> str:
    return f"${Decimal(d):,.6f}"


def fmt_pct(d) -> str:
    return f"{Decimal(d):+.2f}%"


def render_report(con, initial_balance: Decimal) -> str:
    hdr = header_stats(con)
    c1 = q1_double_count_guard(con)
    c2 = q2_balance_reconciliation(con, initial_balance)
    c3 = q3_revision_analysis(con)
    c4 = q4_chain_integrity(con)

    lines = []
    lines.append("# Sapiom Ledger Audit Report")
    lines.append("")
    lines.append("## Overview")
    lines.append("")
    lines.append(f"- Total transactions: **{hdr['n_txns']}**")
    lines.append(f"- Distinct agents: **{hdr['n_agents']}**")
    lines.append(f"- Total live spend: **{fmt_usd(hdr['live_spend'])}**")
    lines.append(f"- Period: **{hdr['period_start']} → {hdr['period_end']}**")
    lines.append("")
    lines.append("### Spend by agent")
    lines.append("")
    lines.append("| Agent | Transactions | Live Spend |")
    lines.append("|---|---|---|")
    for agent_name, txn_count, live_spend in hdr["per_agent"]:
        lines.append(f"| {agent_name} | {txn_count} | {fmt_usd(live_spend)} |")
    lines.append("")

    lines.append("## Check 1 — Double-count guard")
    lines.append("")
    icon = "✅" if c1["passed"] else "❌"
    lines.append(f"{icon} Naive sum (all cost rows, including superseded) vs live sum (superseded_at IS NULL only).")
    lines.append("")
    lines.append(f"- Naive (all rows): **{fmt_usd(c1['naive'])}**")
    lines.append(f"- Live (active only): **{fmt_usd(c1['live'])}**")
    lines.append(f"- Overstatement if naively summed: **{fmt_pct(c1['overstatement_pct'])}**")
    lines.append("")
    lines.append("Sapiom restates costs via supersession chains (initial estimate → captured final). "
                  "Summing every cost row double-counts every restated transaction; only the live row "
                  "reflects money actually moved.")
    lines.append("")

    lines.append("## Check 2 — Balance reconciliation")
    lines.append("")
    if "error" in c2:
        lines.append(f"❌ {c2['error']}")
    else:
        icon = "✅" if c2["passed"] else "❌"
        lines.append(f"{icon} Latest balance snapshot vs (initial_balance − live spend).")
        lines.append("")
        lines.append(f"- Initial balance (parameterized): **{fmt_usd(c2['initial_balance'])}**")
        lines.append(f"- Live spend to date: **{fmt_usd(c2['live_spend'])}**")
        lines.append(f"- Expected balance: **{fmt_usd(c2['expected_balance'])}**")
        lines.append(f"- Actual latest balance ({c2['fetched_at']}): **{fmt_usd(c2['latest_balance'])}**")
        lines.append(f"- Diff: **{fmt_usd(c2['diff'])}**")
    lines.append("")

    lines.append("## Check 3 — Revision analysis")
    lines.append("")
    if c3:
        lines.append("Sapiom restates costs; here's how much, by service.")
        lines.append("")
        lines.append("| Service | Revised Txns | Avg Revision % |")
        lines.append("|---|---|---|")
        for row in c3:
            lines.append(f"| {row['service_name']} | {row['revised_count']} | {fmt_pct(row['avg_revision_pct'])} |")
    else:
        lines.append("No transactions with more than one cost row were found — no supersession chains yet.")
    lines.append("")

    lines.append("## Check 4 — Chain integrity")
    lines.append("")
    a_icon = "✅" if not c4["orphan_superseded"] else "❌"
    lines.append(f"{a_icon} **(a) Orphan superseded rows** (superseded but no row supersedes them): "
                 f"**{len(c4['orphan_superseded'])}** found")
    if c4["orphan_superseded"]:
        lines.append("")
        lines.append("| Cost ID | Transaction ID | Amount | Superseded At |")
        lines.append("|---|---|---|---|")
        for cid, txn_id, amt, sup_at in c4["orphan_superseded"]:
            lines.append(f"| {cid} | {txn_id} | {fmt_usd(amt)} | {sup_at} |")
    lines.append("")

    b_icon = "✅" if not c4["zero_cost_completed"] else "❌"
    lines.append(f"{b_icon} **(b) Completed transactions with zero cost rows**: "
                 f"**{len(c4['zero_cost_completed'])}** found")
    if c4["zero_cost_completed"]:
        lines.append("")
        lines.append("| Transaction ID | Service | Completed At |")
        lines.append("|---|---|---|")
        for txn_id, service_name, completed_at in c4["zero_cost_completed"]:
            lines.append(f"| {txn_id} | {service_name} | {completed_at} |")
    lines.append("")

    c_icon = "✅" if not c4["double_live"] else "❌"
    lines.append(f"{c_icon} **(c) Transactions with >1 live cost row (double-charge bug)**: "
                 f"**{len(c4['double_live'])}** found")
    if c4["double_live"]:
        lines.append("")
        lines.append("| Transaction ID | Live Row Count | Total Live Amount |")
        lines.append("|---|---|---|")
        for txn_id, live_count, total in c4["double_live"]:
            lines.append(f"| {txn_id} | {live_count} | {fmt_usd(total)} |")
    lines.append("")

    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Audit spend.duckdb, write report.md")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"DuckDB file path (default {DEFAULT_DB})")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"Report output path (default {DEFAULT_OUT})")
    ap.add_argument("--initial-balance", default=str(DEFAULT_INITIAL_BALANCE),
                     help=f"Seeded account balance before any spend (default {DEFAULT_INITIAL_BALANCE})")
    args = ap.parse_args()

    con = duckdb.connect(args.db)
    report = render_report(con, Decimal(args.initial_balance))
    con.close()

    with open(args.out, "w") as f:
        f.write(report)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
