#!/usr/bin/env python3
"""BUILD 6/12 — export dashboard v2/v3 data to dashboard_data.js/.json.

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

BUILD 12 adds a second dashboard section, "Agent-native KPIs — proposed
definitions" (BOUNDED / VISIBLE / RECOVERABLE), assembled entirely from data
already computed above or in findings.py/spend.duckdb — no new spend, no new
external lookups. See tile_capital_overhang / tile_blast_radius_placeholder /
tile_cap_utilization_placeholder / tile_attribution_completeness /
tile_phantom_spend_rate / tile_hold_release_latency / tile_refund_on_failure /
kya_scorecard below.

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

# BUILD 9 — full 9-service take-rate table. Vendor public prices WebSearched 2026-07-04,
# full method/sources/confidence grading in take_rate.md. Only HIGH-confidence rows (exact
# operation match, no vendor plan-tier ambiguity) feed the dashboard + blended number:
LINKUP_SOURCED_ANSWER_PREMIUM_USD = 0.001  # docs.linkup.so: sourcedAnswer/structured add $1/1k over standard-depth
FAL_FLUX_SCHNELL_PER_MP_USD = 0.003  # fal.ai/models/fal-ai/flux/schnell, billed rounded up to nearest megapixel
ELEVENLABS_PER_CHAR_USD = 0.0001  # elevenlabs.io/pricing/api: $0.10 / 1,000 chars, multilingual v2
# OpenRouter sweep-call exact usage (14 prompt + 2 completion tokens) — read from the sweep
# response's usage block; hardcoded here because service_sweep_result.json truncates
# responseSample mid-string so it isn't valid re-parseable JSON (see take_rate.md).
OPENROUTER_SWEEP_PROMPT_TOKENS = 14
OPENROUTER_SWEEP_COMPLETION_TOKENS = 2
SWEEP_RESULT_PATH = HERE / "dryrun" / "service_sweep_result.json"

SCALE_TARGET_DAILY_TPV = 1_000_000  # the "$1M/day TPV" scale-hook, per BACKLOG BUILD 6

# Visible (not tooltip-only) scope disclosure for tiles built off the 27 LLM
# supersession chains observed tonight — 100% sapiom_openrouter, one session,
# one model. Adversarial-audit fix: this was previously disclosed only in a
# tooltip on one of three tiles that depend on it.
LLM_CHAIN_SCOPE_NOTE = "Scope: n=27 LLM chains (sapiom_openrouter only), one session, gpt-4o-mini — LLM-specific, not platform-wide."

# Direct dry-run test, NOT drawn from spend.duckdb's n=81 ingested sample: 4
# forced max_tokens=128000 calls that errored AFTER a hold was already placed
# (dryrun/hold_linearity_extension.md N=1 + dryrun/failure_capture_n3.md N=3
# replication). All 4 show availableBalance drop by exactly $0.076803 while
# totalBalance never moves (dryrun/hold_linearity_result.json,
# dryrun/failure_capture_n3_result.json, dryrun/refund_watch.log) — i.e. the
# hold is RETAINED/FROZEN (unavailable to spend), not swept into a completed
# charge against totalBalance, and not released either. Zero variance across
# all 4 observations. See findings.md §9 for the full two-case framing.
FAILURE_RETENTION_N = 4
FAILURE_RETENTION_RETAINED = 4
FAILURE_RETENTION_MEAN_USD = 0.076803


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
        f"at $1M/day TPV → ~{scale_multiple:,.0f}x tonight's pace (a ratio, not a load test — "
        "this pipeline has not been run at that volume)"
        if daily_rate_usd and scale_multiple else
        "n/a — no period data to compute a daily-rate multiple"
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

def hero_capture_ratio(con, hold_lifetime_p50_s=None, hold_lifetime_p95_s=None) -> dict:
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
    capture_per_dollar = ratio if ratio is not None else None
    overhang_ratio = (1 / ratio) if ratio else None

    # NAIVE per-day FLOW figure — kept for traceability only, NEVER displayed as a
    # "frozen" stock. This is a pure ratio effect (frozen$ = TPV/ratio - TPV): it has
    # no time/duration term, so it silently assumes hold lifetime scales with volume.
    # Forced into Little's-Law terms, it implies a ~4.57-DAY average hold lifetime —
    # the measured reality is 5.3-12.0 SECONDS (~33,000x shorter). See
    # dryrun/float_model.md §1 and §4d for the full derivation of why this number is
    # NOT a valid "frozen daily" claim (that was the dashboard bug this replaces).
    naive_flow_at_scale_usd = (SCALE_TARGET_DAILY_TPV / ratio - SCALE_TARGET_DAILY_TPV) if ratio else None

    # Little's Law (L = lambda * W), the rigorous instantaneous-frozen-capital model:
    # frozen$ = held_dollar_volume_per_day * (avg_hold_lifetime_sec / 86400). Every
    # input is measured or explicitly flagged as an assumption — see
    # dryrun/float_model.md §3/§4c. Hold lifetime = auth->capture latency for the
    # chained (LLM) service, findings.md §1 / tile_auth_to_capture (n=31,
    # sapiom_openrouter, p50=5.295s, p95=11.961s).
    instantaneous_frozen_p50_usd = (
        SCALE_TARGET_DAILY_TPV * (hold_lifetime_p50_s / 86400)
        if hold_lifetime_p50_s is not None else None
    )
    instantaneous_frozen_p95_usd = (
        SCALE_TARGET_DAILY_TPV * (hold_lifetime_p95_s / 86400)
        if hold_lifetime_p95_s is not None else None
    )

    if instantaneous_frozen_p50_usd is not None and instantaneous_frozen_p95_usd is not None:
        scale_note = (
            f"instantaneously frozen ≈ ${instantaneous_frozen_p50_usd:,.0f}"
            f"–${instantaneous_frozen_p95_usd:,.0f} at $1M/day TPV (Little's Law; holds "
            f"clear in {hold_lifetime_p50_s:.1f}–{hold_lifetime_p95_s:.1f}s) — lever = "
            "hold-lifetime & max_tokens right-sizing. Assumes steady-state (non-bursty) call "
            "arrivals — see dryrun/float_model.md §5."
        )
    else:
        scale_note = "n/a (hold-lifetime data unavailable)"

    return {
        "ratio_pct": ratio_pct,
        "sum_held_usd": sum_held,
        "sum_settled_usd": sum_settled,
        "n_chains": n_chains,
        "overhang_ratio": overhang_ratio,
        # Valence fix (adversarial audit): settling below the hold is the system
        # working as designed (holds released back down to real usage), not lost
        # revenue — a low % here is a float-inefficiency signal, not a capture
        # failure. Framed as "oversized holds", not "only 18% captured".
        "subline": (
            f"holds are ~{overhang_ratio:.1f}x oversized vs settlement — a float "
            f"inefficiency, not lost revenue (authorize $1.00 → capture ${capture_per_dollar:.2f})"
            if capture_per_dollar is not None else "n/a"
        ),
        "scale_note": scale_note,
        "scope_note": LLM_CHAIN_SCOPE_NOTE,
        "instantaneous_frozen_p50_usd": instantaneous_frozen_p50_usd,
        "instantaneous_frozen_p95_usd": instantaneous_frozen_p95_usd,
        "hold_lifetime_p50_s": hold_lifetime_p50_s,
        "hold_lifetime_p95_s": hold_lifetime_p95_s,
        # Retained only as an audit trail of the superseded/incorrect framing — see
        # method_note. NOT rendered anywhere as a "frozen" figure.
        "naive_flow_at_scale_usd": naive_flow_at_scale_usd,
        "method_note": (
            f"Sigma settled ({sum_settled:.6f}) / Sigma held ({sum_held:.6f}) dollar-weighted "
            f"across all {n_chains} supersession chains (hold → final capture). Little's Law: "
            "frozen$ = held$/day × (hold_lifetime_sec / 86400) — at $1M/day TPV, p50 "
            f"({hold_lifetime_p50_s:.2f}s) → ${instantaneous_frozen_p50_usd:,.2f}, p95 "
            f"({hold_lifetime_p95_s:.2f}s) → ${instantaneous_frozen_p95_usd:,.2f}. Full "
            "derivation + sensitivity: dryrun/float_model.md. (Superseded framing: naively "
            f"scaling the capture ratio gives ${naive_flow_at_scale_usd:,.0f} — a per-day FLOW, "
            "not an instantaneous stock; it implicitly assumes a ~4.57-day hold lifetime vs. "
            "the measured 5.3-12.0s, ~33,000x off. See float_model.md §4d.)"
            if hold_lifetime_p50_s is not None and hold_lifetime_p95_s is not None else
            f"Sigma settled ({sum_settled:.6f}) / Sigma held ({sum_held:.6f}) dollar-weighted "
            f"across all {n_chains} supersession chains (hold → final capture)."
        ),
    }


# ---------------------------------------------------------------------------
# Hero 3 — Reconciliation (audit.py checks 1 + 2, reused directly)
# ---------------------------------------------------------------------------

def hero_reconciliation(con, initial_balance: Decimal, ingest_as_of: str = None) -> dict:
    c1 = audit.q1_double_count_guard(con)
    c2 = audit.q2_balance_reconciliation(con, initial_balance)
    overstatement_pct = float(c1["overstatement_pct"])
    phantom_at_scale_usd = SCALE_TARGET_DAILY_TPV * overstatement_pct / 100
    ingest_note = (
        f"Ties out as of this ledger snapshot (ingested through {ingest_as_of}). The live account "
        "has since spent more in dry-run experiments not captured in this snapshot (see RUN_LOG.md) "
        "— re-ingest before claiming this ties out today."
        if ingest_as_of else
        "Ties out as of this ledger snapshot — re-ingest before claiming this ties out today."
    )

    return {
        "diff_usd": float(c2.get("diff")) if c2.get("diff") is not None else None,
        "green": bool(c1["passed"] and c2.get("passed")),
        "naive_sum_usd": float(c1["naive"]),
        "live_sum_usd": float(c1["live"]),
        "overstatement_pct": overstatement_pct,
        "subline": f"naive sum overstates +{overstatement_pct:.0f}% — must filter, not sum, chains",
        "scale_note": (
            f"at $1M/day TPV → ~${phantom_at_scale_usd/1000:,.0f}K/day phantom spend if uncorrected "
            "(assumes tonight's traffic mix/restatement rate holds at scale)"
        ),
        "ingest_note": ingest_note,
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
    # Adversarial-audit fix: dashboard.html used to hard-code "~0ms" for every flat
    # service regardless of its real value (one is actually -832ms). Compute the
    # real min/max across the flat rows' own p50/p95 so the tile can show an
    # honest range instead of a fabricated constant.
    flat_values_ms = [r["p50_ms"] for r in flat_rows] + [r["p95_ms"] for r in flat_rows]
    flat_min_ms = min(flat_values_ms) if flat_values_ms else None
    flat_max_ms = max(flat_values_ms) if flat_values_ms else None

    return {
        "rows": rows,
        "headline_service": headline["service_name"] if headline else None,
        "headline_n": headline["n"] if headline else None,
        "headline_p50_ms": headline["p50_ms"] if headline else None,
        "headline_p95_ms": headline["p95_ms"] if headline else None,
        "flat_n": flat_n,
        "flat_services_label": flat_services,
        "flat_min_ms": flat_min_ms,
        "flat_max_ms": flat_max_ms,
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
    """BUILD 9 — take-rate table sourced from the 9-service sweep
    (dryrun/service_sweep_result.json), not from spend.duckdb: the sweep is the only place
    all 9 services were exercised with a known request shape to price against vendor public
    rates. Full 9-row table + confidence grading + sources: take_rate.md. Only the 4
    HIGH-confidence rows (search, llm, images, audio) are dollar-weighted into the blended
    number shown on the dashboard; MED (scraping — vendor plan tier unknown) and DROP
    (compute — memory tier undisclosed) are take_rate.md-only, not on the dashboard.

    Adversarial-audit fix (round 2): the sweep is N=1 per service, but the search/Linkup
    row can be corroborated directly against every historical Linkup transaction in the
    ledger (spend.duckdb), not just the one sweep call — query it live here rather than
    hardcoding a count. Also: floor-artifact rows (llm, audio) no longer surface a raw
    percentage as the headline cell text (e.g. "+2,930.3%", "+233.3%") — a bare percentage
    next to a real 0%-markup row reads as a comparable take rate, which it is not. The raw
    number is kept in `markup_pct` for the record/tooltip/take_rate.md, but the rendered
    cell text is qualitative ("flat sub-cent settle").
    """
    with open(SWEEP_RESULT_PATH) as f:
        sweep = {r["service"]: r for r in json.load(f)["results"]}

    def markup_pct(charged, public):
        return (charged - public) / public * 100

    # Ledger corroboration for the search/Linkup row: every sapiom_linkup transaction's
    # single active cost row, not just the N=1 sweep call. Read-only query, spend.duckdb.
    linkup_ledger_rows = con.execute(
        """
        SELECT c.fiat_amount, count(*) AS n
        FROM transactions t
        JOIN costs c ON c.transaction_id = t.id
        WHERE t.service_name = 'sapiom_linkup' AND c.is_active = true
        GROUP BY c.fiat_amount
        """
    ).fetchall()
    linkup_ledger_n = sum(n for _, n in linkup_ledger_rows)
    linkup_ledger_all_identical = len(linkup_ledger_rows) == 1

    linkup = sweep["search"]
    linkup_charged = linkup["actualCostUsd"]
    linkup_public = LINKUP_PUBLIC_PRICE_USD + LINKUP_SOURCED_ANSWER_PREMIUM_USD

    llm = sweep["llm"]
    llm_charged = llm["actualCostUsd"]
    llm_public = (
        OPENROUTER_SWEEP_PROMPT_TOKENS / 1000 * OPENROUTER_PUBLIC_INPUT_PER_1K
        + OPENROUTER_SWEEP_COMPLETION_TOKENS / 1000 * OPENROUTER_PUBLIC_OUTPUT_PER_1K
    )

    images = sweep["images"]
    images_charged = images["actualCostUsd"]
    images_public = FAL_FLUX_SCHNELL_PER_MP_USD  # 512x512 = 0.262MP, rounds up to 1MP billed

    audio = sweep["audio"]
    audio_charged = audio["actualCostUsd"]
    audio_chars = len(audio["requestBody"]["text"])
    audio_public = audio_chars * ELEVENLABS_PER_CHAR_USD

    rows = [
        {
            "service": "search", "provider": "Linkup",
            "operation": "1 query, standard depth, sourcedAnswer",
            "sapiom_price_usd": linkup_charged, "public_price_usd": linkup_public,
            "markup_pct": markup_pct(linkup_charged, linkup_public), "confidence": "HIGH",
            "ledger_n": linkup_ledger_n,
            "ledger_all_identical": linkup_ledger_all_identical,
        },
        {
            "service": "llm", "provider": "OpenRouter (gpt-4o-mini)",
            "operation": "14 prompt + 2 completion tokens",
            "sapiom_price_usd": llm_charged, "public_price_usd": llm_public,
            "markup_pct": markup_pct(llm_charged, llm_public), "confidence": "HIGH",
        },
        {
            "service": "images", "provider": "Fal.ai (flux/schnell)",
            "operation": "1 image, 512x512 (1MP billed)",
            "sapiom_price_usd": images_charged, "public_price_usd": images_public,
            "markup_pct": markup_pct(images_charged, images_public), "confidence": "HIGH",
        },
        {
            "service": "audio", "provider": "ElevenLabs (multilingual v2)",
            "operation": f"text-to-speech, {audio_chars} characters",
            "sapiom_price_usd": audio_charged, "public_price_usd": audio_public,
            "markup_pct": markup_pct(audio_charged, audio_public), "confidence": "HIGH",
        },
    ]

    # Adversarial-audit fix: known-floor-artifact services (per-call minimum-billing
    # floor, not a real percentage markup — see take_rate.md "Notable finding").
    FLOOR_ARTIFACT_SERVICES = {"llm", "audio"}
    for r in rows:
        r["likely_floor_artifact"] = r["service"] in FLOOR_ARTIFACT_SERVICES
        # markup_display is what dashboard.html renders in the table cell. Floor-artifact
        # rows do NOT show their raw percentage here (2,930%/233% next to a genuine 0%
        # row misleads at a glance) — the raw number stays in markup_pct for the tooltip
        # and take_rate.md's full table.
        if r["likely_floor_artifact"]:
            r["markup_display"] = "flat sub-cent"
        elif r["service"] == "search":
            r["markup_display"] = f"0% spread (N={linkup_ledger_n})"
        else:
            r["markup_display"] = "0% spread"

    high_rows = [r for r in rows if r["confidence"] == "HIGH"]
    sum_charged = sum(r["sapiom_price_usd"] for r in high_rows)
    sum_public = sum(r["public_price_usd"] for r in high_rows)
    margin = sum_charged - sum_public
    # NOT displayed as a dashboard headline (adversarial-audit fix: this is N=1 call
    # per service, and 2 of the 4 rows are minimum-fee-floor artifacts, not real
    # markups — a single blended bps number falsely implies a statistically-grounded
    # unit-economics read). Kept only for cross-checking against take_rate.md.
    blended_take_rate_pct = margin / sum_charged * 100
    blended_markup_pct = margin / sum_public * 100

    for r in high_rows:
        r["margin_usd"] = r["sapiom_price_usd"] - r["public_price_usd"]
        r["margin_share_of_blended_pct"] = (r["margin_usd"] / margin * 100) if margin else None

    real_markup_services = [r["service"] for r in high_rows if not r["likely_floor_artifact"]]
    floor_artifact_services = [r["service"] for r in high_rows if r["likely_floor_artifact"]]
    floor_margin_share_pct = sum(
        r["margin_share_of_blended_pct"] or 0 for r in high_rows if r["likely_floor_artifact"]
    )

    return {
        "rows": rows,
        # Retained for cross-check against take_rate.md only — NOT a defensible headline:
        # it is a dollar-weighted blend of exactly 4 N=1 calls, and 100% of the margin
        # ($0.000797 of $0.000797) comes from the two floor-artifact rows (llm, audio) —
        # search and images contribute $0 margin each. Do not render this on the dashboard.
        "blended_take_rate_pct_not_a_headline": blended_take_rate_pct,
        "blended_take_rate_bps_not_a_headline": blended_take_rate_pct * 100,
        "blended_markup_pct_not_a_headline": blended_markup_pct,
        "n_high_rows": len(high_rows),
        "n_per_service": 1,
        "linkup_ledger_n": linkup_ledger_n,
        "linkup_ledger_all_identical": linkup_ledger_all_identical,
        "real_markup_services": real_markup_services,
        "floor_artifact_services": floor_artifact_services,
        "floor_margin_share_pct": floor_margin_share_pct,
        "note": (
            "9-service sweep (dryrun/service_sweep_result.json), N=1 call per service, full "
            "table + MED/DROP rows + sources in take_rate.md. No blended headline is shown: "
            f"the two real-dollar-volume services ({', '.join(real_markup_services)}) settle at "
            f"exactly vendor list price (0% markup — search is corroborated by all "
            f"{linkup_ledger_n} historical sapiom_linkup transactions in the ledger, not just "
            f"this N=1 sweep call, and all {linkup_ledger_n} settle at the identical "
            f"$0.006000); the two tiny-dollar rows ({', '.join(floor_artifact_services)}) are "
            "near-certain minimum-billing-floor artifacts, not percentage markups — their raw "
            "percentages are withheld from the tile's headline cell for that reason (see "
            "markup_pct on each row for the number, and take_rate.md for the full writeup). "
            "Of the dollar-weighted margin across all 4 rows, audio/ElevenLabs is ~88% and "
            "llm/OpenRouter is ~12% (recomputed from this same table — corrects "
            "take_rate.md's/NARRATIVE.md's earlier, backwards claim that the LLM row drove "
            "'almost entirely' of the margin). CAVEAT: every 'public price' in this table is "
            "the vendor's published retail list price, not Sapiom's actual negotiated cost "
            "(Sapiom likely gets volume/negotiated rates below retail, and does not publish "
            "its own per-call pricing) — so this table measures Sapiom-retail vs. "
            "vendor-retail (a build-vs-buy comparison for the agent), not Sapiom's true "
            "take rate against its own COGS. Full caveat in take_rate.md."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 10 — Loss rate (chargeback analog, bps of TPV)
# ---------------------------------------------------------------------------

def tile_loss_rate(con) -> dict:
    """Failed/errored transactions expressed in payments loss-rate language.
    Full queries + method: loss_rate.md."""
    n_txns = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    n_failed = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE outcome = 'error'"
    ).fetchone()[0]
    total_tpv = float(
        con.execute("SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL")
        .fetchone()[0]
    )
    failed_tpv = float(
        con.execute("""
            SELECT COALESCE(SUM(c.fiat_amount), 0)
            FROM costs c JOIN transactions t ON t.id = c.transaction_id
            WHERE t.outcome = 'error' AND c.superseded_at IS NULL
        """).fetchone()[0]
    )
    n_failed_with_cost_row = con.execute("""
        SELECT COUNT(DISTINCT t.id)
        FROM transactions t JOIN costs c ON c.transaction_id = t.id
        WHERE t.outcome = 'error'
    """).fetchone()[0]

    failed_pct = (n_failed / n_txns * 100) if n_txns else 0.0
    loss_rate_pct = (failed_tpv / total_tpv * 100) if total_tpv else 0.0

    return {
        "n_txns": n_txns,
        "n_failed": n_failed,
        "failed_pct": failed_pct,
        "total_tpv_usd": total_tpv,
        "failed_tpv_usd": failed_tpv,
        "loss_rate_pct": loss_rate_pct,
        "loss_rate_bps": loss_rate_pct * 100,
        "n_failed_with_cost_row": n_failed_with_cost_row,
        "note": (
            f"{n_failed}/{n_txns} txns failed ({failed_pct:.1f}%) but "
            f"{n_failed_with_cost_row}/{n_failed} produced a cost row — Sapiom did not charge "
            "for either failure in this sample (both were pre-settlement client/gateway errors, "
            "not mid-flight failures after a hold). Loss rate = 0 bps of TPV. Full queries + "
            "caveats: loss_rate.md."
        ),
        # Adversarial-audit fix (FIX 2): 0 bps covers only THIS sample's pre-hold
        # failures — do not let it read as "failures are always free". Cross-refs
        # the Refund-on-Failure tile's direct-test finding, corrected wording per
        # the totalBalance-vs-availableBalance evidence (retained/frozen, not a
        # completed charge — see tile_refund_on_failure).
        "cross_reference": (
            "0 bps applies only to this n=81 sample's pre-hold failures. Post-hold failures are "
            "NOT free: see Refund-on-Failure — in a direct test, 4/4 forced post-hold failures had "
            "their hold retained/frozen (not released), not this 0 bps rate."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 11 — Governance auth rate (footer footnote only — full detail in findings.md §7)
# ---------------------------------------------------------------------------

def tile_auth_rate(con) -> dict:
    total = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    # No governance denial exists in this ledger (no spending rule was active in the
    # sample) — see findings.md §7 for the full outcome-distribution table + caveat.
    denied = 0
    approved = total - denied
    auth_rate_pct = (approved / (approved + denied) * 100) if (approved + denied) else None
    return {
        "approved": approved,
        "denied": denied,
        "auth_rate_pct": auth_rate_pct,
        "note": (
            "No spending rules were active in this sample — 100% reflects an unconfigured "
            "account (nothing to deny), not proof governance works. Full distribution + "
            "caveat: findings.md §7."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 12 — Section 2 "Agent-native KPIs": BOUNDED
# ---------------------------------------------------------------------------

def tile_capital_overhang(capture_ratio: dict) -> dict:
    """BOUNDED — Capital Overhang Ratio = held$ / settled$, the inverse framing of
    Capture Ratio: same supersession chains, same data, read the other way
    ("dollars frozen per dollar that lands" instead of "% that lands")."""
    held = capture_ratio["sum_held_usd"]
    settled = capture_ratio["sum_settled_usd"]
    ratio = (held / settled) if settled else None
    p50 = capture_ratio.get("hold_lifetime_p50_s")
    p95 = capture_ratio.get("hold_lifetime_p95_s")
    # Adversarial-audit fix: without a duration, "5.6x held vs settled" reads like
    # capital parked indefinitely. It clears fast (same p50/p95 as Auth->Capture
    # Time / Hold-Release Latency) — say so on the tile, not just in a tooltip.
    clears_note = (
        f"Clears in {p50:.1f}–{p95:.1f}s — not permanently parked capital."
        if p50 is not None and p95 is not None else "n/a (hold-lifetime data unavailable)"
    )
    return {
        "overhang_ratio": ratio,
        "sum_held_usd": held,
        "sum_settled_usd": settled,
        "definition": "held$ ÷ settled$ across all supersession chains — same chains as Capture Ratio, inverse framing.",
        "clears_note": clears_note,
        "scope_note": LLM_CHAIN_SCOPE_NOTE,
        "method_note": (
            f"${held:.6f} held / ${settled:.6f} settled across {capture_ratio['n_chains']} chains = {ratio:.2f}x."
            if ratio is not None else "n/a"
        ),
    }


def tile_blast_radius_placeholder() -> dict:
    """BOUNDED — greyed placeholder, not a fake number. Max spend a single agent
    could reach before a governance cap stops it — requires an active spending
    rule to observe; none was active in this sample (BACKLOG #8, [HUMAN-UI])."""
    return {
        "available": False,
        "definition": "Max spend one agent reaches before a cap stops it.",
        "note": "Needs governance rules active — no spending rule was configured in this sample (BACKLOG #8, [HUMAN-UI]).",
    }


def tile_cap_utilization_placeholder() -> dict:
    """BOUNDED — greyed placeholder, not a fake number. Spend ÷ budget per agent —
    requires a configured per-agent budget (a governance spending rule) to have
    a denominator; none exists in this sample."""
    return {
        "available": False,
        "definition": "Spend ÷ budget, per agent.",
        "note": "Needs governance rules active — no per-agent budget exists without a spending rule configured.",
    }


# ---------------------------------------------------------------------------
# BUILD 12 — Section 2 "Agent-native KPIs": VISIBLE
# ---------------------------------------------------------------------------

def tile_attribution_completeness(con) -> dict:
    """VISIBLE — % of txns with a full context chain agent -> trace -> service ->
    result, i.e. agentName + traceId + service + outcome all non-null."""
    total = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    complete = con.execute("""
        SELECT COUNT(*) FROM transactions
        WHERE agent_name IS NOT NULL AND trace_id IS NOT NULL
          AND service_name IS NOT NULL AND outcome IS NOT NULL
    """).fetchone()[0]
    n_unknown_service = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE service_name = 'unknown'"
    ).fetchone()[0]
    pct = (complete / total * 100) if total else None
    return {
        "complete": complete,
        "total": total,
        "pct": pct,
        "n_unknown_service": n_unknown_service,
        "definition": "% of txns with agent, traceId, service, outcome all populated.",
        # Promoted to visible (muted) tile text, not tooltip-only (FIX 6).
        "visible_caveat": f"{n_unknown_service}/{total} txns carry service_name='unknown' — present, but unresolved.",
        "note": (
            f"{complete}/{total} txns have all 4 fields non-null (100%), but {n_unknown_service}/{total} "
            "carry service_name='unknown' — present, but an unresolved value, so non-null isn't always "
            "meaningfully attributed. Noted, not hidden."
        ),
    }


