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
    1. TPV              - sum of live (non-superseded) costs
    2. FROZEN CAPITAL    - live-account unrecovered holds snapshot (2026-07-07)
    3. RECONCILIATION    - balance ties out to $0.000000
  Capture Ratio (Sigma settled / Sigma held across supersession chains) demoted
  from hero row to the first tile of the Section-1 Detail grid 2026-07-07
  (LLM-only scope + workload-shaped magnitude).
  Each hero also carries a "scale hook": the same metric extrapolated to a
  hypothetical $1M/day TPV, computed from real data (not hardcoded).
  SECOND ROW
    4. AUTH -> CAPTURE TIME - settlement latency p50/p95 (findings.py reuse)
    5. VELOCITY CHECKS      - renamed runaway-detector (findings.py reuse)

BUILD 12 adds a second dashboard section, "Agent-native KPIs — proposed
definitions" (BOUNDED / VISIBLE / RECOVERABLE), assembled entirely from data
already computed above or in findings.py/spend.duckdb — no new spend, no new
external lookups. See tile_effective_budget / tile_concurrency_leak_factor /
tile_ledger_blind_spots / tile_cost_per_task_traceability / tile_hold_recovery /
tile_refunds_disputes / kya_scorecard below.
Section 2 restructured 2026-07-07: tile_capital_overhang and
tile_phantom_spend_rate cut from render (data still emitted, unrendered);
tile_blast_radius + tile_cap_utilization merged into tile_effective_budget
(both still individually emitted too); tile_attribution_completeness renamed/
redefined as tile_ledger_blind_spots; tile_hold_release_latency +
tile_refund_on_failure merged into tile_hold_recovery (both still
individually emitted too); tile_refunds_disputes added as a locked
placeholder (no mechanism exists to measure it).

Usage:
    python src/export_dashboard.py [--db spend.duckdb] [--out dashboard_data.json]
"""
import argparse
import importlib.util
import json
from decimal import Decimal
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DEFAULT_DB = str(REPO / "data" / "spend.duckdb")
DEFAULT_OUT = str(REPO / "dashboard_data.json")

SCALE_TARGET_DAILY_TPV = 1_000_000  # the "$1M/day TPV" scale-hook, per BACKLOG BUILD 6

# Traffic segmentation (2026-07-07): the ledger now mixes the original organic
# fleet with adversarial-experiment agents (governance race tests, blast-radius
# cap probes, double-count probes, forced failure captures, Little's-Law
# validation, hold-extension / idempotency / boundary tests). Their traffic is
# real ledger data but experiment-shaped by design (deliberately lazy max_tokens
# caps, forced post-hold errors), so fleet-level float metrics are computed
# BOTH ways: "organic" excludes any agent whose name starts with one of these
# prefixes; "all-traffic" includes everything. Headlines use organic; the
# all-traffic figure is disclosed alongside, never silently blended in.
EXPERIMENT_AGENT_PREFIXES = (
    "race-", "blast-", "doublecount-", "failure-capture-", "ll-validation",
    "hold-ext", "ladder-", "r5-boundary", "r3-idem", "bounded-test", "holdtest-",
    "survey-",
)


def _experiment_sql_predicate(alias: str = "t") -> str:
    """SQL predicate matching adversarial-experiment txns by agent-name prefix
    (see EXPERIMENT_AGENT_PREFIXES). Use as `NOT {predicate}` for organic."""
    return "(" + " OR ".join(
        f"{alias}.agent_name LIKE '{p}%'" for p in EXPERIMENT_AGENT_PREFIXES
    ) + ")"


def _llm_chain_scope_note(n_organic_chains: int, n_all_chains: int) -> str:
    """Visible (not tooltip-only) scope disclosure for tiles built off the LLM
    supersession chains — 100% sapiom_openrouter, gpt-4o-mini. Chain counts are
    computed, split organic vs incl.-adversarial-experiments (adversarial-audit
    fix: was a hardcoded 'n=27 ... one session')."""
    return (
        f"Scope: n={n_organic_chains} organic LLM chains "
        f"(n={n_all_chains} incl. adversarial experiments; sapiom_openrouter only, "
        "gpt-4o-mini) — LLM-specific, not platform-wide."
    )

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

def hero_tpv(header: dict, frozen_capital: dict) -> dict:
    """Headline = SETTLED volume only (payments TPV = settled, not held).
    live_spend (every active/non-superseded cost row) silently includes frozen
    holds — money on calls that never executed (denied) or never settled
    (failed post-hold) — so it overstates TPV. settled = live_spend minus the
    Frozen Capital hero's total (reused, not recomputed — see hero_frozen_capital)."""
    live_spend = float(header["live_spend"])
    frozen_total = frozen_capital["frozen_total_usd"]
    settled_spend = live_spend - frozen_total
    period_start, period_end = header["period_start"], header["period_end"]
    period_hours = None
    daily_rate_usd = None
    scale_multiple = None
    if period_start and period_end and period_end > period_start:
        period_hours = (period_end - period_start).total_seconds() / 3600
        if period_hours > 0:
            daily_rate_usd = settled_spend / period_hours * 24
            if daily_rate_usd > 0:
                scale_multiple = SCALE_TARGET_DAILY_TPV / daily_rate_usd

    scale_note = (
        f"at $1M/day TPV → ~{scale_multiple:,.0f}x the observed {period_hours:.0f}h pace "
        "(a ratio, not a load test — this pipeline has not been run at that volume)"
        if daily_rate_usd and scale_multiple else
        "n/a — no period data to compute a daily-rate multiple"
    )
    # Period-aware (was "Tonight's fleet" — the observed window has since grown
    # beyond one night; hours are computed from period_start/period_end).
    # Hero tile now shows only the big number + a computed count line + a
    # one-line italic definition (BUILD: hero glanceability pass, 2026-07-07) —
    # everything below absorbs into this tooltip instead: the settled = live -
    # frozen derivation, why denied/failure holds are excluded, the observed
    # window, and the $1M/day pace ratio with its load-test caveat.
    method_note = (
        f"TPV = settled volume only: live spend ${live_spend:.6f} (every active cost row) minus "
        f"${frozen_total:.6f} frozen holds (see Frozen Capital) = ${settled_spend:.6f} settled. "
        f"Frozen holds are excluded because they never became real spend: "
        f"{frozen_capital['n_denied_holds']} denied-call holds were placed on calls that never "
        f"executed, and {frozen_capital['n_failure_holds']} failure holds never settled after a "
        f"post-hold error. Observed over {period_hours:.0f}h ({header['n_txns']} txns / "
        f"{header['n_agents']} agents) — a ~${daily_rate_usd:,.2f}/day settled pace; at $1M/day TPV "
        f"that's ~{scale_multiple:,.0f}x the observed pace (a ratio, not a load test — this pipeline "
        "has not been run at that volume)."
        if daily_rate_usd else "No period data available to compute a daily rate."
    )

    return {
        "value_usd": settled_spend,
        "n_txns": header["n_txns"],
        "n_agents": header["n_agents"],
        "period_hours": period_hours,
        "daily_rate_usd": daily_rate_usd,
        "scale_multiple_to_1m_day": scale_multiple,
        "subline": f"{header['n_txns']} txns · {header['n_agents']} agents",
        "definition": "Money that actually moved — settled charges only, holds excluded.",
        "scale_note": scale_note,
        "method_note": method_note,
    }


# ---------------------------------------------------------------------------
# Hero 2 — Capture ratio (Sigma settled / Sigma held, across chains)
# ---------------------------------------------------------------------------

def _chain_sums(con, where: str = "") -> tuple:
    """(Sigma held, Sigma settled, n_chains) across hold→final-capture
    supersession chains. `where` is an optional WHERE fragment on the joined
    transactions alias t — used to split the organic fleet from adversarial-
    experiment traffic (see EXPERIMENT_AGENT_PREFIXES)."""
    row = con.execute(f"""
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
        JOIN transactions t ON t.id = h.transaction_id
        {where}
    """).fetchone()
    return float(row[0]), float(row[1]), row[2]


