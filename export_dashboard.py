#!/usr/bin/env python3
"""BUILD 6 — export dashboard v2 "CEO KPI edition" data to dashboard_data.js/.json.

Zero spend: reads spend.duckdb + dryrun/extrapolation_result.json (unused by
v2's rendered tiles but kept as an input for parity/back-compat) only, no
network calls, no API key needed. Reuses audit.py's and findings.py's own
check functions (rather than re-deriving the SQL) so the dashboard numbers
are guaranteed to match report.md / findings.md exactly — single source of
truth per metric.

v2 layout per BACKLOG.md BUILD 6 (3 hero KPIs + 3 secondary tiles, payments-
executive vocabulary, audience = ex-Shopify payments director):
  HERO ROW
    1. TPV            - sum of live (non-superseded) costs
    2. CAPTURE RATIO   - Sigma settled / Sigma held across supersession chains
    3. RECONCILIATION  - balance ties out to $0.000000
  Each hero also carries a "scale hook": the same metric extrapolated to a
  hypothetical $1M/day TPV, computed from real data (not hardcoded).
  SECOND ROW
    4. AUTH -> CAPTURE TIME - settlement latency p50/p95 (findings.py reuse)
    5. VELOCITY CHECKS      - renamed runaway-detector (findings.py reuse)
    6. TAKE RATE            - per-service markup vs public list price

Usage:
    python export_dashboard.py [--db spend.duckdb] [--out dashboard_data.json]
"""
import argparse
import importlib.util
import json
from decimal import Decimal
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
DEFAULT_DB = str(HERE / "spend.duckdb")
DEFAULT_OUT = str(HERE / "dashboard_data.json")

# Public provider prices, WebSearched 2026-07-04 (see RUN_LOG.md for the queries/sources):
#   OpenRouter gpt-4o-mini: $0.15 / 1M input tokens, $0.60 / 1M output tokens
#     (https://openrouter.ai/openai/gpt-4o-mini)
#   Linkup standard-depth search: ~$0.005/call (EUR5 per 1,000 standard queries)
#     (https://docs.linkup.so/pages/documentation/platform/pricing)
LINKUP_PUBLIC_PRICE_USD = 0.005
OPENROUTER_PUBLIC_INPUT_PER_1K = 0.00015
OPENROUTER_PUBLIC_OUTPUT_PER_1K = 0.00060

SCALE_TARGET_DAILY_TPV = 1_000_000  # the "$1M/day TPV" scale-hook, per BACKLOG BUILD 6


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
# Hero 1 — TPV (Total Payment Volume)
# ---------------------------------------------------------------------------

def hero_tpv(header: dict) -> dict:
    live_spend = float(header["live_spend"])
    period_start, period_end = header["period_start"], header["period_end"]
    period_hours = None
    daily_rate_usd = None
    scale_multiple = None
    if period_start and period_end and period_end > period_start:
        period_hours = (period_end - period_start).total_seconds() / 3600
        if period_hours > 0:
            daily_rate_usd = live_spend / period_hours * 24
            if daily_rate_usd > 0:
                scale_multiple = SCALE_TARGET_DAILY_TPV / daily_rate_usd

    scale_note = (
        f"at $1M/day TPV → ~{scale_multiple:,.0f}x tonight's pace, same pipeline"
        if daily_rate_usd and scale_multiple else
        "same pipeline runs unchanged at $1M/day TPV"
    )
    method_note = (
        f"Tonight's fleet ran at a ~${daily_rate_usd:,.2f}/day pace over {header['n_txns']} txns / "
        f"{header['n_agents']} agents; scale multiple = $1M/day / that rate."
        if daily_rate_usd else "No period data available to compute a daily rate."
    )

    return {
        "value_usd": live_spend,
        "n_txns": header["n_txns"],
        "n_agents": header["n_agents"],
        "period_hours": period_hours,
        "daily_rate_usd": daily_rate_usd,
        "scale_multiple_to_1m_day": scale_multiple,
        "subline": f"{header['n_txns']} txns · {header['n_agents']} agents · live spend",
        "scale_note": scale_note,
        "method_note": method_note,
    }


