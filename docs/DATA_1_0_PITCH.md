# Data 1.0 — The Future of Sapiom's Data Platform

*A maturity pitch grounded in real data: one evening, a fleet of 16 agents, $0.28 of live spend on Sapiom's rails — audited like a payments ledger. Every claim below traces to a measured artifact in this repo.*

---

## Thesis

Sapiom's product is a ledger: the layer that decides what an agent may do, runs it, and **keeps the record**. Today that record answers one question — *what is true right now*. The trust customers are actually buying lives in the questions it can't yet answer: *what happened, what changed, what's about to go wrong, and can you prove it?* Those are data-platform questions. Data 1.0 is the analytical foundation that turns the ledger from a live state store into a system of record — and it's buildable now, because the rails already emit everything it needs.

---

## 1 · Inventory — what the rails already produce

Fired at least one real call through every service family to capture each data shape (sweep agents in `spend.duckdb`):

| Family | Service | Shape on the wire | At agent scale | What it unlocks |
|---|---|---|---|---|
| Search | Linkup / You.com | JSON results + sources, flat sub-cent pricing | High-QPS small rows | Cost-per-answer, relevance benchmarks |
| LLM | OpenRouter | Token-metered, **hold → supersede → settle chains** | Restatement-heavy; dominant row volume | Capture ratio, cap right-sizing, revision analytics |
| Images | Fal.ai | Binary payloads (MBs) | Object storage, not ledger rows | Media COGS per task |
| Audio | ElevenLabs | Binary payloads | Same | Same |
| Compute | Blaxel | stdout/stderr + artifacts, duration-priced | Job telemetry stream | Runtime cost curves, failure taxonomy |
| Scraping | Anchor Browser | HTML/DOM payloads | Large semi-structured blobs | Extraction yield per dollar |
| Data | Neon / Postgres | Structured rows | Row-level billing events | Usage-based pricing analytics |
| Messaging | SMS Verify | OTP / delivery-status events | Event stream | Delivery SLA, per-message economics |
| Scheduling | QStash | Schedule / webhook events | Async chain glue | Cross-service task stitching |

Plus the ledger core every call emits regardless of family: **transactions** (lifecycle timestamps, outcome), **cost chains** (hold → supersession → settlement), **traces** (flat grouping IDs today), **agents**, **governance rules + decisions**, **balance snapshots**.

Two structural facts drive the whole architecture:
1. **Costs restate.** A chained call posts a hold, then supersedes it with the settled actual — like a gas-pump pre-auth. The ledger is append-shaped by nature.
2. **Payloads dwarf the ledger.** Images, audio, HTML, stdout are megabytes; the money rows are bytes. They must separate or the ledger drowns.

## 2 · Data 0 — where the platform is today (honest read)

Transactional Postgres serving the hot path, dashboard reading live state, metrics computed on the fly. This is the *correct* Data 0 — the hot path should never be sacrificed to analytics. But it means: current-state only, no queryable history, every metric recomputed from operational tables, one definition of "spend" per query author, and reconciliation as a point-in-time act rather than a standing guarantee. Reactive by construction.

*(Observed from outside: supersession chains must be reassembled client-side; a naive `SUM(fiat_amount)` over cost rows overstates true spend by **+10%** on my ledger — the double-count trap is live today for any consumer of the raw rows.)*

## 3 · Data 1.0 — the analytical foundation (the pitch)

Stack assumption: BigQuery + dbt (their world), GCP-native spine.

```
Cloud SQL / Postgres  ── hot path stays untouched, source of truth for live state
        │  Datastream (CDC — no batch pulls off the operational DB)
        ▼
Pub/Sub → Dataflow  ── normalize events; DQ contracts gate at ingest
        ▼
BigQuery lakehouse  ── APPEND-ONLY event log; payloads land in GCS,
        │              ledger keeps pointers (skinny money rows, fat blobs aside)
        ▼
dbt medallion  ── staging → core ledger marts; CURRENT STATE IS DERIVED,
        │         never updated in place (window over supersession chains)
        ▼
Serving  ── BQ materialized views / BI Engine → customer spend analytics,
            internal dashboards, alerting, reconciliation service
```

Six load-bearing decisions:

1. **Append-only + derive-current — never MERGE.** Supersessions are restatements; model them the way a claims ledger models re-adjudication: every version kept, "current" is a view (`superseded_at IS NULL` semantics), so history, time-travel, and audit come free. At petabyte scale, MERGE-heavy pipelines die in BigQuery; append-derive scales linearly. This is the single most important modeling call and it matches how the rails already behave — **the ledger is already bi-temporal on the wire** (event time = `authorizedAt`/`completedAt`; record time = each cost row's `[created_at, superseded_at)` belief interval); the platform's only job is to not flatten it. That's what makes "what did we believe when we cut the invoice" and "why did this rule fire" answerable — a governance decision can only be audited against ledger-state-as-of-decision-time. One asymmetry: cost facts get this versioning free from supersession; **dimensions (rules, agents, budgets) don't** — the API mutates them in place (PUT + version, no hard delete), so the warehouse must keep explicit SCD2-style history to reconstruct rule-as-of-decision.
2. **DQ contracts as blocking gates, not asserts.** The invariants I checked ad-hoc — unique IDs, every cost references a transaction, at most one live cost per transaction (more = double-charge), supersession chains intact, amounts non-negative — become standing, versioned, severity-gated contracts with a queryable results trail. Bad writes stop at the producer. *(Pattern proven at Collective Health across 60+ jobs on regulated claims data.)*
3. **One semantic layer, one definition of spend.** "Live spend," "capture ratio," "auth rate" defined once in the mart layer, consumed everywhere — because I already measured what happens without it (+10% phantom spend from one wrong SUM).
4. **Reconciliation as a standing service.** Balance snapshots vs derived ledger, continuously, alert on drift — not a quarterly fire drill. My audit ties out at **$0.000000** on real spend; the platform should assert that every hour, forever. This is also the production catch-net for race-class bugs: the check-then-act authorization race I reproduced (2–3× rule-limit leak under concurrency) is exactly the class of drift a standing reconciliation surfaces before a customer does.
5. **Cost-per-task lineage.** Traces are flat grouping IDs today (6/81 of my transactions carried one). Add span hierarchy and the ledger answers the question every agent-platform customer will ask: *what did this task cost, end to end, across services?* That's a product feature living one modeling decision away.
6. **Payloads to object storage, pointers in the ledger.** GCS + pointer columns; the analytical ledger stays fast and cheap while media/HTML/stdout remain replayable for debugging and (later) ML.

## 4 · Data 2.0 — the intelligent horizon

Everything here consumes Data 1.0's marts; none of it is buildable credibly before them.

- **Anomaly & runaway detection** — my peer-relative detector already flagged the actually-anomalous agent (10 calls in <1s) over the suggestively-named one; productized, it beats any fixed threshold.
- **Burn-rate forecasting** — spend velocity → time-to-cap, per agent/tenant.
- **Auto-cap optimization** — holds are priced on requested `max_tokens`; right-sizing caps from observed p95 usage shrinks hold size **~79%** in my fleet. Closes the float finding with a product.
- **Failure reaping** — post-hold failures froze the full hold 4/4 times in my forced tests; a watcher that detects and releases orphaned holds turns an edge case into a guarantee ("failures are bounded, visible, recoverable").
- **Data-as-a-product** — customer-facing spend analytics, KYA scorecards, cross-tenant service benchmarks (which vendor answers cheapest per task). The ledger becomes revenue, not overhead.

## 5 · Proof — extracted from a trickle, one evening, $0.28

Every capability above is already demonstrated in miniature on my own ledger:

| Measured (this repo) | Value | Proves the platform needs |
|---|---|---|
| Balance reconciliation | **$0.000000 diff** on real spend | Reconciliation-as-a-service is achievable |
| Naive sum vs live sum | **+10% overstatement** | Semantic layer / derive-current modeling |
| Capture ratio | **18%** — authorize $1.00, capture $0.18 | Float analytics; cap right-sizing |
| Hold pricing | Linear at **$0.0006/1k tokens** through 64k — past the model's real output ceiling | Hold-size lever is real and modelable |
| Right-sizing remedy | **~79%** fleet hold reduction (p95-based caps) | Auto-cap optimizer (Data 2.0) |
| Float at scale (Little's Law) | ≈**$61–$138** frozen instantaneously at $1M/day TPV, holds clearing in 5.3–12.0s | Honest scale math: levers are hold *lifetime* and hold *size* |
| Authorization race | **2–3× rule-limit leak** under concurrency, mechanism identified | Standing reconciliation + serialized checks |
| Rules fire on holds | Denial's `currentValue` matched the hold to the micro-dollar | Governance analytics must model phantom vs real spend |
| Post-hold failure | Full hold frozen, **4/4** (forced tests; live frequency unmeasured) | Failure-reaper watcher |
| Chain integrity | **0** orphans, **0** double-live rows | The invariants worth codifying as contracts |

*Honesty rules carried throughout: sample sizes stated (81 transactions, 16 agents, one evening); mechanisms are measured, magnitudes are workload-shaped; forced-failure rates are not live rates.*

## 6 · Why this is my charter

I've built this exact platform once, in a domain with the same defining trait — **money that restates**. Healthcare claims get adjudicated, reversed, and re-priced continuously; at Collective Health I ran the medallion lakehouse over 20k+ claims/day where current state is derived from an append-only bi-temporal ledger, quality contracts block bad writes across 60+ jobs, and the balance ties out to the cent with a full audit trail. Sapiom's ledger has the same physics at a different clock speed. Data 1.0 isn't speculative architecture — it's the discipline I already practice, pointed at rails I've already measured.

---

### The 2-minute verbal spine (for the room)

> "Your rails already emit everything a world-class data platform needs — I know because I ran real money through all nine service families and cataloged the shapes. Today the ledger answers *what's true now*; customers are buying *prove what happened and warn me what's next*. The foundation is one modeling decision — append-only with derived current state, because your costs restate and MERGE won't survive your scale — plus contracts, one definition of spend, and reconciliation running as a service instead of an audit. I've already shown each piece works in miniature: penny-exact reconciliation, the +10% naive-sum trap, an 18% capture ratio with a 79% remedy. And the horizon is where it gets fun — anomaly detection, forecasting, cost-per-task lineage — but none of it stands without the 1.0 foundation. That's the platform I want to own."
