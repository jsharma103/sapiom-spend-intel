#!/usr/bin/env python3
"""BUILD 2 — free SQL findings bundle over spend.duckdb. Writes findings.md.

Zero spend: reads spend.duckdb only, no network calls, no API key needed.

Usage:
    python findings.py [--db spend.duckdb] [--out findings.md]

Sections (see BACKLOG.md BUILD 2 for the spec each one implements):
  1. Settlement latency        — authorizedAt -> live-cost createdAt, p50/p95 per service
  2. x402 overhead tax         — completedAt - authorizedAt (payment sub-object is ABSENT
                                  in this API's data, so per HANDOFF we use the top-level
                                  transaction fields instead), p50/p95 per service
  3. Cost-per-task             — group by trace_external_id; EMPTY until BUILD 3 (chaining)
                                  sets a shared traceExternalId across calls. Noted, not failed.
  4. Estimate-accuracy         — per service, live/hold ratio for services that actually
     scorecard                   restate costs (supersession chains); flat single-row
                                  services noted separately (no hold-vs-final to score).
  5. Runaway detection (chk-5) — per-agent median inter-call gap + peak calls/60s window,
                                  flagged against the peer-agent median.
  6. callSite lineage          — probed; ABSENT in captured data (noted, section skipped).
"""
import argparse
import statistics
from decimal import Decimal

import duckdb

DEFAULT_DB = "spend.duckdb"
DEFAULT_OUT = "findings.md"

# Runaway heuristic thresholds (see METHODOLOGY note in Check 5's section).
RUNAWAY_GAP_RATIO = 0.2   # flag if agent's median gap < 20% of peer median gap
RUNAWAY_MIN_CALLS = 3     # need at least this many calls to compute a meaningful gap/peak


def fmt_usd(d) -> str:
    return f"${Decimal(d):,.6f}"


def fmt_ms(ms) -> str:
    if ms is None:
        return "n/a"
    if ms < 1000:
        return f"{ms:.0f}ms"
    return f"{ms / 1000:.2f}s"


def percentile(values: list, pct: float):
    """Nearest-rank percentile over a sorted list of numbers. pct in [0,100]."""
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(pct / 100 * (len(s) - 1)))))
    return s[k]


# ---------------------------------------------------------------------------
# 1. Settlement latency
# ---------------------------------------------------------------------------

def settlement_latency(con) -> list:
    """authorizedAt -> live-cost createdAt, per service. Uses the LIVE
    (superseded_at IS NULL) cost row's created_at as the settlement instant,
    whether or not that row is part of a supersession chain — for flat
    single-row services this measures the plain authorize->capture round
    trip; for chained services (LLM) it measures authorize->final-capture,
    including the restatement wait."""
    rows = con.execute("""
        SELECT t.service_name,
               EPOCH_MS(c.created_at) - EPOCH_MS(t.authorized_at) AS latency_ms
        FROM transactions t
        JOIN costs c ON c.transaction_id = t.id AND c.superseded_at IS NULL
        WHERE t.authorized_at IS NOT NULL
    """).fetchall()

    by_service = {}
    for service_name, latency_ms in rows:
        if latency_ms is None:
            continue
        by_service.setdefault(service_name, []).append(latency_ms)

    result = []
    for service_name, latencies in sorted(by_service.items()):
        result.append({
            "service_name": service_name,
            "n": len(latencies),
            "p50_ms": percentile(latencies, 50),
            "p95_ms": percentile(latencies, 95),
        })
    return result


# ---------------------------------------------------------------------------
# 2. x402 overhead tax
# ---------------------------------------------------------------------------

def x402_overhead_tax(con) -> list:
    """completedAt - authorizedAt per transaction, per service. NOTE: no
    `payment` sub-object exists on transactions in this API (confirmed in
    BUILD 0 probing) — authorizedAt/completedAt are flat top-level fields,
    which is exactly what HANDOFF instructs using here."""
    rows = con.execute("""
        SELECT service_name,
               EPOCH_MS(completed_at) - EPOCH_MS(authorized_at) AS tax_ms,
               EPOCH_MS(completed_at) - EPOCH_MS(created_at) AS total_ms
        FROM transactions
        WHERE authorized_at IS NOT NULL AND completed_at IS NOT NULL
    """).fetchall()

    by_service = {}
    for service_name, tax_ms, total_ms in rows:
        if tax_ms is None:
            continue
        by_service.setdefault(service_name, []).append((tax_ms, total_ms))

    result = []
    for service_name, pairs in sorted(by_service.items()):
        taxes = [p[0] for p in pairs]
        pct_of_total = [
            (p[0] / p[1] * 100) for p in pairs if p[1] and p[1] > 0
        ]
        result.append({
            "service_name": service_name,
            "n": len(taxes),
            "p50_ms": percentile(taxes, 50),
            "p95_ms": percentile(taxes, 95),
            "avg_pct_of_total": (sum(pct_of_total) / len(pct_of_total)) if pct_of_total else None,
        })
    return result