# ---------------------------------------------------------------------------
# Hero 2 — Capture ratio (Sigma settled / Sigma held, across chains)
# ---------------------------------------------------------------------------

def hero_capture_ratio(con) -> dict:
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
    sum_held, sum_settled = float(sum_held), float(sum_settled)
    ratio = (sum_settled / sum_held) if sum_held else None
    ratio_pct = ratio * 100 if ratio is not None else None

    frozen_at_scale_usd = (SCALE_TARGET_DAILY_TPV / ratio - SCALE_TARGET_DAILY_TPV) if ratio else None
    capture_per_dollar = ratio if ratio is not None else None

    return {
        "ratio_pct": ratio_pct,
        "sum_held_usd": sum_held,
        "sum_settled_usd": sum_settled,
        "n_chains": n_chains,
        "subline": (
            f"authorize $1.00 → capture ${capture_per_dollar:.2f}"
            if capture_per_dollar is not None else "n/a"
        ),
        "scale_note": (
            f"at $1M/day TPV → ${frozen_at_scale_usd/1_000_000:.2f}M customer capital frozen daily"
            if frozen_at_scale_usd is not None else "n/a"
        ),
        "frozen_at_scale_usd": frozen_at_scale_usd,
        "method_note": (
            f"Sigma settled ({sum_settled:.6f}) / Sigma held ({sum_held:.6f}) dollar-weighted "
            f"across all {n_chains} supersession chains (hold → final capture)."
        ),
    }


# ---------------------------------------------------------------------------
# Hero 3 — Reconciliation (audit.py checks 1 + 2, reused directly)
# ---------------------------------------------------------------------------

def hero_reconciliation(con, initial_balance: Decimal) -> dict:
    c1 = audit.q1_double_count_guard(con)
    c2 = audit.q2_balance_reconciliation(con, initial_balance)
    overstatement_pct = float(c1["overstatement_pct"])
    phantom_at_scale_usd = SCALE_TARGET_DAILY_TPV * overstatement_pct / 100

    return {
        "diff_usd": float(c2.get("diff")) if c2.get("diff") is not None else None,
        "green": bool(c1["passed"] and c2.get("passed")),
        "naive_sum_usd": float(c1["naive"]),
        "live_sum_usd": float(c1["live"]),
        "overstatement_pct": overstatement_pct,
        "subline": f"naive sum overstates +{overstatement_pct:.0f}% — must filter, not sum, chains",
        "scale_note": f"at $1M/day TPV → ~${phantom_at_scale_usd/1000:,.0f}K/day phantom spend if uncorrected",
        "phantom_at_scale_usd": phantom_at_scale_usd,
        "method_note": (
            f"Latest balance snapshot vs (initial balance − live spend): diff ${c2.get('diff', 0):.6f}. "
            f"Naive = every cost row including superseded holds (${c1['naive']:.6f}); "
            f"live = superseded_at IS NULL only (${c1['live']:.6f})."
        ),
    }


# ---------------------------------------------------------------------------
# Tile 4 — Auth -> Capture time (findings.py's settlement_latency, reused)
# ---------------------------------------------------------------------------

def tile_auth_to_capture(con) -> dict:
    rows = findings.settlement_latency(con)
    headline = next((r for r in rows if r["service_name"] == "sapiom_openrouter"), None)
    flat_rows = [r for r in rows if r["service_name"] != "sapiom_openrouter"]
    flat_n = sum(r["n"] for r in flat_rows)
    flat_services = ", ".join(r["service_name"] for r in flat_rows)

    return {
        "rows": rows,
        "headline_service": headline["service_name"] if headline else None,
        "headline_p50_ms": headline["p50_ms"] if headline else None,
        "headline_p95_ms": headline["p95_ms"] if headline else None,
        "flat_n": flat_n,
        "flat_services_label": flat_services,
        # Method detail moves into a title= tooltip in dashboard.html (BACKLOG BUILD 6:
        # "any tile body >40 words: move method detail into title= tooltips"), not a
        # visible caption, to keep the tile within the v2 word budget.
        "footnote": (
            "Flat single-row services show a small negative latency — the cost row is written "
            "as part of authorization itself, before authorizedAt is stamped, not a bug. Only chained/"
            "restated services (LLM calls) show genuine positive wait for final capture."
        ),
    }


