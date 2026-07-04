# sapiom-ledger-audit — Build Plan (MVP)

Goal: a reconciliation-audit tool over Sapiom's agent-spend ledger, built on their real API with real spend.
Story: "Sapiom restates transaction costs (supersession chains). I built the audit layer proving the money math reconciles — the thing I did for 3 years on healthcare claims."
Deliverable: audit report (markdown) + repo + 2-min Loom. NO dashboard in MVP.

## Confirmed API facts (verified 2026-07-03/04 via dryrun + hypothesis test — do not re-derive)

- Auth (governance API): `GET https://api.sapiom.ai/v1/{transactions|agents|agents/metrics|spending-rules|accounts}` with header `Authorization: Bearer $SAPIOM_API_KEY`. NO query params on transactions (`?limit=5` → 400). Pagination JSON:API style: response `meta.page.limit`=20, `links.next`. If >20 txns, follow `links.next` (relative path).
- Spend calls (payment API): via `@sapiom/fetch` `createFetch({ apiKey, agentName })` — agentName auto-creates/attributes agent. Endpoints:
  - search: `POST https://linkup.services.sapiom.ai/v1/search` body `{q, depth:'standard', outputType:'sourcedAnswer'}` — flat $0.006/call, single final cost row
  - LLM: `POST https://openrouter.services.sapiom.ai/v1/chat/completions` body `{model:'openai/gpt-4o-mini', messages:[...], max_tokens}` — ~$0.0005/small call, produces SUPERSESSION CHAINS (2 cost rows: initial superseded by revised; both isEstimate=false — they restate finals)
- Transaction shape (key fields): `id, serviceName, actionName, status, outcome, createdAt, authorizedAt, completedAt, agentId, agent{name,label}, traceId, costs[]`
- costs[] row: `id, transactionId, fiatAmount (string, 18dp), isEstimate, isActive, supersedesCostId, supersededAt, createdAt`
- LIVE cost = `supersededAt IS NULL` (equivalently isActive=true). Wallet balance moves by live cost only — verified: balance 4.993528→4.993028 = exactly the $0.0005 live row, not the $0.000544 superseded one.
- Balance: `GET /v1/accounts` → payload contains balance string field (see dryrun/hypothesis_result.json for exact shape).
- Existing spend on account: ~3 txns (~$0.007). $≈4.99 remains. TOTAL NEW SPEND BUDGET: $1.00 hard cap.

## Repo layout (all under /Users/jay.sharma/projects/sapiom-spend-intel/)

```
PLAN.md                  (this file)
dryrun/                  (keep as-is; scratch + hypothesis_result.json reference)
generate_spend.js        stage 1
ingest.py                stage 2
audit.py                 stage 3 (SQL inside via duckdb)
report.md                stage 3 output (generated)
spend.duckdb             stage 2 output (committed — demo data, no secrets)
README.md                stage 4
.gitignore               node_modules, .env, __pycache__
package.json             (move/copy dryrun deps: @sapiom/fetch)
```

Python: use `~/projects/infer_takehome/.venv/bin/python` (has no duckdb? — pip install duckdb into it, or `python3 -m pip install --user duckdb`; agent verifies).

## Stage 1 — generate_spend.js (Sonnet)

ESM script, key from env (exit if missing). Three createFetch clients:
- `researcher`: 12 search calls, sleep 5-15s random between
- `writer`: 10 LLM calls (varied prompts asking 100-600 word outputs, max_tokens 800), sleep 8-20s between
- `runaway`: 25 search calls, sleep 0.3s between (burst at end — anomaly data for later phases)

Requirements:
- Running cost counter using known prices (search .006, LLM est .002); ABORT if projected > $0.90
- Per-call log line: ts, agent, service, http status
- try/catch per call, continue on failure, count failures
- Total runtime ~15-20 min. Print final summary (calls per agent, est spend).
- Acceptance: node --check passes; dry-run mode flag `--dry` that prints planned calls w/o firing.

## Stage 2 — ingest.py (Sonnet)

- Env `SAPIOM_API_KEY`. GET /v1/transactions, follow links.next until exhausted.
- DuckDB `spend.duckdb`, two tables:
  - `transactions(id PK, service_name, action_name, status, outcome, agent_id, agent_name, trace_id, created_at, authorized_at, completed_at, raw JSON)`
  - `costs(id PK, transaction_id, fiat_amount DECIMAL(38,18), is_estimate BOOL, is_active BOOL, supersedes_cost_id, superseded_at, created_at)`
- Idempotent: INSERT OR REPLACE (rerun safe).
- Also fetch /v1/accounts, store balance snapshot in `balance_snapshots(fetched_at, balance DECIMAL(38,18), raw JSON)`.
- Inline DQ asserts (fail loudly): txn ids unique; no cost row with negative fiat_amount; every cost.transaction_id exists in transactions; row counts printed.
- Acceptance: script runs twice → identical row counts (idempotency proof, print both runs).

## Stage 3 — audit.py (Sonnet)

Reads spend.duckdb, writes report.md. Four checks, each → ✅/❌ + numbers + 1-line explanation:

1. **Double-count guard**: `SUM(all cost rows)` vs `SUM(live rows only)` (live = superseded_at IS NULL). Report both numbers + overstatement % if summed naively. Expect: naive > live (chains exist) → demonstrates the trap.
2. **Balance reconciliation**: latest balance_snapshot vs (initial_balance_constant − SUM(live costs)). Initial balance: $5.000000 (account seeded with $5; ~confirm from earliest data or parameterize INITIAL_BALANCE=5.00). ✅ if |diff| < $0.000001, else ❌ with diff.
3. **Revision analysis**: for each transaction with >1 cost row: initial amount (row that was superseded) vs final (live). Table per service: count of revised txns, avg revision % (final-initial)/initial. Narrative: "Sapiom restates costs; here's how much, by service."
4. **Chain integrity (orphans)**: (a) superseded rows whose superseding row missing (supersedes_cost_id pointing at them exists? check reverse); (b) transactions status=completed with zero cost rows; (c) >1 live cost row per transaction (double-live = double-charge bug). Each ✅/❌ + counts.

Also header section: totals (txns, agents, live spend, period) + per-agent spend table.
Acceptance: report.md renders clean, all four checks run against real data, no exceptions.

## Stage 4 — README.md (Haiku)

Sapiom-Showcase style: story-first. Sections: what/why (3 paras — restatement thesis, claims-pipeline parallel), what the audit found (pull real numbers from report.md), how to run (4 lines), services used + total cost table (their style), next steps (anomaly detection, forecast, dashboard, DQ contracts). Loom placeholder link at top.

## Checkpoints (Fable reviews)

- CP1: after stage 1 script written, before user runs it (spend = real money)
- CP2: after stage 3 report generated (review findings before README)

## Security

Key: env var only. Never in files, logs, README, or committed data. spend.duckdb contains no secrets (verify: no api key fields ingested).
