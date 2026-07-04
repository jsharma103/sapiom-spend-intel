#!/usr/bin/env python3
"""BUILD 1 — export the 5-tile CEO dashboard's data to dashboard_data.json.

Zero spend: reads spend.duckdb + dryrun/extrapolation_result.json only, no
network calls, no API key needed. Reuses audit.py's and findings.py's own
check functions (rather than re-deriving the SQL) so the dashboard numbers
are guaranteed to match report.md / findings.md exactly — single source of
truth per metric.

The 5-tile "demo cut" per BACKLOG.md's CEO DASHBOARD spec (panels 1,3,4,5,2):
  1. Float meter (held vs settled), from the extrapolation concurrency experiment
  2. Capital-efficiency ratio (Sigma settled / Sigma held, across chains)
  3. Reconciliation health (green/red), from audit.py checks 1+2
  4. Runaway detection (red-flagged agent), from findings.py's peer-relative detector
  5. Take-rate / margin strip, Sapiom price vs public provider price

Usage:
    python export_dashboard.py [--db spend.duckdb] [--extrapolation dryrun/extrapolation_result.json]
                                [--out dashboard_data.json]
"""
import argparse
import importlib.util
import json
from decimal import Decimal
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
DEFAULT_DB = str(HERE / "spend.duckdb")
DEFAULT_EXTRAPOLATION = str(HERE / "dryrun" / "extrapolation_result.json")
DEFAULT_OUT = str(HERE / "dashboard_data.json")

# Public provider prices, WebSearched 2026-07-04 (see RUN_LOG.md for the queries/sources):
#   OpenRouter gpt-4o-mini: $0.15 / 1M input tokens, $0.60 / 1M output tokens
#     (https://openrouter.ai/openai/gpt-4o-mini)
#   Linkup standard-depth search: ~$0.005/call (EUR5 per 1,000 standard queries)
#     (https://docs.linkup.so/pages/documentation/platform/pricing)
LINKUP_PUBLIC_PRICE_USD = 0.005
OPENROUTER_PUBLIC_INPUT_PER_1K = 0.00015
OPENROUTER_PUBLIC_OUTPUT_PER_1K = 0.00060


def _import_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


audit = _import_module("audit_mod", HERE / "audit.py")
findings = _import_module("findings_mod", HERE / "findings.py")