def hero_capture_ratio(con, hold_lifetime_p50_s=None, hold_lifetime_p95_s=None,
                       hold_lifetime_p50_s_all=None, hold_lifetime_p95_s_all=None) -> dict:
    """Headline = ORGANIC fleet (adversarial-experiment agents excluded); the
    all-traffic figure (incl. governance races, forced failure captures,
    deliberately lazy caps) is computed alongside and disclosed in the subline/
    method_note, never silently blended into the headline. The hold_lifetime_*
    args are the ORGANIC percentiles (Little's Law must use the same population
    as the overhang it multiplies); *_all are the all-traffic percentiles."""
    sum_held, sum_settled, n_chains = _chain_sums(
        con, f"WHERE NOT {_experiment_sql_predicate('t')}"
    )
    sum_held_all, sum_settled_all, n_chains_all = _chain_sums(con)
    ratio = (sum_settled / sum_held) if sum_held else None
    ratio_pct = ratio * 100 if ratio is not None else None
    ratio_all = (sum_settled_all / sum_held_all) if sum_held_all else None
    ratio_pct_all = ratio_all * 100 if ratio_all is not None else None
    capture_per_dollar = ratio if ratio is not None else None
    overhang_ratio = (1 / ratio) if ratio else None
    overhang_ratio_all = (1 / ratio_all) if ratio_all else None

    # NAIVE per-day FLOW figure — kept for traceability only, NEVER displayed as a
    # "frozen" stock. This is a pure ratio effect (frozen$ = TPV/ratio - TPV): it has
    # no time/duration term, so it silently assumes hold lifetime scales with volume.
    # Forced into Little's-Law terms, it implies a multi-DAY average hold lifetime
    # (computed below as naive_implied_lifetime_days) — the measured reality is
    # SECONDS. See dryrun/float_model.md §1 and §4d for the full derivation of why
    # this number is NOT a valid "frozen daily" claim (that was the dashboard bug
    # this replaces). Organic ratio, to match the headline.
    naive_flow_at_scale_usd = (SCALE_TARGET_DAILY_TPV / ratio - SCALE_TARGET_DAILY_TPV) if ratio else None
    naive_implied_lifetime_days = (
        naive_flow_at_scale_usd / SCALE_TARGET_DAILY_TPV
        if naive_flow_at_scale_usd is not None else None
    )

    # Little's Law (L = lambda * W), the rigorous instantaneous-frozen-capital model:
    # frozen$ = held_dollar_volume_per_day * (avg_hold_lifetime_sec / 86400). Every
    # input is measured or explicitly flagged as an assumption — see
    # dryrun/float_model.md §3/§4c. Hold lifetime = auth->capture latency for the
    # chained (LLM) service, findings.md §1, ORGANIC txns only (computed by
    # _organic_hold_lifetimes in main(); tile_auth_to_capture is now all-traffic).
    # Bug fix (2026-07-07): held$/day, not settled$/day (= SCALE_TARGET_DAILY_TPV),
    # is the correct Little's-Law input — held = settled x overhang_ratio. Organic
    # overhang x organic lifetimes: both factors from the same population.
    instantaneous_frozen_p50_usd = (
        SCALE_TARGET_DAILY_TPV * overhang_ratio * (hold_lifetime_p50_s / 86400)
        if hold_lifetime_p50_s is not None and overhang_ratio is not None else None
    )
    instantaneous_frozen_p95_usd = (
        SCALE_TARGET_DAILY_TPV * overhang_ratio * (hold_lifetime_p95_s / 86400)
        if hold_lifetime_p95_s is not None and overhang_ratio is not None else None
    )

    if instantaneous_frozen_p50_usd is not None and instantaneous_frozen_p95_usd is not None:
        scale_note = (
            f"to sustain $1M/day of settled spend at the organic fleet's shape, customer wallets carry ≈ "
            f"${instantaneous_frozen_p50_usd:,.0f}–${instantaneous_frozen_p95_usd:,.0f} frozen at any instant "
            "(Little's Law, validated live within 9% — dryrun/ll_validation.md; organic holds "
            f"clear in {hold_lifetime_p50_s:.1f}–{hold_lifetime_p95_s:.1f}s; held volume = "
            f"{overhang_ratio:.1f}x settled) — levers: hold-lifetime & max_tokens right-sizing. "
            "Assumes steady-state arrivals — float_model.md §5."
        )
    else:
        scale_note = "n/a (hold-lifetime data unavailable)"

    # How far off the naive framing is vs the measured (organic) hold lifetime —
    # computed, not hardcoded (was "~4.57-day ... ~33,000x", frozen at the old data).
    naive_off_multiple = (
        naive_implied_lifetime_days * 86400 / hold_lifetime_p95_s
        if naive_implied_lifetime_days is not None and hold_lifetime_p95_s else None
    )

    return {
        # Headline scope = organic fleet; *_all = incl. adversarial experiments.
        "ratio_pct": ratio_pct,
        "ratio_pct_all": ratio_pct_all,
        "sum_held_usd": sum_held,
        "sum_settled_usd": sum_settled,
        "n_chains": n_chains,
        "sum_held_usd_all": sum_held_all,
        "sum_settled_usd_all": sum_settled_all,
        "n_chains_all": n_chains_all,
        "overhang_ratio": overhang_ratio,
        "overhang_ratio_all": overhang_ratio_all,
        # Valence fix (adversarial audit): settling below the hold is the system
        # working as designed (holds released back down to real usage), not lost
        # revenue — a low % here is a float-inefficiency signal, not a capture
        # failure. Framed as "oversized holds", not "only N% captured". Both
        # traffic segments shown; experiments force oversized holds by design.
        "subline": (
            f"holds are ~{overhang_ratio:.1f}x oversized vs settlement — a float "
            f"inefficiency, not lost revenue (authorize $1.00 → capture ${capture_per_dollar:.2f})"
            f" · organic fleet {ratio_pct:.0f}% · incl. adversarial experiments {ratio_pct_all:.1f}%"
            " · capture % is workload-shaped (cap hygiene): right-sized ~100% · lazy 16k caps ~1%"
            if capture_per_dollar is not None and ratio_pct_all is not None else "n/a"
        ),
        "scale_note": scale_note,
        "scope_note": _llm_chain_scope_note(n_chains, n_chains_all),
        "instantaneous_frozen_p50_usd": instantaneous_frozen_p50_usd,
        "instantaneous_frozen_p95_usd": instantaneous_frozen_p95_usd,
        "hold_lifetime_p50_s": hold_lifetime_p50_s,
        "hold_lifetime_p95_s": hold_lifetime_p95_s,
        "hold_lifetime_p50_s_all": hold_lifetime_p50_s_all,
        "hold_lifetime_p95_s_all": hold_lifetime_p95_s_all,
        # Retained only as an audit trail of the superseded/incorrect framing — see
        # method_note. NOT rendered anywhere as a "frozen" figure.
        "naive_flow_at_scale_usd": naive_flow_at_scale_usd,
        "naive_implied_lifetime_days": naive_implied_lifetime_days,
        "method_note": (
            f"Organic fleet (experiment agents excluded): Sigma settled ({sum_settled:.6f}) / "
            f"Sigma held ({sum_held:.6f}) dollar-weighted across {n_chains} supersession chains "
            f"(hold → final capture) = {ratio_pct:.1f}%. All traffic incl. adversarial experiments: "
            f"{sum_settled_all:.6f} / {sum_held_all:.6f} across {n_chains_all} chains = "
            f"{ratio_pct_all:.1f}% — experiments force oversized holds by design, dragging the "
            "blended ratio down. Little's Law: frozen$ = settled$/day × overhang × "
            "(hold_lifetime_sec/86400) — at $1M/day TPV, organic p50 "
            f"({hold_lifetime_p50_s:.2f}s) → ${instantaneous_frozen_p50_usd:,.2f}, p95 "
            f"({hold_lifetime_p95_s:.2f}s) → ${instantaneous_frozen_p95_usd:,.2f}. Full "
            "derivation + sensitivity: dryrun/float_model.md. (Superseded framing: naively "
            f"scaling the organic capture ratio gives ${naive_flow_at_scale_usd:,.0f} — a per-day "
            f"FLOW, not an instantaneous stock; it implicitly assumes a "
            f"~{naive_implied_lifetime_days:.2f}-day hold lifetime vs. the measured "
            f"{hold_lifetime_p50_s:.1f}–{hold_lifetime_p95_s:.1f}s, ≥{naive_off_multiple:,.0f}x off. "
            "See float_model.md §4d.)"
            if hold_lifetime_p50_s is not None and hold_lifetime_p95_s is not None else
            f"Organic: Sigma settled ({sum_settled:.6f}) / Sigma held ({sum_held:.6f}) dollar-weighted "
            f"across {n_chains} supersession chains (hold → final capture) = {ratio_pct:.1f}%; "
            f"all traffic incl. adversarial experiments: {ratio_pct_all:.1f}% across {n_chains_all} chains."
        ),
    }


# ---------------------------------------------------------------------------
# Hero 2 — Frozen Capital (live-account unrecovered holds snapshot)
# ---------------------------------------------------------------------------

def hero_frozen_capital() -> dict:
    """Live-account snapshot of unrecovered holds — sourced from dry-run
    experiment artifacts + a live balance snapshot (2026-07-07), NOT from
    spend.duckdb (the ingested n=81 sample predates these holds). Sources:
    dryrun/denial_analytics.md (85 denied-call holds, $0.221047 live),
    dryrun/failure_capture_n3.md + hold_linearity_extension.md (4 failure
    holds x $0.076803 = $0.307212), live GET /v1/accounts 2026-07-07
    (unavailableBalance $0.528259 = the two sources exactly, to the
    micro-dollar)."""
    frozen_total_usd = 0.528502
    wallet_total_usd = 4.707228
    frozen_pct_of_wallet = 11.2
    n_holds = 89
    n_failure_holds = 4
    failure_holds_usd = 0.307212
    n_denied_holds = 85
    denied_holds_usd = 0.221290
    days_observed = 3
    n_released = 0
    snapshot_at = "2026-07-07"

    # Hero tile now shows only the big number + the RELEASED/DAYS chip + a
    # computed count line + a one-line italic definition (BUILD: hero
    # glanceability pass, 2026-07-07) — both former paragraphs (the "third
    # state" mechanic and the "failure mechanic is deterministic" evidence)
    # move into this tooltip instead of the tile body.
    return {
        "frozen_total_usd": frozen_total_usd,
        "wallet_total_usd": wallet_total_usd,
        "frozen_pct_of_wallet": frozen_pct_of_wallet,
        "n_holds": n_holds,
        "n_failure_holds": n_failure_holds,
        "failure_holds_usd": failure_holds_usd,
        "n_denied_holds": n_denied_holds,
        "denied_holds_usd": denied_holds_usd,
        "days_observed": days_observed,
        "n_released": n_released,
        "snapshot_at": snapshot_at,
        "subline": f"{frozen_pct_of_wallet}% of wallet · {n_failure_holds} failed + {n_denied_holds} denied holds",
        "definition": "Money stuck in a third state — not charged, not returned, no void mechanism.",
        "scale_note": "failure mechanic is deterministic — 4/4 forced post-hold failures froze the full max_tokens-priced hold; denial-after-hold froze 85/85. Frequency of post-hold failures in organic traffic is NOT measured — do not read this as a $/day loss rate.",
        "method_note": (
            f"Live account snapshot {snapshot_at}: unavailableBalance ${frozen_total_usd:.6f} = "
            f"{n_failure_holds} x $0.076803 failure holds (failure_capture_n3.md, "
            f"hold_linearity_extension.md) = ${failure_holds_usd:.6f} + ${denied_holds_usd:.6f} live "
            f"holds on {n_denied_holds} denied transactions (denial_analytics.md) — ties to the "
            "micro-dollar, and equals the Reconciliation hero's total-vs-available gap. Cross-checked "
            f"live: sampled failure holds still isActive:true, supersededAt:null, {days_observed} days "
            "after placement (refund_watch.log). Money sits in a third state: not charged "
            "(totalBalance untouched by the hold), not returned (availableBalance stays reduced) — no "
            "release/void API exists, and no backend sweep has been observed reclaiming it. The "
            f"failure mechanic is deterministic: {n_failure_holds}/{n_failure_holds} forced post-hold "
            f"failures froze the full max_tokens-priced hold, and {n_denied_holds}/{n_denied_holds} "
            "denials froze theirs too — but the frequency of post-hold failures in organic "
            "(non-adversarial) traffic is NOT measured; do not read this as a $/day loss rate."
        ),
    }