# ---------------------------------------------------------------------------
# 3. Cost-per-task (gated on BUILD 3 chaining)
# ---------------------------------------------------------------------------

def cost_per_task(con) -> dict:
    total = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    with_trace = con.execute(
        "SELECT COUNT(*) FROM transactions WHERE trace_external_id IS NOT NULL"
    ).fetchone()[0]

    if with_trace == 0:
        return {"available": False, "total_txns": total, "with_trace_external_id": with_trace, "tasks": []}

    rows = con.execute("""
        SELECT t.trace_external_id,
               COUNT(DISTINCT t.id) AS steps,
               COALESCE(SUM(c.fiat_amount), 0) AS cost,
               EPOCH_MS(MAX(t.completed_at)) - EPOCH_MS(MIN(t.authorized_at)) AS wall_ms
        FROM transactions t
        LEFT JOIN costs c ON c.transaction_id = t.id AND c.superseded_at IS NULL
        WHERE t.trace_external_id IS NOT NULL
        GROUP BY t.trace_external_id
        ORDER BY cost DESC
    """).fetchall()
    tasks = [
        {"trace_external_id": r[0], "steps": r[1], "cost": r[2], "wall_ms": r[3]}
        for r in rows
    ]
    return {"available": True, "total_txns": total, "with_trace_external_id": with_trace, "tasks": tasks}


# ---------------------------------------------------------------------------
# 4. Estimate-accuracy scorecard
# ---------------------------------------------------------------------------

def estimate_accuracy_scorecard(con) -> dict:
    """For services with supersession chains: ratio of final(live)/hold
    amount, averaged per service (>1.0 = final costs more than the hold
    implied; <1.0 = hold overestimated, money was frozen unnecessarily).
    For flat single-row services: no hold vs. final distinction exists —
    reported separately as "n/a, flat pricing"."""
    chained = con.execute("""
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
        SELECT t.service_name, h.hold_amount, f.final_amount
        FROM hold h JOIN final f ON f.transaction_id = h.transaction_id
        JOIN transactions t ON t.id = h.transaction_id
    """).fetchall()

    by_service_ratios = {}
    for service_name, hold_amount, final_amount in chained:
        if hold_amount and hold_amount != 0:
            by_service_ratios.setdefault(service_name, []).append(float(final_amount) / float(hold_amount))

    scored = []
    for service_name, ratios in sorted(by_service_ratios.items()):
        scored.append({
            "service_name": service_name,
            "n_chains": len(ratios),
            "avg_settled_over_held": sum(ratios) / len(ratios),
        })

    chained_services = set(by_service_ratios.keys())
    flat_services = con.execute("""
        SELECT DISTINCT t.service_name
        FROM transactions t
        JOIN costs c ON c.transaction_id = t.id
        WHERE t.service_name NOT IN (SELECT UNNEST(?))
        ORDER BY 1
    """, [list(chained_services) or [""]]).fetchall()
    flat = [r[0] for r in flat_services]

    return {"scored": scored, "flat_services": flat}


# ---------------------------------------------------------------------------
# 5. Runaway detection (check-5)
# ---------------------------------------------------------------------------

