# Sapiom Spend Intel

I gave AI agents a $5 wallet on Sapiom, let them spend it across every service the platform offers, and audited the ledger like a payments ledger. Everything below is measured — every number traces to a file in this repo.

▶ **[Live dashboard](https://jsharma103.github.io/sapiom-spend-intel/)** · [3-min walkthrough](https://www.loom.com/share/4bbe988b4eb049269a85db6e7cbd4b9b)

- **$0.567745 settled** — 375 transactions, 41 agents, 9 service families, real money
- **$0.528502 frozen** — holds never charged, never returned; zero released in 3 days
- **$0.000000 reconciliation diff** — the ledger predicts Sapiom's own account balance to the micro-dollar: settled + frozen + available = $5.000000 exactly

## What this is

The dashboard has two halves. **Section 1** measures industry-standard payments KPIs (TPV, authorization rate, capture rate) on agent traffic. **Section 2** proposes the KPIs agent payments actually needs — built from [Ilan Zerbib's own framing](https://www.computerweekly.com/blog/CW-Developer-Network/Sapiom-CEO-Software-is-becoming-the-customer-of-the-Internet) that failures must be *bounded, visible and recoverable* — and closes with a per-agent Know-Your-Agent scorecard.

## Key findings

- **Books tie out.** Balance reconciles to $0.000000 on real spend. Chain integrity clean: 0 orphans, 0 double-live rows.
- **Holds are LLM-only.** Capture rate 18% — authorize $1.00, settle $0.18, holds 5.6× oversized. Surveyed the other 5 service families: all price flat, no holds. (`dryrun/service_hold_survey.md`)
- **Frozen capital has no exit.** Post-hold failures retained the full hold 4/4; denied calls froze theirs 85/85. No void API, no refund, no dispute mechanism exists.
- **Caps bind at the wrong number.** Agents reach 0–80% of a configured cap before denial — the engine double-counts its own holds; one oversized `max_tokens` hold bricks an agent at $0. (`experiments/03`)
- **And leak under concurrency.** A cap sized for exactly one call allowed 3 of 50 concurrent calls — authorization checks race a stale cumulative ledger. (`dryrun/toctou_latency_experiment.md`)
- **A quarter of calls can't be fully explained.** 86 denied txns get no outcome written, 6 land as `service='unknown'` (100% of scrape revenue), 2 never complete. Only 2% of spend traces to a task.

## Open questions this surfaced

*Observations from the outside — likely missing context, so posed as questions.*

1. **Do failed and denied holds ever release?** 4/4 failed and 85/85 denied holds stayed frozen — zero released in 3 days.
2. **Does cumulative spend count a hold and its settlement together?** Agents were cut off at 54–80% of their cap while the engine read ~100%.
3. **Is scrape spend meant to be unlabeled?** Every scrape call logs `service_name='unknown'` — 100% of that revenue unattributable.
4. **Should a hold price on `max_tokens` or on usage?** A generous cap froze ~5.6× real spend and can trip budget rules on money never spent.
5. **Should per-wallet authorization be atomic?** A cap sized for one call let 3 of 50 concurrent calls through.

## How it works

```
src/generate_spend.js   drive real spend through Sapiom agents (@sapiom/fetch)
src/ingest.py           /v1/transactions + /v1/accounts → DuckDB, idempotent, DQ asserts
src/audit.py            four reconciliation checks → analysis/report.md
src/export_dashboard.py DuckDB → dashboard_data.json → static dashboard
```

```bash
export SAPIOM_API_KEY=your_key_here
node src/generate_spend.js
./.venv/bin/python src/ingest.py && ./.venv/bin/python src/audit.py
```

## Repo structure

```
dashboard.html, dashboard_data.*   GitHub Pages front door
src/                               pipeline: generate → ingest → audit → export
data/                              spend.duckdb
analysis/                          generated findings
dryrun/                            lab notebook: raw experiments
docs/                              process log & notes
```

## Cost

$5 wallet · ~$1.10 used ($0.57 settled + $0.53 frozen) · 375 transactions · 41 agents · 9 services · one weekend
