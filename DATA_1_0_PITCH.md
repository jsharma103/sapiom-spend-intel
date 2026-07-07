# Sapiom Data 1.0 — The Data Platform Your Ledger Is Already Asking For

*A maturity pitch grounded entirely in data I generated on the live platform: $0.28 of real
agent spend, 300 transactions, 16+ agents, 9 services swept, and a dozen live experiments.
Every claim traces to a file in this repo.*

---

## The one-liner

You are building the payment rails for agent money. The rails already emit a bitemporal,
restatement-heavy event stream that behaves like a claims ledger — and today that stream is
served straight from the transactional store, with no analytical foundation under it. Data 1.0
is that foundation: an append-only lakehouse that makes the ledger **provably correct at
petabyte scale** — because I've already caught the failure modes that appear without it, at
$0.28 scale.

---

## Data 0 — where the platform is today (observed, not assumed)

Everything below was established by probing the live API surface (`BACKLOG.md` API RECON,
`governance_api_probe.md`):

- **Current-state-only serving.** The dashboard reads live transactional state; `include=transaction-metrics` exists but returns empty; there is no history/as-of endpoint, no traces endpoint, no analytics payload.
- **Metrics computed on the fly** (`/v1/agents/metrics` aggregates at request time).
- **Restatements are first-class** — every chained call posts a hold cost row, then supersedes it with a settled row. The ledger is already bitemporal; nothing downstream exploits (or even acknowledges) it.
- **Governance state is append-only** (no hard delete, PUT-with-version only) — same pattern as the spend ledger, again unexploited.

That's a healthy Data 0: the *write side* is genuinely well-shaped. What's missing is everything that reads it.

## Why this matters now — the failure modes are already live (measured)

Each of these was found with real money on the production API. Each one is a data-platform
gap, not an application bug — and each gets structurally fixed by the Data 1.0 design:

| # | Measured finding | Evidence | The Data-1.0 fix |
|---|---|---|---|
| 1 | **Phantom spend +10%** — naive sum over cost rows double-counts every supersession chain | `report.md`, dashboard Reconciliation hero | One canonical, supersession-aware spend model (semantic layer: *one* definition of "spend") |
| 2 | **Rule engine double-counts settled history (2×)** — a $0.005 budget denied at $0.0037 of true cumulative; exact 2× join-multiplicity fit | `dryrun/r5_boundary.md` | Cumulative-spend as a governed, tested metric served from the lakehouse — not re-derived per subsystem with its own join bugs |
| 3 | **Frozen money is invisible and doesn't recover** — $0.53 (11% of wallet) frozen: 4 failure-holds + 85 denial-holds, zero released after 3 days | `dryrun/REFUND_WATCH.md`, `denial_analytics.md` | Hold-lifecycle observability: every hold's state machine (placed→settled/released/orphaned) as a first-class table with SLA monitors |
| 4 | **TOCTOU race leaks 2-3× past budgets under concurrency** — checks race a stale cumulative ledger | `findings.md` §8 | Streaming (not point-in-time) cumulative ledger; serialized per-wallet authorization reads |
| 5 | **Idempotency keys accepted but not enforced** — replayed create → duplicate phantom transaction row | `dryrun/r3_idempotency_result.json` | DQ contracts on the event stream (uniqueness by idempotency key) that fail loudly, continuously |
| 6 | **Float is real and modelable** — Little's Law validated within 9% against live balance behavior | `dryrun/ll_validation.md` | Forecasting layer: frozen-capital and burn-rate projections are *derivable* from the ledger — Data 2.0 features waiting on 1.0 plumbing |
| 7 | **No cost-per-task view** — traces are flat; cost attribution requires supersession-aware trace rollups | `traces.md`, BUILD 13 | Lineage marts: trace → task → cost, the analytics their customer CFOs will demand |

The pattern: **every subsystem that re-derives "how much was spent" gets it wrong differently**
(naive sum +10%, rule engine 2×, dashboards current-state-only). That's precisely the disease a
canonical analytical layer cures.

## The data inventory — what the platform actually emits (from the 9-service sweep)

Real request/response shapes captured in `dryrun/service_sweep_result.json`:

| Service | Data emitted | Structure | At scale this becomes |
|---|---|---|---|
| Search (Linkup) | results + sourced answers | semi-structured JSON | web-scale content lake w/ source lineage |
| LLM (OpenRouter) | text + `cost_details` incl. upstream vendor cost | JSON + nested cost telemetry | token-level unit-economics stream |
| Images (Fal) | image binaries | binary + generation params | object store + params catalog (GCS pointers, not DB blobs) |
| Audio (ElevenLabs) | audio binaries | binary + character counts | same pointer pattern |
| Compute (Blaxel) | stdout/stderr, artifacts, duration | logs + metrics | execution-observability stream |
| Scraping (Firecrawl) | HTML/markdown pages, credits | documents | content lake + credit-burn telemetry |
| Data (Neon) | rows, price quotes | structured | customer-workload telemetry |
| Messaging (QStash) / Verify (Prelude) | delivery + OTP event streams | event logs | side-effect audit trail |
| **The ledger itself** | txns, cost chains, auth requests, rule executions, balance snapshots | **bitemporal event stream** | **the system of record — the product** |

One platform, every shape: structured ledger, semi-structured traces, unstructured
payloads, binaries. This is a textbook lakehouse inventory.

## Data 1.0 — the reference architecture

```
Cloud SQL / Postgres (hot path — untouched, it's good)
      │  Datastream CDC (no app changes; captures supersessions as events)
      ▼
Pub/Sub → Dataflow (DQ contracts inline: idempotency uniqueness,
      │             no negative costs, chain integrity — finding #5)
      ▼
BigQuery lakehouse — APPEND-ONLY facts + derive-current views
      │   (MERGE does not scale; supersession chains ARE SCD2 — model them
      │    natively: fact_cost_event + v_live_cost, exactly the claims-ledger
      │    pattern. Binary payloads → GCS, pointers in BQ.)
      ▼
dbt medallion: staging → core marts
      │   marts: canonical_spend (fix #1), cumulative_by_rule (fix #2),
      │   hold_lifecycle (fix #3), trace_cost_rollup (fix #7),
      │   agent_risk / KYA (velocity + spend + denial features)
      ▼
Semantic/serving layer: BI Engine + metrics API
      - ONE definition of spend, budget-remaining, frozen-capital
      - reconciliation as a STANDING SERVICE (the $0.000000 check, hourly,
        alerting — not a one-off audit)
      - as-of-T time travel free with the append-only model (disputes,
        rule-decision replay, quarter-close compliance)
```

Design principles, each earned by a finding:
1. **Append-only + derive-current, never overwrite** — supersessions are the product's
   semantics; preserve them and current-state is a cheap view. (Findings #1, #2.)
2. **One cumulative-spend truth** — the rule engine, dashboard, and invoices must read the
   same mart. Three subsystems currently compute it three ways; two are measurably wrong.
3. **Contracts, not asserts** — the ingest checks that caught real bugs in this repo become
   standing Dataflow contracts. (Finding #5.)
4. **Hold lifecycle as a state machine table** — the $0.53 frozen today is invisible in every
   existing view; `unavailableBalance` is one opaque number. (Finding #3.)
5. **Big payloads out of the database** — binaries to GCS with pointers; the ledger stays
   lean at petabyte/day.

## Data 2.0 — what the foundation unlocks (horizon)

- **Anomaly & runaway detection as a product** (the velocity-check tile, productized — peer-relative, real-time).
- **Forecasting**: burn-rate → time-to-cap warnings *before* budgets blow (Little's Law validated; the math already works).
- **Auto-cap optimization**: `advisor.md` showed 79% hold reduction from right-sizing `max_tokens` — as a live recommender, that's customer-visible capital efficiency.
- **Data products**: per-customer spend analytics, industry benchmarks, KYA risk scores — the analytics their CFOs will ask for at contract renewal.

## Roadmap

| Phase | Ship | Proof it works |
|---|---|---|
| 1.0-alpha (weeks) | CDC → BQ append-only facts + canonical_spend mart + standing reconciliation | reconciliation diff $0.000000, continuously — the check this repo already runs |
| 1.0 (quarter) | dbt medallion, DQ contracts, hold-lifecycle + cumulative-by-rule marts, semantic layer | rule-engine and dashboard read the same cumulative; double-count class of bug becomes impossible |
| 1.0+ | trace/cost rollups, as-of-T serving, KYA marts | cost-per-task and dispute-replay demos |
| 2.0 | anomaly, forecast, auto-cap, external data products | the advisor's 79% number, live |

---

*Method note: every number here is from this repo's measured experiments (sources linked
inline). Sample sizes are small and labeled; mechanisms are confirmed, magnitudes are
one-account-one-evening scale. That's the point — these failure modes are visible at $0.28.
At $1M/day they're line items.*
