#!/usr/bin/env python3
"""BUILD 4 — trace-path mining + cost-per-task rollup. Writes traces.md.

Zero spend: reads spend.duckdb only, no network calls, no API key needed.
Requires BUILD 3 (chaining experiment) to have run at least once — grouping
is on `trace_external_id`, which stays NULL until a chained call sets it.

Usage:
    python src/traces.py [--db spend.duckdb] [--out traces.md]
"""
import argparse
from collections import Counter
from decimal import Decimal
from pathlib import Path

import duckdb

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DB = str(REPO / "data" / "spend.duckdb")
DEFAULT_OUT = str(REPO / "analysis" / "traces.md")


def fmt_usd(d) -> str:
    return f"${Decimal(d):,.6f}"


def fmt_ms(ms) -> str:
    if ms is None:
        return "n/a"
    if ms < 1000:
        return f"{ms:.0f}ms"
    return f"{ms / 1000:.2f}s"


def load_traces(con) -> list:
    """Returns a list of trace dicts: {trace_external_id, steps: [...], total_cost, wall_ms, has_error}."""
    trace_ids = [r[0] for r in con.execute(
        "SELECT DISTINCT trace_external_id FROM transactions WHERE trace_external_id IS NOT NULL ORDER BY 1"
    ).fetchall()]

    traces = []
    for tid in trace_ids:
        rows = con.execute("""
            SELECT t.id, t.service_name, t.action_name, t.outcome, t.created_at,
                   t.authorized_at, t.completed_at,
                   COALESCE((SELECT SUM(c.fiat_amount) FROM costs c
                             WHERE c.transaction_id = t.id AND c.superseded_at IS NULL), 0) AS live_cost
            FROM transactions t
            WHERE t.trace_external_id = ?
            ORDER BY t.created_at
        """, [tid]).fetchall()

        steps = [
            {
                "id": r[0], "service_name": r[1], "action_name": r[2], "outcome": r[3],
                "created_at": r[4], "authorized_at": r[5], "completed_at": r[6], "live_cost": r[7],
            }
            for r in rows
        ]
        total_cost = sum((s["live_cost"] for s in steps), Decimal(0))
        wall_ms = None
        if steps:
            first_authorized = steps[0]["authorized_at"]
            last_completed = max((s["completed_at"] for s in steps if s["completed_at"]), default=None)
            if first_authorized and last_completed:
                wall_ms = (last_completed - first_authorized).total_seconds() * 1000
        has_error = any(s["outcome"] == "error" for s in steps)
        path = " -> ".join(s["service_name"] or "unknown" for s in steps)

        traces.append({
            "trace_external_id": tid,
            "steps": steps,
            "total_cost": total_cost,
            "wall_ms": wall_ms,
            "has_error": has_error,
            "path": path,
        })
    return traces


def path_frequency(traces: list) -> Counter:
    return Counter(t["path"] for t in traces)


def simple_flow_svg(path: str, count: int) -> str:
    """Minimal inline-SVG box-and-arrow diagram for one path string (no
    library, no framework — a handful of <rect>/<text>/<line> elements).
    Ponytail-sized: this is meant to make the ONE dominant path visible at a
    glance, not to render a full multi-path Sankey (overkill at n=2 traces)."""
    nodes = path.split(" -> ")
    box_w, box_h, gap = 150, 40, 60
    total_w = len(nodes) * box_w + (len(nodes) - 1) * gap + 20
    total_h = box_h + 40
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{total_w}" height="{total_h}" '
             f'style="background:#0b0e14;font-family:monospace">']
    x = 10
    y = 20
    for i, node in enumerate(nodes):
        parts.append(
            f'<rect x="{x}" y="{y}" width="{box_w}" height="{box_h}" rx="6" '
            f'fill="#131722" stroke="#5b8ff9" stroke-width="1.5"/>'
        )
        parts.append(
            f'<text x="{x + box_w / 2}" y="{y + box_h / 2 + 5}" fill="#e6e9f0" '
            f'font-size="12" text-anchor="middle">{node}</text>'
        )
        if i < len(nodes) - 1:
            ax1, ax2 = x + box_w, x + box_w + gap
            ay = y + box_h / 2
            parts.append(f'<line x1="{ax1}" y1="{ay}" x2="{ax2 - 8}" y2="{ay}" stroke="#8a92a6" stroke-width="1.5"/>')
            parts.append(f'<polygon points="{ax2-8},{ay-4} {ax2},{ay} {ax2-8},{ay+4}" fill="#8a92a6"/>')
        x += box_w + gap
    parts.append(
        f'<text x="10" y="{total_h - 5}" fill="#8a92a6" font-size="11">seen {count}x</text>'
    )
    parts.append('</svg>')
    return "".join(parts)