# ---------------------------------------------------------------------------
# Hero 3 — Reconciliation (audit.py checks 1 + 2, reused directly)
# ---------------------------------------------------------------------------

def _latest_snapshot_balances(con) -> dict:
    """Pull total/available/unavailable from the latest balance snapshot's raw JSON.
    balance_snapshots.balance stores totalBalance only; the four-way split lives in
    the raw payload."""
    row = con.execute(
        "SELECT raw FROM balance_snapshots ORDER BY fetched_at DESC LIMIT 1"
    ).fetchone()
    if not row or row[0] is None:
        return {}
    raw = row[0]
    data = json.loads(raw) if isinstance(raw, str) else raw

    def find(obj):
        if isinstance(obj, dict):
            if "availableBalance" in obj:
                return obj
            for v in obj.values():
                hit = find(v)
                if hit:
                    return hit
        elif isinstance(obj, list):
            for v in obj:
                hit = find(v)
                if hit:
                    return hit
        return None

    b = find(data) or {}
    dec = lambda x: Decimal(str(x)) if x is not None else None
    return {
        "total": dec(b.get("totalBalance")),
        "available": dec(b.get("availableBalance")),
        "unavailable": dec(b.get("unavailableBalance")),
    }


def hero_reconciliation(con, initial_balance: Decimal, frozen_capital: dict, ingest_as_of: str = None) -> dict:
    """Headline = the tie/mismatch STATE (rendered as the big-number chip in
    dashboard.html), not the $0.000000 diff magnitude — a first-time viewer
    reads a big "$0.000000" as broken, not "ties out". Reuses the Frozen
    Capital hero's total (not recomputed) to state the wallet partition and to
    cross-check that the total-vs-available gap matches it to the micro-dollar."""
    c1 = audit.q1_double_count_guard(con)
    c2 = audit.q2_balance_reconciliation(con, initial_balance)
    overstatement_pct = float(c1["overstatement_pct"])
    phantom_at_scale_usd = SCALE_TARGET_DAILY_TPV * overstatement_pct / 100

    # Reconcile against availableBalance, not totalBalance. Every active (non-
    # superseded) cost row — settlement OR still-frozen hold — reduces
    # availableBalance, so (initial - Sum active costs) must equal availableBalance
    # exactly. It does, to the micro-dollar: the ledger IS internally consistent.
    # totalBalance sits higher because frozen holds have not settled against it;
    # that total-vs-available gap is precisely the frozen capital (Hero 2), so the
    # reconciliation now SURFACES the frozen number instead of silently failing.
    live = c2.get("live_spend") or Decimal(0)
    bals = _latest_snapshot_balances(con)
    avail = bals.get("available")
    total = bals.get("total")
    expected_available = initial_balance - live
    diff_vs_available = abs(avail - expected_available) if avail is not None else c2.get("diff")
    frozen_gap = (total - avail) if (total is not None and avail is not None) else None
    ties = diff_vs_available is not None and diff_vs_available < audit.BALANCE_TOLERANCE

    frozen_total = frozen_capital["frozen_total_usd"]
    settled_usd = float(live) - frozen_total
    # Only claim the cross-check "matches" if the live-snapshot gap actually
    # equals the Frozen Capital hero's independently-sourced total, to the
    # micro-dollar — never hardcoded.
    frozen_matches = frozen_gap is not None and round(float(frozen_gap), 6) == round(frozen_total, 6)
    frozen_match_note = (
        f"gap to totalBalance = ${float(frozen_gap):.6f} — matches Frozen Capital exactly"
        if frozen_matches else
        f"gap to totalBalance = ${float(frozen_gap):.6f} vs Frozen Capital ${frozen_total:.6f} — mismatch, investigate"
        if frozen_gap is not None else "n/a — no balance snapshot to compute the gap"
    )
    ingest_prefix = f"Reconciled against the live snapshot ingested through {ingest_as_of}. " if ingest_as_of else ""

    # Wallet partition (settled + frozen + available) — the hero tile's
    # context line now shows this instead of the raw diff (BUILD: hero
    # glanceability pass, 2026-07-07). Only claim the "=" partition form if
    # the three genuinely sum to the initial balance to the micro-dollar;
    # otherwise fall back to the diff line so a real break stays visible.
    partition_sum = (settled_usd + frozen_total + float(avail)) if avail is not None else None
    partition_ties = partition_sum is not None and abs(partition_sum - float(initial_balance)) <= 0.000001
    context_line = (
        f"settled ${settled_usd:.2f} + frozen ${frozen_total:.2f} + available ${float(avail):.2f} = "
        f"${partition_sum:.6f}"
        if partition_ties else
        f"diff ±${float(diff_vs_available):.6f} — ledger-predicted vs live availableBalance"
        if diff_vs_available is not None else "n/a"
    )

    return {
        "diff_usd": float(diff_vs_available) if diff_vs_available is not None else None,
        "green": bool(c1["passed"] and ties),
        "reconciled_against": "availableBalance",
        "available_balance_usd": float(avail) if avail is not None else None,
        "total_balance_usd": float(total) if total is not None else None,
        "frozen_gap_usd": float(frozen_gap) if frozen_gap is not None else None,
        "frozen_matches": frozen_matches,
        "settled_usd": settled_usd,
        "naive_sum_usd": float(c1["naive"]),
        "live_sum_usd": float(c1["live"]),
        "overstatement_pct": overstatement_pct,
        # Context line — the wallet partition, directly beneath the ± state
        # headline (adversarial-audit fix 2026-07-07: a bare "$0.000000"
        # headline read as broken, not "ties out").
        "subline": context_line,
        "definition": "My ledger predicts the live account balance to the micro-dollar.",
        # Second visible line — the cross-check against Frozen Capital. Cut
        # from the tile body 2026-07-07 (folded into method_note instead).
        "frozen_match_note": frozen_match_note,
        # Demoted from the primary subline into this tile's small-print slot.
        # Was pointed at the Phantom Spend Rate tile (Section 2); that tile was
        # cut from render 2026-07-07, so this now points at its own tooltip.
        # Cut from the tile body 2026-07-07 (folded into method_note instead).
        "scale_note": f"naive sum overstates +{overstatement_pct:.0f}% — must filter, not sum, chains; full derivation in the tooltip",
        "phantom_at_scale_usd": phantom_at_scale_usd,
        "method_note": (
            ingest_prefix +
            (f"initial ${float(initial_balance):.6f} − Sum active cost rows ${float(live):.6f} = "
            f"${float(expected_available):.6f} = availableBalance (diff ${float(diff_vs_available):.6f}). "
            f"totalBalance ${float(total):.6f} is higher by ${float(frozen_gap):.6f} = frozen holds "
            f"({frozen_match_note}). Wallet partition (full precision): settled ${settled_usd:.6f} + "
            f"frozen ${frozen_total:.6f} + available ${float(avail):.6f} = ${partition_sum:.6f} of the "
            f"initial ${float(initial_balance):.6f}. Naive sum (every cost row incl. superseded) "
            f"${c1['naive']:.6f} vs live (superseded_at IS NULL) ${c1['live']:.6f} — naive sum "
            f"overstates +{overstatement_pct:.0f}% — must filter, not sum, chains."
            if (avail is not None and total is not None and frozen_gap is not None) else
            f"Naive ${c1['naive']:.6f} vs live ${c1['live']:.6f}.")
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


def _organic_hold_lifetimes(con, service_name: str) -> dict:
    """Auth→final-capture latency percentiles for `service_name`, ORGANIC txns
    only (adversarial-experiment agents excluded) — the same measurement as
    findings.settlement_latency, filtered. Feeds the organic headlines of
    Capture Ratio (Little's Law), Capital Overhang and Hold-Release Latency;
    tile_auth_to_capture itself stays all-traffic."""
    rows = con.execute(f"""
        SELECT EPOCH_MS(c.created_at) - EPOCH_MS(t.authorized_at)
        FROM transactions t
        JOIN costs c ON c.transaction_id = t.id AND c.superseded_at IS NULL
        WHERE t.authorized_at IS NOT NULL AND t.service_name = ?
          AND NOT {_experiment_sql_predicate('t')}
    """, [service_name]).fetchall()
    lat = [r[0] for r in rows if r[0] is not None]
    if not lat:
        return {"n": 0, "p50_ms": None, "p95_ms": None}
    return {
        "n": len(lat),
        "p50_ms": findings.percentile(lat, 50),
        "p95_ms": findings.percentile(lat, 95),
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
# BUILD 10 — Loss rate (chargeback analog, bps of TPV)
# ---------------------------------------------------------------------------

def tile_loss_rate(con) -> dict:
    """Failed/errored transactions expressed in payments loss-rate language.

    Semantics fix (2026-07-07): loss rate in payments = SETTLED charges for
    failed service, as bps of TPV. A cost row on a failed txn is only a loss if
    it actually settled. The ledger's 4 known post-hold failure rows (forced
    failure-capture experiments, $0.076803 each) are RETAINED/FROZEN holds —
    isActive:true, supersededAt:null, and live evidence shows totalBalance
    never moved (dryrun/refund_watch.log) — so they are frozen capital (Hero 2),
    not charged loss. SQL split used here: a live cost row that supersedes a
    prior hold (supersedes_cost_id IS NOT NULL) is an actual final settlement;
    a live, never-superseded, supersedes-nothing row on an outcome='error' txn
    is a retained/frozen hold. (Caveat: a flat-service auth-time charge on a
    failed txn would land in the frozen bucket under this rule — zero such rows
    exist in this ledger; all 4 error-txn cost rows match the known frozen
    holds to the micro-dollar.) Full queries + method: loss_rate.md."""
    n_txns = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    n_failed = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE outcome = 'error'"
    ).fetchone()[0]
    total_tpv = float(
        con.execute("SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL")
        .fetchone()[0]
    )
    # SETTLED charges on failed txns — live rows that are the final capture of a
    # supersession chain. This is the loss-rate numerator.
    n_settled_loss, settled_loss_usd = con.execute("""
        SELECT COUNT(DISTINCT t.id), COALESCE(SUM(c.fiat_amount), 0)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.outcome = 'error' AND c.superseded_at IS NULL
          AND c.supersedes_cost_id IS NOT NULL
    """).fetchone()
    # RETAINED/FROZEN holds on failed txns — live, never part of a chain.
    # Counted under the Frozen Capital hero, NOT here.
    n_frozen_holds, frozen_holds_usd = con.execute("""
        SELECT COUNT(DISTINCT t.id), COALESCE(SUM(c.fiat_amount), 0)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE t.outcome = 'error' AND c.superseded_at IS NULL
          AND c.supersedes_cost_id IS NULL
    """).fetchone()
    settled_loss_usd, frozen_holds_usd = float(settled_loss_usd), float(frozen_holds_usd)
    n_failed_pre_hold = n_failed - n_settled_loss - n_frozen_holds

    failed_pct = (n_failed / n_txns * 100) if n_txns else 0.0
    loss_rate_pct = (settled_loss_usd / total_tpv * 100) if total_tpv else 0.0
    loss_rate_bps = loss_rate_pct * 100

    frozen_clause = (
        f" ${frozen_holds_usd:.6f} of holds FROZEN on {n_frozen_holds} forced post-hold "
        f"failures (${frozen_holds_usd / n_frozen_holds:.6f} each) — counted under the Frozen "
        "Capital hero, not as charged loss: totalBalance never moved, so nothing settled "
        f"(dryrun/refund_watch.log). The other {n_failed_pre_hold} (natural) failures died "
        "pre-hold — no cost row at all."
        if n_frozen_holds else
        f" None of the {n_failed} failures carries a retained hold."
    )

    return {
        "n_txns": n_txns,
        "n_failed": n_failed,
        "failed_pct": failed_pct,
        "total_tpv_usd": total_tpv,
        "settled_loss_usd": settled_loss_usd,
        "frozen_holds_usd": frozen_holds_usd,
        "n_failed_with_frozen_hold": n_frozen_holds,
        "n_failed_pre_hold": n_failed_pre_hold,
        "loss_rate_pct": loss_rate_pct,
        "loss_rate_bps": loss_rate_bps,
        # Feeds dashboard.html's "{n}/{n_failed} charged" subline — "charged" =
        # actually settled, so this counts settled losses only. The frozen-hold
        # rows carry a cost row but nothing was charged; they are broken out in
        # n_failed_with_frozen_hold / frozen_holds_usd above.
        "n_failed_with_cost_row": n_settled_loss,
        "note": (
            f"{n_failed}/{n_txns} txns failed ({failed_pct:.1f}%); {n_settled_loss}/{n_failed} "
            f"settled a charge for the failed call → loss rate = {loss_rate_bps:.0f} bps of TPV "
            f"(${settled_loss_usd:.6f} settled loss)." + frozen_clause +
            " Full queries + caveats: loss_rate.md."
        ),
        # Cross-ref (adversarial-audit fix, recomputed 2026-07-07): the bps figure
        # counts settled charges only — do not let it read as "failures are free".
        # The frozen-hold evidence is the Auth Reversal on Failure tile's direct test
        # (retained/frozen per totalBalance-vs-availableBalance, not a completed
        # charge — see tile_refund_on_failure).
        "cross_reference": (
            f"{loss_rate_bps:.0f} bps counts settled charges only, across all {n_txns} txns "
            "(organic fleet + adversarial experiments). Post-hold failures are NOT free: see "
            f"Auth Reversal on Failure and the Frozen Capital hero — {n_frozen_holds} forced post-hold "
            f"failures each froze their full hold (${frozen_holds_usd:.6f} total), neither "
            "released nor settled."
            if n_frozen_holds else
            f"{loss_rate_bps:.0f} bps counts settled charges only, across all {n_txns} txns. "
            "Post-hold failure behavior: see Auth Reversal on Failure."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 11 — Governance auth rate (footer footnote only — full detail in findings.md §7)
# ---------------------------------------------------------------------------

def tile_auth_rate(con) -> dict:
    # Denials are marked via status='denied' (outcome is NULL on denied txns, since
    # they never reach an outcome). Approved = reached/passed authorization.
    denied = con.execute("SELECT COUNT(*) FROM transactions WHERE status = 'denied'").fetchone()[0]
    approved = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE status IN ('completed', 'authorized')"
    ).fetchone()[0]
    auth_rate_pct = (approved / (approved + denied) * 100) if (approved + denied) else None
    note = (
        "No spending rules were active in this sample — 100% reflects an unconfigured "
        "account (nothing to deny), not proof governance works. 100% only holds when no "
        "spending rules are active: a prior live snapshot with governance experiments "
        "active (see dryrun/denial_analytics.md / "
        "experiments/03_governance_cumulative_double_count.md) saw 86 denials and a real "
        "auth rate of ≈ 74%."
        if denied == 0 else
        f"100% only when no spending rules are active — this live snapshot includes "
        f"{denied} denials from governance experiments (see dryrun/denial_analytics.md / "
        f"experiments/03_governance_cumulative_double_count.md). Real auth rate under "
        f"those experiment rules ≈ {auth_rate_pct:.0f}%."
    )
    return {
        "approved": approved,
        "denied": denied,
        "auth_rate_pct": auth_rate_pct,
        "note": note,
    }


# ---------------------------------------------------------------------------
# Tile 8 — ATV (Average Transaction Value)
# ---------------------------------------------------------------------------

def tile_atv(con, hero_tpv: dict) -> dict:
    """ATV = settled volume / settled txn count. Settled volume is NOT
    recomputed here — reused directly from the TPV hero (live spend minus
    frozen holds; see hero_tpv). Settled txn count = distinct transactions
    whose live cost row is a true settlement, i.e. excludes the 4 frozen-
    failure-hold txns (outcome='error', live, not part of a supersession
    chain — same predicate as tile_loss_rate's frozen-hold bucket) and the
    85 denied-hold txns (status='denied'). Cross-checked: summing
    fiat_amount over exactly this txn set reproduces the TPV hero's settled
    volume to the micro-dollar."""
    settled_volume_usd = hero_tpv["value_usd"]
    n_settled_txns = con.execute("""
        SELECT COUNT(DISTINCT t.id)
        FROM costs c JOIN transactions t ON t.id = c.transaction_id
        WHERE c.superseded_at IS NULL
          AND t.status != 'denied'
          AND NOT (t.outcome = 'error' AND c.supersedes_cost_id IS NULL)
    """).fetchone()[0]
    atv_usd = (settled_volume_usd / n_settled_txns) if n_settled_txns else None
    period_hours = hero_tpv.get("period_hours")

    return {
        "atv_usd": atv_usd,
        "settled_volume_usd": settled_volume_usd,
        "n_settled_txns": n_settled_txns,
        "subline": (
            f"settled ${settled_volume_usd:.6f} ÷ {n_settled_txns} settled txns"
            if atv_usd is not None else "n/a"
        ),
        "caption": (
            "Card rails carry a fixed per-transaction fee component (on the order of $0.30 on "
            "typical US card pricing) — 2–3 orders of magnitude above this ATV. Sub-cent "
            "transactions are the economic case for x402-style rails: agent spend is too small "
            "for card economics to process profitably."
        ),
        "scope_note": (
            f"ATV is workload-shaped — this fleet's mix (LLM-dominated, incl. adversarial "
            f"experiments) over one {period_hours:.0f}h window; not a market measurement."
            if period_hours else
            "ATV is workload-shaped — this fleet's mix (LLM-dominated, incl. adversarial "
            "experiments); not a market measurement."
        ),
        "method_note": (
            f"ATV = settled volume ÷ settled txn count = ${settled_volume_usd:.6f} / "
            f"{n_settled_txns} = ${atv_usd:.6f}. Settled volume reused from the TPV hero "
            "(live spend minus frozen holds). Settled txn = distinct transaction with a live "
            "cost row, excluding the 4 frozen-failure-hold txns (outcome='error', live, not "
            "part of a supersession chain) and the 85 denied-hold txns (status='denied')."
            if atv_usd is not None else "n/a — no settled transactions."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 12 — Section 2 "Agent-native KPIs": BOUNDED
# ---------------------------------------------------------------------------

def tile_capital_overhang(capture_ratio: dict) -> dict:
    """BOUNDED — Capital Overhang Ratio = held$ / settled$, the inverse framing of
    Capture Ratio: same supersession chains, same data, read the other way
    ("dollars frozen per dollar that lands" instead of "% that lands").
    Headline = organic fleet, matching the Capture Ratio tile; all-traffic
    (incl. adversarial experiments) disclosed alongside."""
    held = capture_ratio["sum_held_usd"]
    settled = capture_ratio["sum_settled_usd"]
    ratio = (held / settled) if settled else None
    held_all = capture_ratio["sum_held_usd_all"]
    settled_all = capture_ratio["sum_settled_usd_all"]
    ratio_all = (held_all / settled_all) if settled_all else None
    p50 = capture_ratio.get("hold_lifetime_p50_s")
    p95 = capture_ratio.get("hold_lifetime_p95_s")
    # Adversarial-audit fix: without a duration, "held vs settled" reads like
    # capital parked indefinitely. It clears fast (organic p50/p95, same numbers
    # as Hold-Release Latency) — say so on the tile, not just in a tooltip. The
    # organic/all split is stated here too, so the visible tile carries it.
    clears_note = (
        f"Organic fleet {ratio:.2f}x (headline) · {ratio_all:.2f}x incl. adversarial experiments. "
        f"Clears in {p50:.1f}–{p95:.1f}s (organic) — not permanently parked capital."
        if p50 is not None and p95 is not None and ratio is not None and ratio_all is not None
        else "n/a (hold-lifetime data unavailable)"
    )
    return {
        "overhang_ratio": ratio,
        "overhang_ratio_all": ratio_all,
        "sum_held_usd": held,
        "sum_settled_usd": settled,
        "sum_held_usd_all": held_all,
        "sum_settled_usd_all": settled_all,
        "definition": "held$ ÷ settled$ across all supersession chains — same chains as Capture Rate ($-weighted), inverse framing.",
        "clears_note": clears_note,
        "scope_note": capture_ratio["scope_note"],
        "method_note": (
            f"Organic: ${held:.6f} held / ${settled:.6f} settled across "
            f"{capture_ratio['n_chains']} chains = {ratio:.2f}x · incl. adversarial experiments: "
            f"${held_all:.6f} / ${settled_all:.6f} across {capture_ratio['n_chains_all']} chains "
            f"= {ratio_all:.2f}x."
            if ratio is not None and ratio_all is not None else "n/a"
        ),
    }


def tile_blast_radius() -> dict:
    """BOUNDED — real spend an agent reaches before its usage_limit cap denies it.
    Measured on blast-test agents (parallel session, read from ledger) + our own
    r5/doublecount runs. Always < the configured cap: the double-count
    (experiments/03) halves the effective budget, and a single max_tokens hold
    >= cap bricks the agent at $0. LLM-only, small sample."""
    return {
        "available": True,
        "headline_pct_range": "0–45% of cap",
        "definition": "Real spend an agent reaches before its cap denies it.",
        "finding": "Always less than the configured cap — the double-count (experiments/03) halves the effective budget, and one max_tokens hold ≥ cap bricks the agent at $0.",
        "rows": [
            {"agent": "blast-test-500", "cap_usd": 0.002, "max_tokens": 500, "calls_before_stop": 9, "spend_before_stop_usd": 0.0009, "pct_of_cap": 45},
            {"agent": "blast-test-2000", "cap_usd": 0.002, "max_tokens": 2000, "calls_before_stop": 4, "spend_before_stop_usd": 0.0004, "pct_of_cap": 20},
            {"agent": "blast-test-8000", "cap_usd": 0.002, "max_tokens": 8000, "calls_before_stop": 0, "spend_before_stop_usd": 0.0, "pct_of_cap": 0},
        ],
        "caveat": "n=3 test agents, one $0.002 cap, LLM-only. blast-test agents read from the ledger (parallel session), corroborated by our own r5/doublecount runs.",
    }


def tile_cap_utilization() -> dict:
    """BOUNDED — spend ÷ budget at the instant the cap denies a call. True
    utilization vs the engine's reported ~100%; the gap is the double-count
    (experiments/03). LLM-only, small sample."""
    return {
        "available": True,
        "headline_pct_range": "54–80%",
        "definition": "Spend ÷ budget at the moment the cap denies a call. (the credit-utilization analog)",
        "finding": "Agents are cut off at 54–80% of their real budget while the engine reports ~100% — the gap is the double-count (experiments/03).",
        "rows": [
            {"agent": "doublecount-confirm", "cap_usd": 0.004, "true_spend_usd": 0.002143, "true_util_pct": 54, "engine_util_pct": 100},
            {"agent": "blast-test-500", "cap_usd": 0.002, "true_spend_usd": 0.001202, "true_util_pct": 60, "engine_util_pct": 100},
            {"agent": "r5-boundary", "cap_usd": 0.005, "true_spend_usd": 0.003703, "true_util_pct": 74, "engine_util_pct": 100},
            {"agent": "blast-test-2000", "cap_usd": 0.002, "true_spend_usd": 0.001602, "true_util_pct": 80, "engine_util_pct": 100},
        ],
        "caveat": "n=4 test agents/rules, LLM-only. Engine-reported util is ~100% at denial (double-counted); true util is the real settled footprint ÷ cap.",
    }


def tile_effective_budget(blast_radius: dict, cap_utilization: dict) -> dict:
    """BOUNDED — merges Blast Radius $ + Cap Utilization (both above, still emitted
    unrendered) into one tile: a configured cap only ever delivers a FRACTION of
    itself before denial — 0% in the worst case (a single oversized max_tokens
    hold >= cap bricks the agent before it ever spends) up to ~80% in the best.
    Contrasts with Concurrency Leak Factor below, where the same kind of cap
    fails the other way (lets too much through instead of too little)."""
    cap_rows = cap_utilization["rows"]
    bricked = next(r for r in blast_radius["rows"] if r["agent"] == "blast-test-8000")
    # bricked's true util is 0% (spend_before_stop_usd = $0, denied on call 1).
    # Its engine-reported util at that denial isn't ~100% like the other rows —
    # the single hold itself already exceeds the cap — per the ledger read in
    # experiments/03_governance_cumulative_double_count.md ("blast-test-8000 |
    # 8000 | $0.004802 | 0 | — | 0.004802 | denied on call 1 (hold alone > limit)").
    bricked_hold_usd = 0.004802
    bricked_engine_util_pct = round(bricked_hold_usd / bricked["cap_usd"] * 100)
    rows = [
        {
            "agent": r["agent"], "cap_usd": r["cap_usd"],
            "true_util_pct": r["true_util_pct"], "engine_util_pct": r["engine_util_pct"],
        }
        for r in cap_rows
    ] + [{
        "agent": bricked["agent"], "cap_usd": bricked["cap_usd"],
        "true_util_pct": bricked["pct_of_cap"], "engine_util_pct": bricked_engine_util_pct,
    }]
    lo = min(r["true_util_pct"] for r in rows)
    hi = max(r["true_util_pct"] for r in rows)
    return {
        "headline_pct_range": f"{lo}–{hi}% of cap",
        "message": f"You set a cap; agents actually get {lo}–{hi}% of it before denial.",
        "finding": (
            f"Agents cut off at {cap_utilization['headline_pct_range']} of true budget while the "
            "engine reports ~100% (the hold double-count); worst case one oversized max_tokens hold "
            "≥ cap bricks the agent at $0 before any spend."
        ),
        "rows": rows,
        "caveat": (
            f"Cap utilization: {cap_utilization['caveat']} Blast radius: {blast_radius['caveat']}"
        ),
        "method_note": (
            f"True/engine util rows reused verbatim from Cap Utilization ({cap_utilization['headline_pct_range']}"
            f", n=4). Bricked row reused from Blast Radius (blast-test-8000: cap ${bricked['cap_usd']:.3f}, "
            f"spend at denial ${bricked['spend_before_stop_usd']:.4f} = {bricked['pct_of_cap']}% true util; "
            f"engine util = hold ${bricked_hold_usd:.6f} ÷ cap ${bricked['cap_usd']:.3f} = "
            f"{bricked_engine_util_pct}%, per experiments/03_governance_cumulative_double_count.md). "
            f"Range {lo}–{hi}% = min/max true_util_pct across all {len(rows)} rows."
        ),
    }


def tile_concurrency_leak_factor() -> dict:
    """BOUNDED — TOCTOU race: a usage_limit rule sized to permit exactly 1 call's
    hold let MORE than 1 through under concurrent fire. This is the one Bounded
    finding where the bound BREAKS (vs Effective Budget above, where it fires
    too early). Three rounds, each a single live trial against api.sapiom.ai/v1.
    Narrative + mechanism: dryrun/toctou_latency_experiment.md; summarized in
    analysis/findings.md §8. Per-round allowed/denied/leak numbers below are
    read from each round's own result JSON; the FAST round's max_tokens exists
    only in its .md (not a field on either of its result JSONs), so it's a
    cited constant — every number's source is inline below and in method_note."""
    rows = [
        {
            "round": "FAST", "n": 10,
            # max_tokens=500: dryrun/toctou_scale_experiment.md ("Step 1 —
            # Baseline call (measure the real hold at max_tokens=500)") — not a
            # field on toctou_scale_result.json / toctou_scale_n10_result.json.
            "max_tokens": 500,
            # allowed/denied/leak_factor: dryrun/toctou_scale_result.json's
            # corrected_allowed_count / corrected_denied_count /
            # corrected_leak_factor — that file's own analysis_note explains the
            # raw allowed_count/leak_factor fields (also present unfixed in
            # toctou_scale_n10_result.json) double-count a meaningless phase-1
            # rule check; corrected_* is the honest tally.
            "allowed": 1, "denied": 9, "leak_factor": 1,
        },
        {
            # N, max_tokens, allowed, denied, leak_factor: all read directly from
            # dryrun/toctou_latency_slowA20_result.json (concurrent_calls,
            # max_tokens, allowed_count, denied_count, leak_factor).
            "round": "SLOW-A", "n": 20, "max_tokens": 8000,
            "allowed": 2, "denied": 18, "leak_factor": 2,
        },
        {
            # All fields read directly from
            # dryrun/toctou_latency_slowB50_result.json (same field names as A).
            "round": "SLOW-B", "n": 50, "max_tokens": 4000,
            "allowed": 3, "denied": 47, "leak_factor": 3,
        },
    ]
    max_leak = max(r["leak_factor"] for r in rows)
    return {
        "headline": f"up to {max_leak}x",
        "definition": (
            "Where Effective Budget shows the cap firing too early (agents cut off before they "
            "reach it), this is the opposite failure: under concurrent fire, the same kind of cap "
            "lets MORE calls through than it was sized for — the bound breaks instead of over-"
            "triggering."
        ),
        "subline": (
            "A cap sized for ONE call allowed 2 of 20 and 3 of 50 under concurrent fire — "
            "authorization checks race a stale cumulative ledger."
        ),
        "rows": rows,
        "caveat": (
            "One trial per round — TOCTOU races are probabilistic, not a measured rate at a given "
            "N/max_tokens. Leak confirmed two ways per round: the rule engine's own per-transaction "
            "decision AND client-side HTTP 200s (exact match in both SLOW rounds — real money "
            "authorized through, not a counting artifact). Mechanism identified (completedAt spread "
            "across the concurrent batch, tracking N at least as tightly as max_tokens); magnitude "
            "is small (2–3x) and scales with concurrency, not a large blowout."
        ),
        "method_note": (
            "FAST: N=10, max_tokens=500 (dryrun/toctou_scale_experiment.md), 1 allowed / 9 denied, "
            "leak 1x (dryrun/toctou_scale_result.json corrected_allowed_count/corrected_denied_count/"
            "corrected_leak_factor). SLOW-A: N=20, max_tokens=8000, 2 allowed / 18 denied, leak 2x "
            "(dryrun/toctou_latency_slowA20_result.json). SLOW-B: N=50, max_tokens=4000, 3 allowed / "
            "47 denied, leak 3x (dryrun/toctou_latency_slowB50_result.json). Mechanism + verdict: "
            "dryrun/toctou_latency_experiment.md; summarized analysis/findings.md §8."
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 12 — Section 2 "Agent-native KPIs": VISIBLE
# ---------------------------------------------------------------------------

def tile_ledger_blind_spots(con) -> dict:
    """VISIBLE — reframed 2026-07-07 from 'Attribution Completeness': % of ALL
    txns the ledger cannot fully explain, computed live in SQL as distinct txns
    where (outcome IS NULL) OR (service_name='unknown'). Replaces the old
    agent+trace+service+outcome-all-non-null check, which counted
    service_name='unknown' as a populated ('complete') value — i.e. it
    certified unresolved rows as complete. See Authorization Rate (Section 1)
    for the approval-rate reading of the same denials; this tile measures
    record quality, not approval."""
    total = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    # What makes a txn an outcome-blind-spot here: in this ledger every such
    # txn is missing `outcome` — denied txns never reach one, and a couple of
    # authorized txns never completed (zombies). Counted so the note can say
    # so instead of hardcoding.
    n_denied_no_outcome = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE outcome IS NULL AND status = 'denied'"
    ).fetchone()[0]
    n_zombies = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE outcome IS NULL AND status != 'denied'"
    ).fetchone()[0]
    n_unknown_service = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE service_name = 'unknown'"
    ).fetchone()[0]
    # Decompose service='unknown': how much of it is the scraping-labeled
    # workload (100% of that workload never resolves a service_name) vs. the
    # one unrelated pre-gateway compute failure (findings.md §9 Case A /
    # loss_rate.md — the eb918dba DNS-resolution failure, serviceName
    # unresolved because the txn record itself never reached one).
    n_scraping_total = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE agent_name LIKE '%scrap%'"
    ).fetchone()[0]
    n_scraping_unknown = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE agent_name LIKE '%scrap%' AND service_name = 'unknown'"
    ).fetchone()[0]
    n_unknown_other = n_unknown_service - n_scraping_unknown
    scraping_total_rev = con.execute("""
        SELECT COALESCE(SUM(c.fiat_amount), 0) FROM costs c
        JOIN transactions t ON t.id = c.transaction_id
        WHERE c.superseded_at IS NULL AND t.agent_name LIKE '%scrap%'
    """).fetchone()[0]
    scraping_unknown_rev = con.execute("""
        SELECT COALESCE(SUM(c.fiat_amount), 0) FROM costs c
        JOIN transactions t ON t.id = c.transaction_id
        WHERE c.superseded_at IS NULL AND t.agent_name LIKE '%scrap%' AND t.service_name = 'unknown'
    """).fetchone()[0]
    pct_scraping_rev_unknown = (
        float(scraping_unknown_rev) / float(scraping_total_rev) * 100 if scraping_total_rev else None
    )
    blind_txns = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE outcome IS NULL OR service_name = 'unknown'"
    ).fetchone()[0]
    pct = (blind_txns / total * 100) if total else None
    failure_word = "failure" if n_unknown_other == 1 else "failures"
    return {
        "total": total,
        "blind_txns": blind_txns,
        "pct": pct,
        "n_denied_no_outcome": n_denied_no_outcome,
        "n_zombies": n_zombies,
        "n_unknown_service": n_unknown_service,
        "n_scraping_total": n_scraping_total,
        "n_scraping_unknown": n_scraping_unknown,
        "n_unknown_other": n_unknown_other,
        "pct_scraping_rev_unknown": pct_scraping_rev_unknown,
        "definition": (
            "% of ALL transactions the ledger cannot fully explain — outcome never written, or "
            "service resolved to 'unknown'. Denials are also counted by Authorization Rate "
            "(Section 1) — that tile measures approval; this one measures record quality."
        ),
        "subline": (
            f"{n_denied_no_outcome} denied — no outcome ever written · {n_unknown_service} "
            f"service='unknown' ({pct_scraping_rev_unknown:.0f}% of the scraping service's revenue, "
            f"{n_scraping_unknown}/{n_scraping_total} calls + {n_unknown_other} pre-gateway "
            f"{failure_word}) · {n_zombies} zombies (authorized, never completed)"
            if pct_scraping_rev_unknown is not None else "n/a"
        ),
        "method_note": (
            f"blind = COUNT(DISTINCT txns WHERE outcome IS NULL OR service_name='unknown') ÷ "
            f"COUNT(*) txns = ({n_denied_no_outcome} denied-no-outcome + {n_zombies} zombie-no-outcome "
            f"+ {n_unknown_service} service='unknown', no overlap between the two groups in this data) "
            f"= {blind_txns}/{total} = {pct:.1f}%. Supersedes the old 'Attribution Completeness' check "
            f"(agent+traceId+service+outcome all non-null), which counted service_name='unknown' as a "
            f"populated value — it certified {n_unknown_service} unresolved rows as 'complete'. Metric "
            "renamed/redefined 2026-07-07 to close that gap."
            if pct is not None else "n/a"
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


def tile_cost_per_task_traceability(con) -> dict:
    """VISIBLE — the ledger sees calls, not jobs: share of txns (and share of
    live settled dollars) carrying a trace_external_id, the flat grouping id
    populated only by BUILD 3's chaining experiment (src/traces.py). Headline
    is the dollar share (the CEO-relevant read: how much of live spend can be
    traced to a task), txn-count share disclosed alongside."""
    total_txns = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    traced_txns = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE trace_external_id IS NOT NULL"
    ).fetchone()[0]
    total_live = con.execute(
        "SELECT COALESCE(SUM(fiat_amount), 0) FROM costs WHERE superseded_at IS NULL"
    ).fetchone()[0]
    traced_live = con.execute("""
        SELECT COALESCE(SUM(c.fiat_amount), 0) FROM costs c
        JOIN transactions t ON t.id = c.transaction_id
        WHERE c.superseded_at IS NULL AND t.trace_external_id IS NOT NULL
    """).fetchone()[0]
    pct_txns = (traced_txns / total_txns * 100) if total_txns else None
    pct_dollars = (float(traced_live) / float(total_live) * 100) if total_live else None
    return {
        "total_txns": total_txns,
        "traced_txns": traced_txns,
        "pct_txns": pct_txns,
        "total_live_usd": float(total_live),
        "traced_live_usd": float(traced_live),
        "pct_dollars": pct_dollars,
        "headline": f"{pct_dollars:.0f}% of spend traceable to a task" if pct_dollars is not None else "n/a",
        "definition": "The ledger sees calls, not jobs.",
        "subline": (
            f"Only {traced_txns} of {total_txns} txns carry a task id — \"what did this task cost "
            "end-to-end?\" is unanswerable for the rest."
        ),
        "caption": (
            "Traces are flat grouping IDs today, no parent/child hierarchy — task-level cost "
            "attribution needs span hierarchy in x402 metadata."
        ),
        "method_note": (
            f"txn share: COUNT(trace_external_id IS NOT NULL) ÷ COUNT(*) = {traced_txns}/{total_txns} "
            f"= {pct_txns:.1f}%. $ share: SUM(fiat_amount WHERE superseded_at IS NULL AND "
            f"trace_external_id IS NOT NULL) ÷ SUM(fiat_amount WHERE superseded_at IS NULL) = "
            f"${float(traced_live):.6f}/${float(total_live):.6f} = {pct_dollars:.1f}%."
            if pct_txns is not None and pct_dollars is not None else "n/a"
        ),
    }


# ---------------------------------------------------------------------------
# BUILD 12 — Section 2 "Agent-native KPIs": RECOVERABLE
# ---------------------------------------------------------------------------

def tile_hold_release_latency(auth_to_capture: dict, organic_lat: dict, frozen_capital: dict) -> dict:
    """RECOVERABLE — Hold-Release Latency, reframed 2026-07-07 as the recoverable
    thesis (was a plain duplicate of Auth -> Capture Time): success-path latency
    (auth->capture time recast as a capital-freed metric, headline = ORGANIC
    fleet, same population as Capture Ratio / Capital Overhang's headlines; the
    all-traffic figure is disclosed alongside) versus the failure/denial path,
    which is NEVER observed released — sourced from the Frozen Capital hero's
    live snapshot (reused, not recomputed). Sourced from findings.md §1's raw
    per-call latency, not the chain sums."""
    n_all = auth_to_capture.get("headline_n")
    p50_all = auth_to_capture["headline_p50_ms"]
    p95_all = auth_to_capture["headline_p95_ms"]
    service = auth_to_capture["headline_service"]
    n_org = organic_lat.get("n")
    p50_org = organic_lat.get("p50_ms")
    p95_org = organic_lat.get("p95_ms")
    have_org = bool(n_org) and p50_org is not None and p95_org is not None
    n_frozen_holds = frozen_capital["n_holds"]
    n_frozen_released = frozen_capital["n_released"]
    days_observed = frozen_capital["days_observed"]
    return {
        # Headline (big number) = organic; *_all = incl. adversarial experiments.
        "p50_ms": p50_org if have_org else p50_all,
        "p95_ms": p95_org if have_org else p95_all,
        "n": n_org if have_org else n_all,
        "p50_ms_all": p50_all,
        "p95_ms_all": p95_all,
        "n_all": n_all,
        "service": service,
        "n_frozen_holds": n_frozen_holds,
        "n_frozen_released": n_frozen_released,
        "days_observed": days_observed,
        "definition": "p50/p95 time from hold to final capture (chained services only).",
        "subline": "released in seconds when calls settle · NEVER observed released on failure or denial",
        # Computed from the same live snapshot the Frozen Capital hero uses —
        # not hardcoded.
        "caption": (
            f"{n_frozen_holds} holds on failed/denied calls, {n_frozen_released} released in "
            f"{days_observed} days and counting (refund_watch.log)"
        ),
        # FIX 4 — visible scope disclosure, real computed n's for BOTH traffic
        # segments (was a hardcoded "one session" single-n note).
        "scope_note": (
            f"Scope: {service} only — organic fleet n={n_org} (headline); incl. adversarial "
            f"experiments n={n_all}: {p50_all / 1000:.1f}s/{p95_all / 1000:.1f}s p50/p95. "
            "gpt-4o-mini — LLM-specific, not platform-wide."
            if have_org and n_all is not None and p50_all is not None and p95_all is not None else
            f"Scope: {service} only (n={n_all}), gpt-4o-mini — LLM-specific, not platform-wide."
        ),
    }


def tile_hold_recovery(hold_release: dict, refund_on_failure: dict, frozen_capital: dict) -> dict:
    """RECOVERABLE — merges Hold-Release Latency + Auth Reversal on Failure
    (2026-07-07): same frozen holds, two angles on one thesis, read as one
    tile — organic success-path speed (auth->capture) vs. failure-path
    permanence (a hold that errors post-auth is never reversed). Both source
    tiles (tile_hold_release_latency, tile_refund_on_failure) are still
    computed and emitted above, unrendered, for easy restore — precedent:
    BUILD 12's Bounded/Visible merges (tile_effective_budget, etc.)."""
    p50 = hold_release.get("p50_ms")
    p95 = hold_release.get("p95_ms")
    n_org = hold_release.get("n")
    n_all = hold_release.get("n_all")
    p50_all = hold_release.get("p50_ms_all")
    p95_all = hold_release.get("p95_ms_all")
    service = hold_release.get("service")
    n_holds = frozen_capital["n_holds"]
    days_observed = frozen_capital["days_observed"]
    retention_pct = refund_on_failure["direct_test_retention_rate_pct"]
    reversal_pct = 100 - retention_pct if retention_pct is not None else None
    direct_test_n = refund_on_failure["direct_test_n"]
    direct_test_retained = refund_on_failure["direct_test_retained"]
    mean_usd = refund_on_failure["direct_test_mean_retained_usd"]

    have_organic_lat = p50 is not None and p95 is not None
    have_all_lat = p50_all is not None and p95_all is not None

    return {
        "p50_ms": p50,
        "p95_ms": p95,
        "n_holds": n_holds,
        "days_observed": days_observed,
        "reversal_pct": reversal_pct,
        "definition": (
            "In card payments an uncaptured authorization is released via authorization "
            "reversal (void). No such mechanism observed here."
        ),
        "subline": (
            f"released in seconds when calls settle · {reversal_pct:.0f}% ever reversed on "
            f"failure or denial — {n_holds} holds frozen, {days_observed} days and counting"
            if reversal_pct is not None else "n/a"
        ),
        # Essentials only from the old Auth Reversal note — full derivation moved
        # to method_note (hover tooltip).
        "caption": (
            f"{direct_test_retained}/{direct_test_n} forced trials retained (mean "
            f"${mean_usd:.6f}, zero variance) — availableBalance dropped, totalBalance never "
            "moved (frozen, not charged). Per-failure mechanic measured; fleet frequency of "
            "post-hold failures in live traffic NOT measured."
        ),
        # Essentials from the old latency tile's scope note.
        "scope_note": (
            f"Scope: {service} only — organic n={n_org} headline "
            f"({p50 / 1000:.1f}s/{p95 / 1000:.1f}s); all-traffic n={n_all} "
            f"({p50_all / 1000:.1f}s/{p95_all / 1000:.1f}s) — LLM-specific (gpt-4o-mini), "
            "not platform-wide."
            if have_organic_lat and have_all_lat else "n/a"
        ),
        "method_note": (
            f"Hold-release latency (organic n={n_org}, p50 {p50:.0f}ms / p95 {p95:.0f}ms; "
            f"all-traffic n={n_all}, p50 {p50_all:.0f}ms / p95 {p95_all:.0f}ms): "
            f"{hold_release.get('caption', '')} Auth reversal on failure: "
            f"{refund_on_failure.get('note', '')}"
            if have_organic_lat and have_all_lat else
            f"{hold_release.get('caption', '')} Auth reversal on failure: "
            f"{refund_on_failure.get('note', '')}"
        ),
    }


def tile_refunds_disputes() -> dict:
    """RECOVERABLE — placeholder, proposed-definition tile: post-settlement
    recovery has no data to compute (no mechanism exists to measure), so this
    carries strings only. Completes the Recoverable narrative alongside Hold
    Recovery (pre-settlement). Precedent for a locked placeholder tile:
    pre-governance Blast Radius $ / Cap Utilization (tile placeholder +
    lock-tag; see .tile.placeholder / .lock-tag CSS + git history)."""
    return {
        "lock_tag": "NO MECHANISM EXISTS",
        "definition": (
            "Post-settlement recovery. Card rails: refund APIs + chargeback/dispute processes "
            "(Visa monitors dispute rates network-wide). Agent rails: when an agent pays for a "
            "bad result, no refund API, no dispute flow, no adjudication path exists — the "
            "money is unrecoverable by design, not by failure."
        ),
        "caption": (
            "Completes the lifecycle with Hold Recovery: pre-settlement money never comes back "
            "on failure; post-settlement money can't come back even in principle."
        ),
    }


def tile_refund_on_failure(con) -> dict:
    """RECOVERABLE — Refund-on-Failure. Two-part honest framing (findings.md §9),
    rewritten per adversarial audit (this tile previously and WRONGLY said the
    mid-flight-failure case was "not yet run" — it was run and is confirmed):

    (1) In-sample: the ledger's only NATURAL (non-experiment) failures were both
        PRE-hold (died during client/gateway setup) — neither ever held a cost,
        so there's nothing to release. This says nothing about post-hold failures.
    (2) Direct test: dryrun/hold_linearity_extension.md (N=1) +
        dryrun/failure_capture_n3.md (N=3 replication) forced 4 independent calls
        to error AFTER a hold was already placed. In all 4, availableBalance
        dropped by exactly $0.076803 (the full hold) while totalBalance never
        moved (dryrun/hold_linearity_result.json pre/post, dryrun/refund_watch.log)
        — i.e. the hold is RETAINED/FROZEN (unavailable to the customer), not
        swept into a completed charge against totalBalance, and not released
        either. Zero variance across all 4 observations. Those 4 forced-failure
        txns are now ingested in the ledger too (failure-capture-n3-*,
        hold-ext-test) — the note splits them out from the natural failures
        instead of blending both into one contradictory count.

    Honest caveat, stated on the tile: the per-failure retention mechanic is
    deterministic and measured (4/4) — how OFTEN a call fails post-hold in live
    traffic is NOT measured. Do not read this as a $/day loss rate.
    """
    pred = _experiment_sql_predicate("t")
    n_failed_total = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE outcome='error'"
    ).fetchone()[0]
    n_failed_with_cost_total = con.execute("""
        SELECT COUNT(DISTINCT t.id) FROM transactions t JOIN costs c ON c.transaction_id = t.id
        WHERE t.outcome = 'error'
    """).fetchone()[0]
    n_failed_natural = con.execute(
        f"SELECT COUNT(*) FROM transactions t WHERE t.outcome='error' AND NOT {pred}"
    ).fetchone()[0]
    n_failed_natural_with_cost = con.execute(f"""
        SELECT COUNT(DISTINCT t.id) FROM transactions t JOIN costs c ON c.transaction_id = t.id
        WHERE t.outcome = 'error' AND NOT {pred}
    """).fetchone()[0]
    n_failed_forced_with_cost = n_failed_with_cost_total - n_failed_natural_with_cost
    retention_rate_pct = FAILURE_RETENTION_RETAINED / FAILURE_RETENTION_N * 100
    return {
        # dashboard.html renders "In-sample: {n_failed_with_hold}/{n_failed} natural
        # failures ever held a cost (both died pre-hold ...)". Now that the ledger
        # also contains the FORCED failure-capture experiments (whose frozen holds
        # ARE cost rows), these two fields are scoped to NATURAL failures so that
        # rendered sentence stays true; the full split lives in the *_total /
        # forced fields below and in the note.
        "n_failed": n_failed_natural,
        "n_failed_with_hold": n_failed_natural_with_cost,
        "n_failed_total": n_failed_total,
        "n_failed_with_cost_row_total": n_failed_with_cost_total,
        "n_failed_forced_with_hold": n_failed_forced_with_cost,
        "direct_test_n": FAILURE_RETENTION_N,
        "direct_test_retained": FAILURE_RETENTION_RETAINED,
        "direct_test_retention_rate_pct": retention_rate_pct,
        "direct_test_mean_retained_usd": FAILURE_RETENTION_MEAN_USD,
        "definition": (
            "In card payments, an uncaptured authorization is released via authorization "
            "reversal (void). Measured here: % of a hold reversed vs. retained/frozen when a "
            "call fails after the hold is placed."
        ),
        "subline": (
            f"{retention_rate_pct:.0f}% of hold retained/frozen on post-hold failure "
            f"({FAILURE_RETENTION_RETAINED}/{FAILURE_RETENTION_N} forced trials) — an auth-reversal rate of 0%"
        ),
        "note": (
            f"In-sample: {n_failed_with_cost_total}/{n_failed_total} failed txns hold a cost row — "
            f"the {n_failed_forced_with_cost} with holds are the FORCED failure-capture experiments "
            f"(failure-capture-n3-*, hold-ext-test; their ${FAILURE_RETENTION_MEAN_USD:.6f} frozen "
            f"holds are the direct test below), while the {n_failed_natural} natural failures died "
            "pre-hold, so nothing was ever held or charged (loss_rate.md). Direct test: when a "
            f"hold DOES exist and the call then errors, {FAILURE_RETENTION_RETAINED}/{FAILURE_RETENTION_N} "
            f"forced trials show the hold RETAINED/FROZEN — availableBalance dropped by exactly "
            f"${FAILURE_RETENTION_MEAN_USD:.6f} each time (zero variance) while totalBalance never moved, "
            "so this is not a completed charge, and it is never reversed either — an auth-reversal rate "
            "of 0% (findings.md §9; "
            "dryrun/failure_capture_n3.md; dryrun/hold_linearity_extension.md; dryrun/refund_watch.log — "
            "still being watched for a delayed release). Over-requested max_tokens makes the frozen amount "
            f"larger. Honest caveat: the per-failure retention mechanic is deterministic and measured "
            f"({FAILURE_RETENTION_RETAINED}/{FAILURE_RETENTION_N}) — the FLEET FREQUENCY of post-hold "
            "failures in live traffic is NOT measured; do not read this as a $/day loss rate."
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
        # Compact, always-visible formula summary (not tooltip-only) — mirrors
        # the grade cutoffs in _velocity_grade_from_score and the point
        # constants above.
        "formula_compact": (
            f"score = {VELOCITY_RUNAWAY_POINTS} if peer-flagged + peak-burst×"
            f"{VELOCITY_PEAK_POINTS_PER_CALL} (max {VELOCITY_PEAK_POINTS_CAP}) → "
            "A ≤9 · B ≤24 · C ≤49 · D ≤74 · F ≥75 · <3 calls = N/A"
        ),
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
    frozen_capital = hero_frozen_capital()
    auth_to_capture = tile_auth_to_capture(con)
    # Organic hold lifetimes (experiment agents excluded) for the organic-headline
    # tiles; tile_auth_to_capture keeps the all-traffic view.
    organic_lat = (
        _organic_hold_lifetimes(con, auth_to_capture["headline_service"])
        if auth_to_capture["headline_service"] else {"n": 0, "p50_ms": None, "p95_ms": None}
    )
    capture_ratio = hero_capture_ratio(
        con,
        hold_lifetime_p50_s=(
            organic_lat["p50_ms"] / 1000 if organic_lat["p50_ms"] is not None else None
        ),
        hold_lifetime_p95_s=(
            organic_lat["p95_ms"] / 1000 if organic_lat["p95_ms"] is not None else None
        ),
        hold_lifetime_p50_s_all=(
            auth_to_capture["headline_p50_ms"] / 1000
            if auth_to_capture["headline_p50_ms"] is not None else None
        ),
        hold_lifetime_p95_s_all=(
            auth_to_capture["headline_p95_ms"] / 1000
            if auth_to_capture["headline_p95_ms"] is not None else None
        ),
    )
    reconciliation = hero_reconciliation(
        con, Decimal(args.initial_balance), frozen_capital,
        ingest_as_of=str(header["period_end"]) if header.get("period_end") else None,
    )
    tpv = hero_tpv(header, frozen_capital)
    blast_radius = tile_blast_radius()
    cap_utilization = tile_cap_utilization()
    hold_release_latency = tile_hold_release_latency(auth_to_capture, organic_lat, frozen_capital)
    refund_on_failure = tile_refund_on_failure(con)

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
        "hero_tpv": tpv,
        "hero_capture_ratio": capture_ratio,
        "hero_frozen_capital": frozen_capital,
        "hero_reconciliation": reconciliation,
        "tile_auth_to_capture": auth_to_capture,
        "tile_velocity_checks": tile_velocity_checks(con),
        "tile_loss_rate": tile_loss_rate(con),
        "tile_auth_rate": tile_auth_rate(con),
        "tile_atv": tile_atv(con, tpv),
        # ---- Section 2 — "Agent-native KPIs — proposed definitions" (BUILD 12) --
        # tile_capital_overhang / tile_blast_radius / tile_cap_utilization /
        # tile_phantom_spend_rate: cut from render 2026-07-07 (Capital Overhang;
        # superseded by tile_effective_budget) or merged into tile_effective_budget
        # (Blast Radius $, Cap Utilization) or cut from render (Phantom Spend
        # Rate) — data kept emitted, unrendered, for easy restore (precedented).
        "tile_capital_overhang": tile_capital_overhang(capture_ratio),
        "tile_blast_radius": blast_radius,
        "tile_cap_utilization": cap_utilization,
        "tile_effective_budget": tile_effective_budget(blast_radius, cap_utilization),
        "tile_concurrency_leak_factor": tile_concurrency_leak_factor(),
        "tile_ledger_blind_spots": tile_ledger_blind_spots(con),
        "tile_phantom_spend_rate": tile_phantom_spend_rate(reconciliation),
        "tile_cost_per_task_traceability": tile_cost_per_task_traceability(con),
        # tile_hold_release_latency / tile_refund_on_failure: merged into
        # tile_hold_recovery below (2026-07-07) — both kept emitted, unrendered,
        # for easy restore (same precedent as the Bounded/Visible merges above).
        "tile_hold_release_latency": hold_release_latency,
        "tile_refund_on_failure": refund_on_failure,
        "tile_hold_recovery": tile_hold_recovery(hold_release_latency, refund_on_failure, frozen_capital),
        "tile_refunds_disputes": tile_refunds_disputes(),
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