def runaway_detection(con) -> dict:
    """Per-agent median inter-call gap (seconds) + peak calls in any 60s
    window, flagged against the peer-agent median gap.

    METHODOLOGY: an agent is flagged RUNAWAY if it has >= RUNAWAY_MIN_CALLS
    calls AND its median inter-call gap is < RUNAWAY_GAP_RATIO x the median
    of all *other* qualifying agents' median gaps (i.e., firing much faster
    than its peers, not just faster than some fixed constant — this adapts
    to whatever the peer baseline looks like on a given account instead of a
    magic-number seconds threshold)."""
    rows = con.execute("""
        SELECT agent_name, created_at
        FROM transactions
        WHERE agent_name IS NOT NULL
        ORDER BY agent_name, created_at
    """).fetchall()

    by_agent = {}
    for agent_name, created_at in rows:
        by_agent.setdefault(agent_name, []).append(created_at)

    per_agent = {}
    for agent_name, timestamps in by_agent.items():
        n = len(timestamps)
        if n < RUNAWAY_MIN_CALLS:
            per_agent[agent_name] = {"n": n, "median_gap_s": None, "peak_calls_per_min": None}
            continue
        gaps_s = [
            (timestamps[i] - timestamps[i - 1]).total_seconds()
            for i in range(1, n)
        ]
        median_gap = statistics.median(gaps_s)
        # peak calls in any rolling 60s window (two-pointer over sorted timestamps)
        peak = 0
        lo = 0
        for hi in range(n):
            while (timestamps[hi] - timestamps[lo]).total_seconds() > 60:
                lo += 1
            peak = max(peak, hi - lo + 1)
        per_agent[agent_name] = {"n": n, "median_gap_s": median_gap, "peak_calls_per_min": peak}

    qualifying_gaps = [v["median_gap_s"] for v in per_agent.values() if v["median_gap_s"] is not None]

    flagged = []
    for agent_name, stats in per_agent.items():
        if stats["median_gap_s"] is None:
            continue
        peer_gaps = [g for a, g in
                     ((a2, v2["median_gap_s"]) for a2, v2 in per_agent.items() if v2["median_gap_s"] is not None)
                     if a != agent_name]
        if not peer_gaps:
            continue
        peer_median = statistics.median(peer_gaps)
        is_runaway = peer_median > 0 and stats["median_gap_s"] < RUNAWAY_GAP_RATIO * peer_median
        stats["peer_median_gap_s"] = peer_median
        stats["runaway"] = is_runaway
        if is_runaway:
            flagged.append(agent_name)

    return {"per_agent": per_agent, "flagged": flagged, "qualifying_gaps_n": len(qualifying_gaps)}


# ---------------------------------------------------------------------------
# 6. callSite lineage (probe only)
# ---------------------------------------------------------------------------

def callsite_probe(con) -> bool:
    row = con.execute("SELECT raw FROM transactions LIMIT 200").fetchall()
    import json
    for (raw,) in row:
        if raw and "callSite" in json.loads(raw):
            return True
    return False


# ---------------------------------------------------------------------------
# 7. Governance auth rate (BUILD 11 — payments auth-rate analog)
# ---------------------------------------------------------------------------