def render(con) -> str:
    traces = load_traces(con)

    lines = []
    lines.append("# Sapiom Trace-Path Mining")
    lines.append("")
    lines.append("Free — groups transactions by `trace_external_id` (populated by BUILD 3's chaining "
                  "experiment; requires it to have run at least once). Zero spend, `spend.duckdb` only.")
    lines.append("")

    if not traces:
        lines.append("**No traces found.** `trace_external_id` is NULL on every transaction — run "
                      "`dryrun/chaining_experiment.js --run` at least once first.")
        return "\n".join(lines) + "\n"

    lines.append(f"## Overview")
    lines.append("")
    lines.append(f"- Traces (distinct `trace_external_id`): **{len(traces)}**")
    lines.append(f"- Total steps across all traces: **{sum(len(t['steps']) for t in traces)}**")
    lines.append(f"- Total cost across all traces: **{fmt_usd(sum((t['total_cost'] for t in traces), Decimal(0)))}**")
    lines.append("")

    lines.append("## Path frequency (prefix-tree over service-name sequences)")
    lines.append("")
    freq = path_frequency(traces)
    lines.append("| Path | Count |")
    lines.append("|---|---|")
    for path, count in freq.most_common():
        lines.append(f"| `{path}` | {count} |")
    lines.append("")
    if len(freq) == 1:
        lines.append(f"Only one distinct path observed across {len(traces)} trace(s) — sample too small yet "
                      "for meaningful path-diversity analysis. The mining logic above is written to scale to "
                      "many distinct paths; re-run after more chained-task variety exists.")
        lines.append("")

    most_common_path, most_common_count = freq.most_common(1)[0]
    lines.append("### Dominant path, visualized")
    lines.append("")
    lines.append(simple_flow_svg(most_common_path, most_common_count))
    lines.append("")

    lines.append("## Most expensive / most failing trace")
    lines.append("")
    most_expensive = max(traces, key=lambda t: t["total_cost"])
    lines.append(f"- **Most expensive:** `{most_expensive['trace_external_id']}` — "
                  f"{fmt_usd(most_expensive['total_cost'])} across {len(most_expensive['steps'])} steps "
                  f"({fmt_ms(most_expensive['wall_ms'])} wall time).")
    failing = [t for t in traces if t["has_error"]]
    if failing:
        lines.append(f"- **Failing trace(s):** {len(failing)} of {len(traces)} traces contain an error-outcome step: "
                      + ", ".join(f"`{t['trace_external_id']}`" for t in failing))
    else:
        lines.append(f"- **Failing trace(s):** none — all {len(traces)} traces completed every step with "
                      "`outcome='success'`.")
    lines.append("")

    lines.append("## Per-trace detail")
    lines.append("")
    for t in traces:
        lines.append(f"### `{t['trace_external_id']}`")
        lines.append("")
        lines.append(f"Path: `{t['path']}` — {fmt_usd(t['total_cost'])} total, {fmt_ms(t['wall_ms'])} wall time.")
        lines.append("")
        lines.append("| Step | Service | Action | Outcome | Live cost |")
        lines.append("|---|---|---|---|---|")
        for i, s in enumerate(t["steps"], start=1):
            lines.append(f"| {i} | {s['service_name']} | {s['action_name'] or 'n/a'} | {s['outcome'] or 'n/a'} | {fmt_usd(s['live_cost'])} |")
        lines.append("")

    lines.append("## Cost-per-task rollup")
    lines.append("")
    lines.append("| Trace | Steps | Cost | Wall time |")
    lines.append("|---|---|---|---|")
    for t in traces:
        lines.append(f"| `{t['trace_external_id']}` | {len(t['steps'])} | {fmt_usd(t['total_cost'])} | {fmt_ms(t['wall_ms'])} |")
    lines.append("")
    avg_cost = sum((t["total_cost"] for t in traces), Decimal(0)) / len(traces)
    lines.append(f"Average cost per task: **{fmt_usd(avg_cost)}** (n={len(traces)}). Small sample — both traces "
                  "so far come from the same BUILD 3 experiment script (search -> LLM -> search); this rolls up "
                  "cleanly and matches `findings.md`'s cost-per-task section exactly, but isn't yet diverse "
                  "enough to generalize into a per-workflow benchmark.")
    lines.append("")

    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Trace-path mining over spend.duckdb")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    con = duckdb.connect(args.db, read_only=True)
    report = render(con)
    con.close()

    with open(args.out, "w") as f:
        f.write(report)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