# ---------------------------------------------------------------------------
# Tile 5 — Velocity checks (findings.py's peer-relative runaway detector, reused)
# ---------------------------------------------------------------------------

def tile_velocity_checks(con) -> dict:
    result = findings.runaway_detection(con)
    per_agent = [
        {"agent_name": name, **stats}
        for name, stats in result["per_agent"].items()
    ]
    per_agent.sort(key=lambda a: (a["median_gap_s"] is None, a.get("runaway") is not True, -a["n"]))
    return {
        "flagged": result["flagged"],
        "per_agent": per_agent[:5],
    }


# ---------------------------------------------------------------------------
# Tile 6 — Take rate / margin (per-service markup vs public list price)
# ---------------------------------------------------------------------------

def tile_take_rate(con) -> dict:
    linkup = con.execute("""
        SELECT AVG(c.fiat_amount), COUNT(*)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.service_name = 'sapiom_linkup' AND c.superseded_at IS NULL
    """).fetchone()
    linkup_avg, linkup_n = linkup
    linkup_avg = float(linkup_avg) if linkup_avg is not None else None
    linkup_markup_pct = (
        (linkup_avg - LINKUP_PUBLIC_PRICE_USD) / LINKUP_PUBLIC_PRICE_USD * 100
        if linkup_avg else None
    )

    llm = con.execute("""
        SELECT AVG(c.fiat_amount), COUNT(*)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.service_name = 'sapiom_openrouter' AND c.superseded_at IS NULL
    """).fetchone()
    llm_avg, llm_n = llm
    llm_avg = float(llm_avg) if llm_avg is not None else None

    return {
        "linkup": {
            "service_label": "Linkup search",
            "sapiom_price_usd": linkup_avg,
            "public_price_usd": LINKUP_PUBLIC_PRICE_USD,
            "markup_pct": linkup_markup_pct,
            "n_calls": linkup_n,
        },
        "openrouter": {
            "service_label": "OpenRouter LLM (gpt-4o-mini, settled avg)",
            "sapiom_price_usd": llm_avg,
            "public_price_usd": None,
            "markup_pct": None,
            "n_calls": llm_n,
        },
        "note": (
            "Linkup is flat per-call both sides (apples-to-apples): Sapiom $0.006 vs public $0.005 -> +20%. "
            "OpenRouter has no clean per-call comparison (no token-usage field in this ledger to price against "
            "OpenRouter's public per-token rate) — shown for reference, markup n/a."
        ),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Export CEO dashboard v2 data from spend.duckdb")
    ap.add_argument("--db", default=DEFAULT_DB)
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
        "hero_tpv": hero_tpv(header),
        "hero_capture_ratio": hero_capture_ratio(con),
        "hero_reconciliation": hero_reconciliation(con, Decimal(args.initial_balance)),
        "tile_auth_to_capture": tile_auth_to_capture(con),
        "tile_velocity_checks": tile_velocity_checks(con),
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
    # has no such restriction, so this is what makes double-click-to-open work,
    # and it also works unchanged when served over GitHub Pages.
    js_out = str(Path(args.out).with_name("dashboard_data.js"))
    with open(js_out, "w") as f:
        f.write("window.DASHBOARD_DATA = ")
        json.dump(payload, f, indent=2, default=str)
        f.write(";\n")
    print(f"Wrote {js_out}")


if __name__ == "__main__":
    main()