def jsonify(obj):
    """Recursively convert Decimal/None-friendly for json.dumps."""
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, dict):
        return {k: jsonify(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonify(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# Tile 1 — Float meter (held vs settled), from the concurrency experiment
# ---------------------------------------------------------------------------

def tile_float_meter(extrapolation_path: str) -> dict:
    try:
        with open(extrapolation_path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"available": False, "note": f"{extrapolation_path} not found"}

    exp_b = data.get("experiment_b")
    if not exp_b:
        return {"available": False, "note": "experiment_b missing from extrapolation_result.json"}

    initial = exp_b["initial_balance"]
    final = exp_b["final_balance"]
    min_bal = exp_b["min_balance"]

    peak_held = initial - min_bal        # max in-flight dip (holds parked, not yet settled)
    settled = initial - final            # actual money that moved by end of experiment
    ratio = (peak_held / settled) if settled else None

    return {
        "available": True,
        "agent_name": exp_b.get("agent_name"),
        "initial_balance": initial,
        "min_balance": min_bal,
        "final_balance": final,
        "peak_held_usd": peak_held,
        "settled_usd": settled,
        "held_over_settled_ratio": ratio,
        "verdict": exp_b.get("verdict"),
    }


# ---------------------------------------------------------------------------
# Tile 2 — Capital-efficiency ratio (Sigma settled / Sigma held, chains only)
# ---------------------------------------------------------------------------

def tile_capital_efficiency(con) -> dict:
    row = con.execute("""
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
        SELECT COALESCE(SUM(h.hold_amount), 0), COALESCE(SUM(f.final_amount), 0), COUNT(*)
        FROM hold h JOIN final f ON f.transaction_id = h.transaction_id
    """).fetchone()
    sum_held, sum_settled, n_chains = row
    ratio = (float(sum_settled) / float(sum_held)) if sum_held else None
    return {
        "n_chains": n_chains,
        "sum_held_usd": sum_held,
        "sum_settled_usd": sum_settled,
        "efficiency_ratio": ratio,
    }


# ---------------------------------------------------------------------------
# Tile 3 — Reconciliation health (audit.py checks 1 + 2, reused directly)
# ---------------------------------------------------------------------------

def tile_reconciliation(con, initial_balance: Decimal) -> dict:
    c1 = audit.q1_double_count_guard(con)
    c2 = audit.q2_balance_reconciliation(con, initial_balance)
    return {
        "double_count_guard_passed": c1["passed"],
        "naive_sum_usd": c1["naive"],
        "live_sum_usd": c1["live"],
        "overstatement_pct": c1["overstatement_pct"],
        "balance_reconciliation_passed": c2.get("passed"),
        "reconciliation_diff_usd": c2.get("diff"),
        "green": bool(c1["passed"] and c2.get("passed")),
    }


# ---------------------------------------------------------------------------
# Tile 4 — Runaway detection (findings.py's peer-relative detector, reused)
# ---------------------------------------------------------------------------

def tile_runaway(con) -> dict:
    result = findings.runaway_detection(con)
    per_agent = [
        {"agent_name": name, **stats}
        for name, stats in result["per_agent"].items()
    ]
    per_agent.sort(key=lambda a: (a["median_gap_s"] is None, -a["n"]))
    return {
        "flagged": result["flagged"],
        "per_agent": per_agent,
    }


# ---------------------------------------------------------------------------
# Tile 5 — Take-rate / margin strip
# ---------------------------------------------------------------------------

def tile_take_rate(con) -> dict:
    linkup = con.execute("""
        SELECT AVG(c.fiat_amount), COUNT(*)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.service_name = 'sapiom_linkup' AND c.superseded_at IS NULL
    """).fetchone()
    linkup_avg, linkup_n = linkup
    linkup_markup_pct = (
        (float(linkup_avg) - LINKUP_PUBLIC_PRICE_USD) / LINKUP_PUBLIC_PRICE_USD * 100
        if linkup_avg else None
    )

    llm = con.execute("""
        SELECT AVG(c.fiat_amount), MIN(c.fiat_amount), MAX(c.fiat_amount), COUNT(*)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.service_name = 'sapiom_openrouter' AND c.superseded_at IS NULL
    """).fetchone()
    llm_avg, llm_min, llm_max, llm_n = llm

    llm_held = con.execute("""
        SELECT AVG(c.fiat_amount), COUNT(*)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.service_name = 'sapiom_openrouter' AND c.superseded_at IS NOT NULL
    """).fetchone()
    llm_held_avg, llm_held_n = llm_held

    return {
        "linkup": {
            "sapiom_price_usd": linkup_avg,
            "public_price_usd": LINKUP_PUBLIC_PRICE_USD,
            "markup_pct": linkup_markup_pct,
            "n_calls": linkup_n,
            "note": "flat per-call price both sides (Linkup standard depth, sourcedAnswer output) — apples to apples.",
        },
        "openrouter": {
            "sapiom_settled_avg_usd": llm_avg,
            "sapiom_settled_min_usd": llm_min,
            "sapiom_settled_max_usd": llm_max,
            "sapiom_held_avg_usd": llm_held_avg,
            "public_input_per_1k_usd": OPENROUTER_PUBLIC_INPUT_PER_1K,
            "public_output_per_1k_usd": OPENROUTER_PUBLIC_OUTPUT_PER_1K,
            "n_settled": llm_n,
            "n_held": llm_held_n,
            "note": (
                "No token-usage counts are recorded in the ledger, so an exact per-token markup can't be "
                "computed (a real data-completeness gap, not just an omission here). What IS clear: Sapiom's "
                "pre-auth HOLD rate ($0.0006/1k max_tokens, established in cap_experiment/extrapolation) equals "
                "OpenRouter's public OUTPUT rate ($0.60/1M = $0.0006/1k) almost exactly — the hold prices every "
                "token as if it will be a full-price output token. Actual settled cost ($0.0001-$0.0005/call, "
                "avg ~$0.00019) is far below that, which is the float story (tile 1), not a take-rate story."
            ),
        },
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Export CEO dashboard data from spend.duckdb")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--extrapolation", default=DEFAULT_EXTRAPOLATION)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--initial-balance", default="5.00")
    args = ap.parse_args()

    con = duckdb.connect(args.db, read_only=True)

    header = audit.header_stats(con)

    data = {
        "generated_at": None,
        "header": {
            "n_txns": header["n_txns"],
            "n_agents": header["n_agents"],
            "live_spend_usd": header["live_spend"],
            "period_start": str(header["period_start"]),
            "period_end": str(header["period_end"]),
        },
        "tile_float_meter": tile_float_meter(args.extrapolation),
        "tile_capital_efficiency": tile_capital_efficiency(con),
        "tile_reconciliation": tile_reconciliation(con, Decimal(args.initial_balance)),
        "tile_runaway": tile_runaway(con),
        "tile_take_rate": tile_take_rate(con),
    }
    con.close()

    from datetime import datetime, timezone
    data["generated_at"] = datetime.now(timezone.utc).isoformat()

    payload = jsonify(data)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"Wrote {args.out}")

    # Also emit a JS-wrapped copy. dashboard.html includes this via a plain
    # <script src="dashboard_data.js"> tag rather than fetch()-ing the .json:
    # browsers (Chrome in particular) block fetch() of local files opened via
    # file:// with a CORS error, which would break the "opens with no
    # network / no server" acceptance criterion. A same-directory <script src>
    # has no such restriction, so this is what makes double-click-to-open work.
    js_out = str(Path(args.out).with_name("dashboard_data.js"))
    with open(js_out, "w") as f:
        f.write("window.DASHBOARD_DATA = ")
        json.dump(payload, f, indent=2, default=str)
        f.write(";\n")
    print(f"Wrote {js_out}")


if __name__ == "__main__":
    main()