def tile_phantom_spend_rate(reconciliation: dict) -> dict:
    """VISIBLE — naive-sum overstatement vs. live spend: how wrong a supersession-
    naive pipeline reads the ledger. Same number as the Reconciliation hero's
    subline, reused rather than recomputed."""
    return {
        "overstatement_pct": reconciliation["overstatement_pct"],
        "naive_sum_usd": reconciliation["naive_sum_usd"],
        "live_sum_usd": reconciliation["live_sum_usd"],
        "definition": "Naive sum of every cost row vs. live (non-superseded) spend.",
        "method_note": reconciliation["method_note"],
    }


# ---------------------------------------------------------------------------
# BUILD 12 — Section 2 "Agent-native KPIs": RECOVERABLE
# ---------------------------------------------------------------------------

def tile_hold_release_latency(auth_to_capture: dict) -> dict:
    """RECOVERABLE — Hold-Release Latency: auth->capture time recast as a capital-
    freed metric (how long a held dollar stays frozen before the chain resolves
    it). Same numbers as the Auth -> Capture Time tile, reused."""
    n = auth_to_capture.get("headline_n")
    service = auth_to_capture["headline_service"]
    return {
        "p50_ms": auth_to_capture["headline_p50_ms"],
        "p95_ms": auth_to_capture["headline_p95_ms"],
        "service": service,
        "n": n,
        "definition": "p50/p95 time from hold to final capture (chained services only).",
        # FIX 4 — visible scope disclosure. Uses this tile's own real n (the chain
        # count feeding Capture Ratio/Capital Overhang is n=27; this tile is
        # sourced from findings.md §1's raw per-call latency instead, n=31 for
        # sapiom_openrouter) rather than restating a mismatched number.
        "scope_note": (
            f"Scope: {service} only (n={n}), one session, gpt-4o-mini — LLM-specific, not platform-wide."
            if n is not None else LLM_CHAIN_SCOPE_NOTE
        ),
    }