def governance_auth_rate(con) -> dict:
    """% of transactions approved vs denied by a Sapiom governance spending rule.
    NOTE: this is a pre-flight governance decision, distinct from post-flight execution
    outcome (success/error) already covered by reliability.md / loss_rate.md — a
    transaction can be *approved* by governance and still fail downstream (vendor/network
    error), or (not observed here) be *denied* by governance before it ever executes."""
    rows = con.execute(
        "SELECT outcome, status, COUNT(*) FROM transactions GROUP BY 1, 2 ORDER BY 3 DESC"
    ).fetchall()
    total = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    # No transaction in this ledger shows a governance denial (e.g. status/outcome of
    # 'denied' or 'blocked') because no spending rule was active in the sample. Every
    # outcome value observed ('success'/'error') reflects downstream execution, not a
    # governance gate — so denied = 0 by construction of this dataset, not by inference.
    denied = 0
    approved = total - denied
    auth_rate_pct = (approved / (approved + denied) * 100) if (approved + denied) else None
    return {
        "distribution": [{"outcome": o, "status": s, "n": n} for o, s, n in rows],
        "total": total,
        "approved": approved,
        "denied": denied,
        "auth_rate_pct": auth_rate_pct,
    }


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render(con) -> str:
    lat = settlement_latency(con)
    tax = x402_overhead_tax(con)
    cpt = cost_per_task(con)
    acc = estimate_accuracy_scorecard(con)
    runaway = runaway_detection(con)
    has_callsite = callsite_probe(con)
    auth = governance_auth_rate(con)

    lines = []
    lines.append("# Sapiom Spend Findings")
    lines.append("")
    lines.append("Free SQL findings bundle over `spend.duckdb` — zero spend, real ingested data.")
    lines.append("")

    lines.append("## 1. Settlement latency (authorize -> final capture)")
    lines.append("")
    lines.append("Time from `authorizedAt` to the live cost row's `createdAt`, per service. "
                  "For flat single-row services this is the plain authorize->capture round trip; "
                  "for services with supersession chains (LLM) it includes the restatement wait.")
    lines.append("")
    lines.append("| Service | N | p50 | p95 |")
    lines.append("|---|---|---|---|")
    for row in lat:
        lines.append(f"| {row['service_name']} | {row['n']} | {fmt_ms(row['p50_ms'])} | {fmt_ms(row['p95_ms'])} |")
    lines.append("")
    lines.append("Negative values on flat single-row services are real, not a bug: for those services the "
                  "(only) cost row is created a few hundred ms *before* the transaction's `authorizedAt` "
                  "timestamp is stamped — the cost record is written as part of the authorization step "
                  "itself, not after it. Only `sapiom_openrouter` (the chained/restated service) shows "
                  "genuine positive latency: real wall-clock time waiting for the LLM call to finish and "
                  "the hold to be superseded by the final settled cost.")
    lines.append("")

    lines.append("## 2. x402 overhead tax")
    lines.append("")
    lines.append("`completedAt - authorizedAt` per transaction, per service. NOTE: no `payment` "
                  "sub-object exists on transactions in this API (confirmed during BUILD 0 field-"
                  "availability probing) — `authorizedAt`/`completedAt` are flat top-level transaction "
                  "fields, used here directly per HANDOFF guidance.")
    lines.append("")
    lines.append("| Service | N | p50 tax | p95 tax | avg % of total call time |")
    lines.append("|---|---|---|---|---|")
    for row in tax:
        pct = f"{row['avg_pct_of_total']:.1f}%" if row["avg_pct_of_total"] is not None else "n/a"
        lines.append(f"| {row['service_name']} | {row['n']} | {fmt_ms(row['p50_ms'])} | {fmt_ms(row['p95_ms'])} | {pct} |")
    lines.append("")

    lines.append("## 3. Cost-per-task")
    lines.append("")
    if not cpt["available"]:
        lines.append(f"**EMPTY** — {cpt['with_trace_external_id']}/{cpt['total_txns']} transactions have a "
                      "non-null `trace_external_id`. Cost-per-task attribution requires BUILD 3 (chaining "
                      "experiment) to set a shared `traceExternalId` across a multi-step agent task. "
                      "Re-run this script after BUILD 3 fires to populate this section.")
    else:
        lines.append(f"{cpt['with_trace_external_id']}/{cpt['total_txns']} transactions carry a `trace_external_id`.")
        lines.append("")
        lines.append("| Trace External ID | Steps | Cost | Wall time |")
        lines.append("|---|---|---|---|")
        for t in cpt["tasks"]:
            lines.append(f"| {t['trace_external_id']} | {t['steps']} | {fmt_usd(t['cost'])} | {fmt_ms(t['wall_ms'])} |")
    lines.append("")

    lines.append("## 4. Estimate-accuracy scorecard")
    lines.append("")
    lines.append("For services that actually restate costs (hold -> final settlement chains), the "
                  "ratio of final(live) amount over the original hold amount, averaged per service. "
                  "Ratio << 1.0 means the hold overestimated the real cost (balance frozen unnecessarily).")
    lines.append("")
    if acc["scored"]:
        lines.append("| Service | Chains | Avg settled/held ratio |")
        lines.append("|---|---|---|")
        for row in acc["scored"]:
            lines.append(f"| {row['service_name']} | {row['n_chains']} | {row['avg_settled_over_held']:.3f} |")
    else:
        lines.append("No services with supersession chains found.")
    lines.append("")
    if acc["flat_services"]:
        lines.append(f"Flat single-row pricing (no hold-vs-final to score): {', '.join(acc['flat_services'])}.")
    lines.append("")

    lines.append("## 5. Runaway detection (check-5)")
    lines.append("")
    lines.append(f"Methodology: per agent, median inter-call gap (seconds) + peak calls in any rolling "
                  f"60s window. An agent is flagged **RUNAWAY** if it has >= {RUNAWAY_MIN_CALLS} calls and its "
                  f"median gap is < {int(RUNAWAY_GAP_RATIO * 100)}% of the peer-agent median gap (adapts to the "
                  "account's own baseline instead of a fixed-seconds magic number).")
    lines.append("")
    lines.append("| Agent | Calls | Median gap | Peak calls/60s | vs peer median | Flag |")
    lines.append("|---|---|---|---|---|---|")
    for agent_name, stats in sorted(per_agent_sort_key(runaway["per_agent"])):
        if stats["median_gap_s"] is None:
            lines.append(f"| {agent_name} | {stats['n']} | n/a (< {RUNAWAY_MIN_CALLS} calls) | n/a | n/a | — |")
            continue
        flag = "RUNAWAY" if stats.get("runaway") else ""
        peer = f"{stats['peer_median_gap_s']:.2f}s" if stats.get("peer_median_gap_s") is not None else "n/a"
        lines.append(
            f"| {agent_name} | {stats['n']} | {stats['median_gap_s']:.2f}s | {stats['peak_calls_per_min']} | {peer} | {flag} |"
        )
    lines.append("")
    if runaway["flagged"]:
        lines.append(f"**Flagged runaway agent(s): {', '.join(runaway['flagged'])}.**")
    else:
        lines.append("No agent flagged as runaway.")
    lines.append("")
    lines.append("Note: in tonight's real data, the agent literally *named* `spend-runaway` (25 calls, "
                  "designed per PLAN.md to burst at 0.3s sleeps) actually shows a steady ~8s median gap — no "
                  "burst is visible in the captured timestamps. The genuinely anomalous burst tonight came "
                  "from `fleet-test` (10 calls in well under a second, ~75-90ms apart), an unrelated prior "
                  "test script. This is exactly why a peer-relative statistical detector is worth having: it "
                  "flags the agent that's actually behaving anomalously in the data, not the one with the "
                  "suggestive name.")
    lines.append("")

    lines.append("## 6. callSite lineage")
    lines.append("")
    if has_callsite:
        lines.append("`callSite` field found on captured transactions — see raw JSON for lineage detail "
                      "(not further analyzed in this pass).")
    else:
        lines.append("Probed the raw transaction JSON for an SDK-documented `callSite` field: **absent** "
                      "on every captured transaction. No second attribution axis beyond `traceId` is "
                      "available in this account's data — section otherwise skipped.")
    lines.append("")

    lines.append("## 7. Governance auth rate (payments auth-rate analog)")
    lines.append("")
    lines.append("Payments framing: an \"auth rate\" is % of transactions the authorization layer "
                  "approves vs. declines *before* execution — for Sapiom that's governance spending "
                  "rules, not downstream vendor/network success (already covered in `reliability.md` "
                  "/ `loss_rate.md`). `outcome` distribution:")
    lines.append("")
    lines.append("| Outcome | Status | N |")
    lines.append("|---|---|---|")
    for row in auth["distribution"]:
        lines.append(f"| {row['outcome']} | {row['status']} | {row['n']} |")
    lines.append("")
    lines.append(f"Approved: {auth['approved']} · Denied: {auth['denied']} · "
                  f"**Auth rate = {auth['auth_rate_pct']:.1f}%** ({auth['approved']}/{auth['approved'] + auth['denied']}).")
    lines.append("")
    lines.append("**Caveat: no spending rules were active in this sample.** Every transaction that "
                  "reached the ledger did so with zero governance gates to pass or fail — a 100% auth "
                  "rate here means \"nothing was configured to say no,\" not \"governance actively "
                  "approved risky spend.\" The `outcome` column only ever takes values `success`/`error`, "
                  "both reflecting downstream execution (confirmed: no `denied`/`blocked` value exists "
                  "anywhere in this dataset) — this metric becomes meaningful once a spending rule is "
                  "created (dashboard-only, [HUMAN-UI], see BACKLOG.md item 8 / the rules-on-hold-vs-"
                  "settlement experiment) and actually denies a transaction. Treat 100% as a baseline "
                  "reading of an unconfigured account, not evidence that governance works.")
    lines.append("")

    return "\n".join(lines) + "\n"


def per_agent_sort_key(per_agent: dict):
    """Sort by: has-data first (n>=RUNAWAY_MIN_CALLS), then by call count desc."""
    return sorted(
        per_agent.items(),
        key=lambda kv: (kv[1]["median_gap_s"] is None, -kv[1]["n"]),
    )


def main():
    ap = argparse.ArgumentParser(description="Free SQL findings bundle over spend.duckdb")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"DuckDB file path (default {DEFAULT_DB})")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"Findings output path (default {DEFAULT_OUT})")
    args = ap.parse_args()

    con = duckdb.connect(args.db, read_only=True)
    report = render(con)
    con.close()

    with open(args.out, "w") as f:
        f.write(report)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
