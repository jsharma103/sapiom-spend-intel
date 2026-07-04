#!/usr/bin/env python3
"""BUILD 5 (reliability half) — success rate + latency SLA + error taxonomy
per service. Writes reliability.md.

Zero spend: reads spend.duckdb only, no network calls, no API key needed.

Usage:
    python reliability.py [--db spend.duckdb] [--out reliability.md]
"""
import argparse

import duckdb

DEFAULT_DB = "spend.duckdb"
DEFAULT_OUT = "reliability.md"

# Ground-truth root-cause notes for errors captured tonight, cross-referenced
# against the service_sweep debugging work (RUN_LOG.md item 1) — the ledger
# itself has no error-reason/message field (checked: no `error`/`reason`/
# `failureMessage` key anywhere on an outcome='error' transaction, only the
# `outcome` flag itself), so these two are manually annotated from context
# we independently established, not derived from the ledger.
KNOWN_ROOT_CAUSES = {
    "sapiom_fal": "Pre-fix Fal.ai image endpoint had a wrong URL path "
                  "(images.md documents /v1/run/... but the live gateway needs the path without /v1/) "
                  "-> HTTP 404 before any real image generation happened. Fixed same night (RUN_LOG item 1).",
    "unknown": "Pre-fix Blaxel compute host (compute.services.sapiom.ai) does not resolve in DNS at all "
               "-> client-side fetch failure before the request ever reached a real gateway. serviceName shows "
               "as 'unknown' because the transaction record itself has no service name resolved. "
               "Fixed same night (RUN_LOG item 1, corrected host to blaxel.services.sapiom.ai).",
}


def fmt_pct(n) -> str:
    return f"{n:.1f}%" if n is not None else "n/a"


def fmt_ms(ms) -> str:
    if ms is None:
        return "n/a"
    if ms < 1000:
        return f"{ms:.0f}ms"
    return f"{ms / 1000:.2f}s"


def percentile(values: list, pct: float):
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(pct / 100 * (len(s) - 1)))))
    return s[k]


def per_service_stats(con) -> list:
    services = [r[0] for r in con.execute("SELECT DISTINCT service_name FROM transactions ORDER BY 1").fetchall()]
    stats = []
    for svc in services:
        rows = con.execute("""
            SELECT outcome, authorized_at, completed_at
            FROM transactions
            WHERE service_name = ?
        """, [svc]).fetchall()
        n = len(rows)
        n_success = sum(1 for r in rows if r[0] == "success")
        n_error = sum(1 for r in rows if r[0] == "error")
        n_other = n - n_success - n_error
        latencies = [
            (r[2] - r[1]).total_seconds() * 1000
            for r in rows if r[1] is not None and r[2] is not None
        ]
        stats.append({
            "service_name": svc,
            "n": n,
            "n_success": n_success,
            "n_error": n_error,
            "n_other": n_other,
            "success_rate_pct": (n_success / n * 100) if n else None,
            "p50_ms": percentile(latencies, 50),
            "p95_ms": percentile(latencies, 95),
        })
    return stats


def error_rows(con) -> list:
    rows = con.execute("""
        SELECT id, service_name, status, completed_at
        FROM transactions
        WHERE outcome = 'error'
        ORDER BY completed_at
    """).fetchall()
    return [{"id": r[0], "service_name": r[1], "status": r[2], "completed_at": r[3]} for r in rows]


def render(con) -> str:
    stats = per_service_stats(con)
    errors = error_rows(con)

    lines = []
    lines.append("# Sapiom Reliability / SLA Report")
    lines.append("")
    lines.append("Success rate + latency (authorized -> completed) + error taxonomy per service. "
                  "Zero spend, `spend.duckdb` only.")
    lines.append("")

    lines.append("## Per-service SLA")
    lines.append("")
    lines.append("| Service | N | Success | Error | Other | Success rate | p50 latency | p95 latency |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for s in sorted(stats, key=lambda x: -x["n"]):
        lines.append(
            f"| {s['service_name']} | {s['n']} | {s['n_success']} | {s['n_error']} | {s['n_other']} | "
            f"{fmt_pct(s['success_rate_pct'])} | {fmt_ms(s['p50_ms'])} | {fmt_ms(s['p95_ms'])} |"
        )
    lines.append("")

    lines.append("## Error taxonomy")
    lines.append("")
    if not errors:
        lines.append("No `outcome='error'` transactions found.")
    else:
        lines.append(f"**{len(errors)} error transaction(s) found.** NOTE: the ledger itself has no "
                      "error-reason/message field (checked: no `error`/`reason`/`failureMessage` key on any "
                      "outcome='error' transaction — only the `outcome` flag). Root causes below for tonight's "
                      "2 errors are manually cross-referenced from independent debugging context (RUN_LOG item "
                      "1), not derived from the ledger. Anything beyond these 2 known cases would show as "
                      "\"unknown\" until a real error-detail field exists — itself worth flagging as a ledger "
                      "gap for incident triage.")
        lines.append("")
        lines.append("| Transaction ID | Service | Status | Completed At | Known root cause |")
        lines.append("|---|---|---|---|---|")
        for e in errors:
            cause = KNOWN_ROOT_CAUSES.get(e["service_name"], "unknown — no error-detail field in the ledger")
            lines.append(f"| {e['id']} | {e['service_name']} | {e['status']} | {e['completed_at']} | {cause} |")
    lines.append("")

    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description="Reliability/SLA report over spend.duckdb")
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