def tile_refund_on_failure(con) -> dict:
    """RECOVERABLE — Refund-on-Failure. Two-part honest framing (findings.md §9),
    rewritten per adversarial audit (this tile previously and WRONGLY said the
    mid-flight-failure case was "not yet run" — it was run and is confirmed):

    (1) In-sample: the n=81 ingested sample's only 2 natural failures were both
        PRE-hold (died during client/gateway setup) — neither ever held a cost,
        so there's nothing to release. This says nothing about post-hold failures.
    (2) Direct test: dryrun/hold_linearity_extension.md (N=1) +
        dryrun/failure_capture_n3.md (N=3 replication) forced 4 independent calls
        to error AFTER a hold was already placed. In all 4, availableBalance
        dropped by exactly $0.076803 (the full hold) while totalBalance never
        moved (dryrun/hold_linearity_result.json pre/post, dryrun/refund_watch.log)
        — i.e. the hold is RETAINED/FROZEN (unavailable to the customer), not
        swept into a completed charge against totalBalance, and not released
        either. Zero variance across all 4 observations.

    Honest caveat, stated on the tile: the per-failure retention mechanic is
    deterministic and measured (4/4) — how OFTEN a call fails post-hold in live
    traffic is NOT measured. Do not read this as a $/day loss rate.
    """
    n_failed = con.execute("SELECT COUNT(*) FROM transactions WHERE outcome='error'").fetchone()[0]
    n_failed_with_hold = con.execute("""
        SELECT COUNT(DISTINCT t.id) FROM transactions t JOIN costs c ON c.transaction_id = t.id
        WHERE t.outcome = 'error'
    """).fetchone()[0]
    retention_rate_pct = FAILURE_RETENTION_RETAINED / FAILURE_RETENTION_N * 100
    return {
        "n_failed": n_failed,
        "n_failed_with_hold": n_failed_with_hold,
        "direct_test_n": FAILURE_RETENTION_N,
        "direct_test_retained": FAILURE_RETENTION_RETAINED,
        "direct_test_retention_rate_pct": retention_rate_pct,
        "direct_test_mean_retained_usd": FAILURE_RETENTION_MEAN_USD,
        "definition": "% of a hold released back vs. retained/frozen, when a call fails after the hold is placed.",
        "subline": (
            f"{retention_rate_pct:.0f}% of hold retained/frozen on post-hold failure "
            f"({FAILURE_RETENTION_RETAINED}/{FAILURE_RETENTION_N} forced trials)"
        ),
        "note": (
            f"In-sample: {n_failed_with_hold}/{n_failed} of the n=81 sample's natural failures ever held a "
            "cost — both died pre-hold, so there was nothing to release (loss_rate.md). Direct test: when a "
            f"hold DOES exist and the call then errors, {FAILURE_RETENTION_RETAINED}/{FAILURE_RETENTION_N} "
            f"forced trials show the hold RETAINED/FROZEN — availableBalance dropped by exactly "
            f"${FAILURE_RETENTION_MEAN_USD:.6f} each time (zero variance) while totalBalance never moved, "
            "so this is not a completed charge, and it is not released either (findings.md §9; "
            "dryrun/failure_capture_n3.md; dryrun/hold_linearity_extension.md; dryrun/refund_watch.log — "
            "still being watched for a delayed release). Over-requested max_tokens makes the frozen amount "
            "larger. Honest caveat: the per-failure retention mechanic is deterministic and measured (4/4) "
            "— the FLEET FREQUENCY of post-hold failures in live traffic is NOT measured; do not read this "
            "as a $/day loss rate."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 12 — KYA Scorecard (closes Section 2): one row per agent, A-F velocity grade
# ---------------------------------------------------------------------------
#
# Adversarial-audit fix: this was labeled a "composite A-F risk grade" but is
# actually velocity-only — spend is displayed in the row but never enters the
# score (spend-runaway is ~54% of all TPV and grades C; fleet-test is ~0.4% of
# TPV and grades F). Relabeled "Velocity Grade" everywhere, with a visible
# "illustrative, velocity-only" caveat, rather than implying a spend-aware risk
# assessment that doesn't exist.

VELOCITY_RUNAWAY_POINTS = 60         # peer-relative velocity anomaly flag (findings.md §5)
VELOCITY_PEAK_POINTS_PER_CALL = 3    # points per call in the busiest rolling 60s window
VELOCITY_PEAK_POINTS_CAP = 30        # cap on the peak-burst contribution


def _velocity_grade_from_score(score: float) -> str:
    if score >= 75:
        return "F"
    if score >= 50:
        return "D"
    if score >= 25:
        return "C"
    if score >= 10:
        return "B"
    return "A"


def kya_scorecard(con) -> dict:
    """Section 2 close — one row per agent: spend, calls, velocity (median inter-
    call gap), peak calls/60s, anomaly flag -> illustrative A-F VELOCITY grade
    (spend is shown, not scored). Assembled from data already computed elsewhere
    (findings.py's runaway_detection + a live-spend-by-agent query), not
    recomputed independently, so it can never disagree with findings.md / the
    Velocity Checks tile."""
    runaway = findings.runaway_detection(con)
    spend_rows = con.execute("""
        SELECT t.agent_name, COALESCE(SUM(c.fiat_amount), 0)
        FROM transactions t
        LEFT JOIN costs c ON c.transaction_id = t.id AND c.superseded_at IS NULL
        WHERE t.agent_name IS NOT NULL
        GROUP BY 1
    """).fetchall()
    spend_by_agent = {name: float(spend) for name, spend in spend_rows}

    rows = []
    for name, stats in runaway["per_agent"].items():
        median_gap = stats["median_gap_s"]
        peak = stats["peak_calls_per_min"]
        is_runaway = bool(stats.get("runaway"))
        if median_gap is None:
            score = None
            grade = "N/A"
        else:
            score = (VELOCITY_RUNAWAY_POINTS if is_runaway else 0) + min(
                VELOCITY_PEAK_POINTS_CAP, (peak or 0) * VELOCITY_PEAK_POINTS_PER_CALL
            )
            grade = _velocity_grade_from_score(score)
        rows.append({
            "agent_name": name,
            "spend_usd": spend_by_agent.get(name, 0.0),
            "n_calls": stats["n"],
            "median_gap_s": median_gap,
            "peak_calls_per_min": peak,
            "runaway": is_runaway,
            "velocity_score": score,
            "velocity_grade": grade,
        })
    rows.sort(key=lambda r: (r["velocity_grade"] == "N/A", -(r["velocity_score"] if r["velocity_score"] is not None else -1)))

    return {
        "rows": rows,
        "visible_caveat": "Illustrative — velocity-only, one session; spend is shown but not a factor in this grade.",
        "formula_note": (
            f"Velocity score = {VELOCITY_RUNAWAY_POINTS} pts if peer-relative velocity anomaly flagged "
            f"(findings.md §5) + up to {VELOCITY_PEAK_POINTS_CAP} pts scaled from peak calls in any 60s "
            f"window (peak x {VELOCITY_PEAK_POINTS_PER_CALL}, capped). Grade: A 0-9 / B 10-24 / C 25-49 / "
            "D 50-74 / F 75-100. Agents with <3 calls show N/A — not enough data for a median gap. "
            "Spend is NOT part of this score (spend-runaway is ~54% of all TPV and grades C; fleet-test "
            "is ~0.4% of TPV and grades F) — velocity-only, illustrative, one session."
        ),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Export CEO dashboard v2/v3 data from spend.duckdb")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--initial-balance", default="5.00")
    args = ap.parse_args()

    con = duckdb.connect(args.db, read_only=True)

    header = audit.header_stats(con)
    auth_to_capture = tile_auth_to_capture(con)
    capture_ratio = hero_capture_ratio(
        con,
        hold_lifetime_p50_s=(
            auth_to_capture["headline_p50_ms"] / 1000
            if auth_to_capture["headline_p50_ms"] is not None else None
        ),
        hold_lifetime_p95_s=(
            auth_to_capture["headline_p95_ms"] / 1000
            if auth_to_capture["headline_p95_ms"] is not None else None
        ),
    )
    reconciliation = hero_reconciliation(
        con, Decimal(args.initial_balance),
        ingest_as_of=str(header["period_end"]) if header.get("period_end") else None,
    )

    data = {
        "generated_at": None,
        "header": {
            "n_txns": header["n_txns"],
            "n_agents": header["n_agents"],
            "live_spend_usd": header["live_spend"],
            "period_start": str(header["period_start"]),
            "period_end": str(header["period_end"]),
        },
        # ---- Section 1 — "Payments KPIs — measured on Sapiom" (BUILD 6/9/10/11,
        # reorganized/retitled by BUILD 12; numbers unchanged) --------------------
        "hero_tpv": hero_tpv(header),
        "hero_capture_ratio": capture_ratio,
        "hero_reconciliation": reconciliation,
        "tile_auth_to_capture": auth_to_capture,
        "tile_velocity_checks": tile_velocity_checks(con),
        "tile_take_rate": tile_take_rate(con),
        "tile_loss_rate": tile_loss_rate(con),
        "tile_auth_rate": tile_auth_rate(con),
        # ---- Section 2 — "Agent-native KPIs — proposed definitions" (BUILD 12) --
        "tile_capital_overhang": tile_capital_overhang(capture_ratio),
        "tile_blast_radius": tile_blast_radius_placeholder(),
        "tile_cap_utilization": tile_cap_utilization_placeholder(),
        "tile_attribution_completeness": tile_attribution_completeness(con),
        "tile_phantom_spend_rate": tile_phantom_spend_rate(reconciliation),
        "tile_hold_release_latency": tile_hold_release_latency(auth_to_capture),
        "tile_refund_on_failure": tile_refund_on_failure(con),
        "kya_scorecard": kya_scorecard(con),
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
