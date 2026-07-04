# Backlog — sapiom-ledger-audit

Ideas to test/build. Written so another model (Sonnet/Haiku) can execute each without prior context.
MVP frozen for interview 2026-07-08. Priority: P1 pre-interview if time · P2 strong post · P3 someday.

## HOW TO USE THIS BACKLOG

An agent handed this file BUILDS scripts and SELF-TESTS them on fixtures — it CANNOT run anything that spends real money or needs the live API key.

Tags: `[HUMAN-RUN]` = Jay must run it himself (real key, real money). `[HUMAN-UI]` = Jay clicks around in app.sapiom.ai by hand. Everything else (no tag) = the agent can build and fixture-test it cold; Jay runs it against real data after.

Setup, verified API facts, and repo layout live in `PLAN.md` and `README.md` (same directory) — read those before building anything.

## PREREQUISITES

- Env: `export SAPIOM_API_KEY=...` — set in Jay's terminal only; it spends real money, the agent never has it. **⚠️ In an autonomous-agent harness, EACH shell call is a FRESH shell — env does NOT persist between separate commands.** `source .env` in one call has no effect on the next command. EVERY key-needing command must inline the load in the SAME command: `set -a && source .env && set +a && <command>` (for node: `node --env-file=.env script.js`). Applies to service_sweep, ingest.py, chaining, and any spend script.
- Python: `~/projects/infer_takehome/.venv/bin/python` (duckdb 1.5.4 installed).
- Node: `@sapiom/fetch` already `npm install`ed at repo root and in `dryrun/`. ESM (`"type": "module"`).
- Governance API: `GET https://api.sapiom.ai/v1/...` requires header `User-Agent: curl/8.6.0` (omit it → Cloudflare 1010 block). Pagination: prefer `page[limit]=100` over following `links.next`.
- Working reference scripts to copy from: `dryrun/hypothesis_test.js`, `dryrun/cap_experiment.js`, `dryrun/extrapolation_experiment.js`. Pipeline order: `generate_spend.js` → `ingest.py` → `audit.py`.
- Note: `sapiom_scrape/out/*` lives in the SIBLING project `/Users/jay.sharma/projects/job_application/` (NOT this repo) — its recon is already distilled into the API RECON section below, don't try to re-read it.

## OPERATIONS & EDGE CASES (read before any hands-off run)

Money-safety + operational rules for an autonomous run. Rules 1-2 are SAFETY-CRITICAL — an agent + a real wallet with no global cap can drain funds.

⚠️ **1. GLOBAL BUDGET CEILING (safety-critical).** Each script has a local cost guard, but nothing caps CUMULATIVE spend across runs. Wallet ≈ $4.7 total — treat as a HARD ceiling. RULE: before ANY spend script, `GET https://api.sapiom.ai/v1/accounts` (Bearer + `User-Agent: curl/8.6.0`), read `availableBalance`; ABORT the run if `availableBalance` < $0.50. Never assume budget — check it.

⚠️ **2. NEW SPEND SCRIPTS MUST SELF-GUARD (safety-critical).** Any new money-spending script an agent writes MUST include: (a) balance pre-check (rule 1), (b) per-call running cost counter, (c) an abort threshold that stops the run if projected spend exceeds a small cap (e.g. $0.10 unless stated). Copy the guard pattern from `dryrun/extrapolation_experiment.js` / `generate_spend.js`. No unguarded loops that fire paid calls.

**3. Wallet at zero = hard halt.** No auto-topup. If balance is low/zero, STOP and tell Jay to add funds in app.sapiom.ai (dashboard, [HUMAN-UI]). Don't retry paid calls into a $0 wallet.

**4. One API key covers everything.** A single key (`permissions:["*"]`, prefix `sk_live_`) from app.sapiom.ai/settings works for ALL services (search/LLM/etc.) and governance reads. No per-service keys needed. Export as `SAPIOM_API_KEY`. (Earlier confusion about "a different key" was just a fresh key, not a requirement.)

**5. Cloudflare / rate limits under load.** Governance GETs need `User-Agent: curl/8.6.0` (else HTTP 1010). Heavy/fast bursts risk 429/turnstile — pace calls, exponential backoff on 429/403. SDK auto-retries 5xx (not 4xx). Don't hammer.

**6. Key expiry/revocation mid-run.** A 401 mid-run = key revoked/expired → HALT with a clear "re-export SAPIOM_API_KEY" message; do NOT silently skip and continue as if it worked.

**7. `spend.duckdb` is single-account.** It holds ONE account's data. Ingesting a different account's data into the same db mixes state — wipe/rename the db if switching keys/accounts.

**8. Governance experiments need manual setup.** Spending-rule creation is dashboard-only (SDK-confirmed) [SUPERSEDED — REST create works, see UNDOCUMENTED API SURFACE / governance_api_probe.md] — the rules-on-hold-vs-settlement and TOCTOU experiments require Jay to create the test rule in app.sapiom.ai FIRST [HUMAN-UI]; scripts only fire calls + observe.

**9. Multi-day data needs real calendar days.** Re-running `generate_spend.js` in the same session just adds same-day rows; genuine multi-day time-series requires running on different real days (no backdating param).

**10. Definition of done (handoff).** A build is done when its acceptance criterion (in its build sheet) passes against real `spend.duckdb`. Overall done = BUILD 0-2 built + run + report/dashboard render correct; BUILD 3 run by Jay; delivery (git init+push, Loom, email) complete [HUMAN-RUN]. `git init` is required before any push (repo is not yet git-initialized).

## SDK CAPABILITIES (from sapiom-js source — resolves several unknowns)

- ⭐ **Trace is SETTABLE**: `@sapiom/fetch` `createFetch({ traceId, traceExternalId, agentName, agentId, serviceName })` — global OR per-request via `(request).__sapiom = { traceExternalId, ... }`. Passing the SAME `traceExternalId` across chained calls makes Sapiom "find-or-create" one trace → you STITCH chains deterministically. Trace-mining + cost-per-task no longer gated on auto-grouping. Parity in @sapiom/axios + @sapiom/node-http.
- **x402 wire flow (fully typed in SDK)**: pre-auth `POST /transactions` → poll (`/transactions/{id}`, 30s/1s) → on 402 `POST /transactions/{id}/reauthorize` with `{x402}` → retry with header `X-PAYMENT` (x402 v1) or `PAYMENT-SIGNATURE` (v2) → fire-and-forget `POST /transactions/{id}/complete`. Network CAIP-2 `sapiom:main`. Makes the x402 teardown (Jordi) + emulator build cheap — copy the shapes.
- **Auto-idempotency**: SDK auto-sets `X-Idempotency-Key` (UUID) on every POST/PUT/PATCH. Idempotency is built-in (informs any exactly-once build — don't rebuild it).
- **`addFacts` costing**: `POST /transactions/{id}/facts` `{source, version, factPhase: request|response|partial|error, facts}` — backend auto-supersedes estimate costs. Newer than manual addCost.
- **`callSite`**: SDK captures call-stack (depth 3) per transaction — lineage signal.
- **Staging env: `api.sapiom.dev`** (vs prod `api.sapiom.ai`) — candidate FREE test environment; check if experiments can run there without prod money.
- **New service hosts**: memory.services.sapiom.ai, neon.services (DB), git.services, vault.services, plus `/v1/capabilities/{name}` generic gateway + `/v1/mcp` remote MCP + `/v1/auth/tokens` identity JWT.
- Other: `Sapiom-Identity` cross-service JWT, `integration:{name,version}` attribution stamp, per-request `enabled:false` bypass, pre-create txn via `X-Sapiom-Transaction-Id` header, `metadata` free-form bag, flags `preemptiveAuthorization`/`onDemandPayment`.

## EXECUTION ORDER (single queue)

0. ⭐ **BUILDs 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 optional (ONLY after 9-11 complete — touches same dashboard files)** (Dashboard v2 → NARRATIVE.md → README v2 → take-rate → loss-rate → auth-rate → dashboard v3; 13 optional = trace DAG viz) — HIGHEST PRIORITY, do before everything below. All free, zero API spend; do NOT run spend scripts. Sheets under TOP BUILD PRIORITIES. Commit after each build; push allowed (repo public at github.com/jsharma103/sapiom-spend-intel — verify `gh auth status` active account = jsharma103 first, else commit only).
1. **[HUMAN-UI]** Test-mode probe — 30-sec check at app.sapiom.ai/settings: create a key, is there a Live/Test toggle? Could make every experiment below free. (The API-side verdict is already logged under API RECON below — this just closes the one unscraped gap: the settings-page create-key UI.)
2. **[HUMAN-RUN]** Ship MVP delivery now: `git push` (personal GitHub, topics, pin) → record Loom 2-min → email Jeff + David (Tuesday night, lead with the max_tokens finding as a question). Converts what's already built into "delivered" before piling on more experiments.
3. Cheap high-value experiments — agent builds + self-tests each script on fixtures first, Jay runs against the real API (~$0.02 each, budget guard on):
   1. Workflow chaining — fire FIRST, it gates trace-path mining, cost-per-task attribution, and the hold-stacking sub-question.
   2. Rules-on-hold-vs-settlement — highest single-experiment value.
   3. Failed-call mid-flight hold release. (See INTERVIEW QUESTION BANK Jordi #13 — the recoverable-edge question that explains why this test matters.)
   4. (stretch, P2) Rule race / TOCTOU double-spend, only if budget + time remain.
4. **[HUMAN-RUN]** Second `generate_spend.js` run (~$0.24) — must happen on a different calendar day than the first run (no backdating param exists; see the fixed note on this item below).
5. CEO Dashboard build (no new spend, pure viz over data already on disk): the 5-panel demo cut — float meter, capital-efficiency ratio, reconciliation-green, runaway-red, margin strip — plus the WOW hold-lifecycle view (same "make it visible" goal; ship as one artifact or a companion page).
6. Free SQL findings (zero spend, over existing `spend.duckdb`): settlement latency distribution, x402 overhead tax, isEstimate mislabel, cost-per-successful-outcome, retry-storm detection, estimate-accuracy scorecard, Check-5 runaway detection, bitemporal time-travel/replay, take-rate/margin (one WebSearch for public provider prices), spend-optimization advisor.
7. Bigger builds:
   1. Reliability / SLA observability layer (P2, ~2hr, zero spend).
   2. Trace-path mining + trace→cost-per-task attribution (P1 — ONLY after step 3.1 confirms traceId groups chained calls).
   3. Governance-as-Code / `sapiomctl` (P1 — ONLY after the landmine pre-check on that item, see below).
   4. Auto-Cap Tuner (P3, build LAST of these four — it's the Spend-optimization advisor's logic repackaged; don't build both from scratch, see note on that item below).
   5. (stretch, P2/P3) Budget-enforcing SDK middleware, OTel exporter, local x402 sandbox emulator — in priority order, only if time remains.
8. Capstone: 9-service data-generation sweep (~$1-2) → Data 1.0 pitch deck (do LAST among builds — after MVP ships + DQX prep).
9. **[HUMAN-RUN]** Final delivery: PR into sapiom/Showcase (post-interview, if signals good), host dashboard on Sapiom compute, blog/LinkedIn writeup.

---

## TOP BUILD PRIORITIES (curated build sheets — execute top-down)

Interview 2026-07-08. BUILD 0 is a prereq for 2/3/4. BUILDS 1-2 = the demo pair (build before interview). BUILD 3 = [HUMAN-RUN]. 4-5 = depth/post. BUILDS 6-8 = the polish pass (dashboard v2 → narrative → README v2) — all free, HIGHEST PRIORITY, execute 6 → 7 → 8 first. BUILDS 9-11 = payment-exec metrics (take-rate → loss-rate → auth-rate) — all free, execute 9 → 10 → 11 after 6-8. Each sheet: files · inputs · outputs · acceptance. Ponytail: no frameworks, smallest thing that works.

### BUILD 0 (PREREQ for builds 2,3,4) — Extend ingest.py schema.
SDK revealed fields the findings need. Add: `transactions.trace_external_id` (from `trace.externalId`), `transactions.outcome`, a payment sub-object (either new table `payments(transaction_id, status, amount, protocol, network, authorized_at, completed_at)` or flatten onto transactions), `costs.fact_phase`, `costs.cost_details`. Keep INSERT OR REPLACE idempotency. Acceptance: re-ingest fixture + (Jay) live data, new columns populate, idempotent. Without this, cost-per-task + precise x402-tax can't compute.
FIELD AVAILABILITY (verified 2026-07-04): checked all 4 captured dryrun JSON files (hypothesis_result.json, extrapolation_result.json, cap_experiment_result.json, service_sweep_result.json) plus the live `raw` JSON column in spend.duckdb transactions — all agree. CONFIRMED PRESENT: `trace` object + `trace.externalId` (key exists, value always `null` in captured data — never set), `outcome` (top-level on transaction; values seen: success/error/null), `costs[].isEstimate` (always `false`), `costs[].supersededAt` (null or timestamp), `costs[].supersedesCostId` (null or uuid), `costs[].costDetails` (present, shape varies: hold rows = `{source:"payment_transaction", network, protocol, paymentTransactionId}`; settlement rows = `{source:"payment_capture", network, protocol, capturedAmount, originalAmount}`). ABSENT IN CAPTURED DATA: no `payment` sub-object anywhere on the transaction — `status`/`authorizedAt`/`completedAt` are flat top-level transaction fields, not nested; `protocol`/`network` live only inside each cost's `costDetails`, not a unified payment object. `costs[].factPhase` (or fact_phase/factphase) — zero matches, does not appear at all, not even null. Add columns only for present fields: `trace_external_id` (from `trace.externalId`, will ingest as null until BUILD 3 sets it), `outcome`, `costs.is_estimate`, `costs.superseded_at`, `costs.supersedes_cost_id`, `costs.cost_details` (JSON blob). Do NOT add a `fact_phase` column (field never appears) or a normalized `payments` table (no source object to flatten from) — if `payment`/`factPhase` are needed later, test `?include=` or a per-txn `GET /v1/transactions/{id}` before adding, per PLAN.md guidance.

### BUILD 1 ⭐⭐⭐ FLAGSHIP — CEO Dashboard (5-tile visual).
Files: `export_dashboard.py` (duckdb→dashboard_data.json) + `dashboard.html` (vanilla JS, inline CSS/SVG, no framework, no backend). Inputs: spend.duckdb (transactions/costs/balance_snapshots) + dryrun/extrapolation_result.json + report.md numbers. 5 tiles: (1) Float meter held-vs-settled [extrapolation Exp B; if re-pulled, read `unavailableBalance` field directly]; (2) Capital-efficiency ratio = Σsettled/Σheld; (3) Reconciliation green [report.md check 2, $0.000000]; (4) Runaway red [burstiness from transactions]; (5) Take-rate/margin [needs external provider prices — WebSearch]. Output: dashboard.html renders offline from local JSON. Acceptance: opens with no network, numbers match report.md, runaway agent flagged red. Full panel→data map in the CEO DASHBOARD closed-loop spec section below.

### BUILD 2 ⭐⭐ — Free SQL findings bundle → `findings.py`.
Input: spend.duckdb only, zero money. One script, each finding → a markdown section in findings.md: settlement latency (authorizedAt→superseding-cost createdAt, p50/p95 per service); x402 overhead tax (use PAYMENT sub-object `authorized_at` if BUILD 0 done, else txn authorized_at); cost-per-task (group `trace_external_id` → cost + wall-time + step count, needs BUILD 0 + trace data); estimate-accuracy scorecard (per service settled/held ratio); runaway detection check-5 (per-agent median inter-call gap + peak calls/min vs peer baseline → flag spend-runaway); callSite lineage (if SDK `callSite` present in fetched data, second attribution axis beyond traceId). Acceptance: all sections run against real spend.duckdb, runaway flagged.

### BUILD 3 ⭐⭐ [HUMAN-RUN] — Chaining experiment (agent builds script, Jay runs ~$0.02).
Method: one agent, multi-step task search→LLM-summarize→search, SET the SAME `traceExternalId` across all 3 calls via per-request `(request).__sapiom = { traceExternalId }` (SDK-confirmed settable). Poll transactions+accounts during (copy hypothesis_test.js). Dump txns+costs+`trace.externalId`. Measures: stitch-confirmed → HOLD-STACKING (do 3 holds coexist? balance dip = Σholds not max — could 5× the float finding), latency compounding, failure-mid-chain rollback. Output: chaining_result.json + verdict. Feeds BUILD 4.

### BUILD 4 ⭐ — Trace mining (AFTER build 3 runs).
Group on `trace_external_id`: path-mining (tool sequences, frequent paths via prefix-tree, most-expensive/most-failing path) + cost-per-task rollup. Input: extended spend.duckdb. Output: traces.md (+ optional inline-SVG Sankey). The structured+unstructured DE signal.

### BUILD 5 ⭐ — Advisor + Reliability (free, existing data).
`advisor.py`: per agent recommended max_tokens = p95(actual tokens)×buffer + cheaper-provider suggestion (the remedy for the float finding). `reliability.py`: success rate + p95 latency (authorized→completed) + error taxonomy per service. Outputs md. NOTE: advisor = the Spend-optimization advisor / Auto-Cap-Tuner core — build once here.

### BUILD 6 ⭐⭐⭐ — DASHBOARD v2 "CEO KPI edition" [HIGHEST PRIORITY — do first].
Goal: rebuild dashboard around 3 hero KPIs in payments-executive vocabulary (audience: ex-Shopify payments director). Cut info density — every number must land in <5 seconds. v1 problem: too much text, invented metric names.
Files: rewrite `export_dashboard.py` (emits `dashboard_data.js`) + `dashboard.html`. MUST stay self-contained: relative `<script src="dashboard_data.js">`, no CDN, no fetch() — must work from file:// AND GitHub Pages.
Layout:
- Top strip — 3 HERO tiles (huge numbers, minimal text):
  1. **TPV** (Total Payment Volume) = sum of live (non-superseded) costs. Subline: "N transactions · N agents · live spend".
  2. **CAPTURE RATIO** = settled/held, dollar-weighted across supersession chains (currently 18.0%). Subline: "authorize $1.00 → capture $0.18".
  3. **RECONCILIATION** = $0.000000 TIES OUT. Subline: "naive sum overstates +10% — supersession chains must be filtered, not summed".
- Under EACH hero: one scale-hook line in accent color extrapolating to $1M/day TPV (e.g. for capture ratio: the instantaneously-frozen-capital figure via Little's Law — "instantaneously frozen ≈ $Y at $1M/day TPV (holds clear in ~Ws)" — COMPUTE from data, don't hardcode. NOTE: an earlier draft of this spec proposed "$X.XM customer capital frozen daily" by naively scaling the capture ratio — that framing was WRONG (a per-day flow mislabeled as an instantaneous stock; see the correction note under INTERVIEW QUESTION BANK and `dryrun/float_model.md`). Do not reintroduce it.)
- Second row — 3 smaller tiles: (4) **AUTH→CAPTURE TIME** — settlement latency p50/p95 (data already in findings.py output). (5) **VELOCITY CHECKS** — renamed runaway-detection tile; keep flagged-agent table, max 5 rows; caption: "agent runaway = card-testing analog". (6) **TAKE RATE** — per-service markup table (Linkup +20%, etc. from service_sweep). Neutral header: "margin observability per service".
- Any tile body >40 words: move method detail into `title=` tooltips or a single footnote line. Regenerate timestamp at build time.
Acceptance: renders via file://; numbers match findings.md/report.md exactly; total visible words < half of v1; hero numbers readable across a room.

### BUILD 7 ⭐⭐ — NARRATIVE.md (interview story, numbers from data).
Goal: write `NARRATIVE.md` — 30-sec + 2-min story scripts with exact numbers pulled from findings.md/report.md (NO invented figures). Structure (expand this skeleton exactly):
- 30-sec (CEO/Zerbib): (1) "put a fleet of agents on your platform and audited it like a payments ledger" (2) "reconciles penny-exact — but capture ratio is 18%: you freeze $5 to settle $1" (3) "at agent-scale TPV that's real customer capital — and the ledger doing this is petabytes/day. That's the data platform I build."
- 2-min (CEO): expand with: TPV numbers; holds price on max_tokens (ONE sentence, no protocol jargon); the +10% naive-sum trap → why supersession-aware pipelines matter; velocity-check flag story; close: scale thesis (append-only + derive-current on BigQuery, petabyte/day) + remedy (advisor shows max_tokens right-sizing cuts holds ~79%).
- 30-sec variant (Jordi/protocol engineer): hold-vs-settlement divergence framing + open question "do spending rules evaluate on the hold or the settlement?" — framed as invitation to reason together, not gotcha.
- Each version: bold the ONE number to remember. Delivery notes section: which dashboard tile to point at per story beat.
Acceptance: every number traceable to findings.md/report.md; each 30-sec ≤ 90 words; CEO versions jargon-free (short, plain sentences).

### BUILD 8 ⭐ — README v2 (CEO-skimmable) [do after 6+7].
Goal: top of README = dashboard link + 3 hero KPIs + one-line finding. Method detail moves below the fold. Line 1: live dashboard link https://jsharma103.github.io/sapiom-spend-intel/dashboard.html. Then 3 bullets: TPV, capture ratio, ties-out (same numbers as dashboard). Then the 30-sec CEO paragraph from NARRATIVE.md. Existing content stays below under "Method / Full findings".
Acceptance: everything above the fold readable in 20 seconds.

**OPERATIONS addendum for BUILDs 6–8:** all free — NO API spend, do NOT run spend scripts. After each build: commit. Push now ALLOWED (repo is public at github.com/jsharma103/sapiom-spend-intel; verify `gh auth status` shows active account jsharma103 before pushing — if a different account is active, commit only, don't push). Order: 6 → 7 → 8.

### BUILD 9 ⭐⭐⭐ — TAKE RATE full table (9 services, "his-world KPI #1")
**Goal:** current take-rate table has only 2 comparators (Linkup, OpenRouter). Expand to all 9 swept services → blended take rate. Payments-exec framing (Adyen-style blended bps).
**Input:** `dryrun/service_sweep_result.json` (real charged amounts per service), sapiom.ai published pricing page, each underlying vendor's public pricing (web research — free).
**Method:** for each service: identify underlying vendor + EXACT operation performed (model, size, depth, duration); find vendor public list price for that exact operation; markup % = (sapiom_charged − vendor_public)/vendor_public. Assign confidence per row: HIGH (exact operation match), MED (close match — note the difference), DROP (can't match cleanly — EXCLUDE from dashboard, list in appendix; do not fudge apples-to-oranges rows).
**Output:** `take_rate.md` — table (service, operation, Sapiom charged, vendor public, markup %, confidence, source URL) + **blended take rate** dollar-weighted across HIGH-confidence rows, expressed as % and bps. Then update the dashboard take-rate tile: HIGH rows only + blended number.
**Acceptance:** every row has a source URL; blended number reproducible from table; dashboard tile matches take_rate.md.

### BUILD 10 ⭐⭐ — LOSS RATE (chargeback analog, bps)
**Goal:** express failures in payments language — "loss rate in bps of TPV".
**Input:** `spend.duckdb` + reliability.md data. Free, read-only.
**Method:** failed/errored transactions as % of txn count AND dollar-weighted bps of TPV ($ on failed calls / total live TPV). KEY question: were failures charged or auto-refunded? Inspect cost rows on failed txns — did a settlement occur? "Does Sapiom charge for failures" is the interesting finding either way.
**Output:** `loss_rate.md` + one line/mini-tile on dashboard. If sample has 0 failures, report honestly: "0 failures in N=81 sample" — still a number.
**Acceptance:** numbers reproducible from duckdb queries shown in the file.

### BUILD 11 ⭐ — AUTH RATE (governance approval rate)
**Goal:** payments auth-rate analog = % of agent transactions approved vs denied by governance.
**Input:** `spend.duckdb` `outcome` column (ingested in BUILD 0). Free, read-only.
**Method:** outcome distribution; auth rate = approved/(approved+denied). EXPECTED: ~100% since no spending rules were active in the sample — report honestly with caveat: "no governance rules active; metric becomes meaningful once rules deny transactions" + note the [HUMAN-UI] rule experiment (already in backlog) would populate it for real.
**Output:** auth-rate section appended to `findings.md`; optional dashboard footnote.
**Acceptance:** distribution table shown; caveat present.

### BUILD 12 ⭐⭐⭐ — DASHBOARD v3: two-section restructure (agent-native KPI definitions)
**PRECONDITION:** BUILDs 9-11 must be complete (this edits the same dashboard files).
**Goal:** restructure dashboard.html into TWO labeled sections. Section 1 = credibility (metrics a payments exec already knows, measured on Sapiom). Section 2 = the category-defining move (KPIs agent payments needs but nobody has defined — named after the CEO's own public vocabulary: "bounded, visible, recoverable" failures + "KYA / Know Your Agent", sources: his ComputerWeekly + Unite.AI interviews).
**Section 1 — "Payments KPIs — measured on Sapiom":** existing hero strip (TPV, Capture Ratio, Reconciliation) + second row (Auth→Capture Time, Velocity Checks, Take Rate incl. BUILD 9 blended rate) + BUILD 10 loss-rate + BUILD 11 auth-rate. Reorganize/retitle only — numbers unchanged.
**Section 2 — "Agent-native KPIs — proposed definitions":** grouped under three subheaders BOUNDED / VISIBLE / RECOVERABLE:
- BOUNDED: **Capital Overhang Ratio** = held$/settled$ (currently 5.5× dollar-weighted — same data as capture ratio, inverse framing). Greyed placeholder tiles (visibly "needs governance rules active" — honest roadmap, do NOT fake numbers): **Blast Radius $** (max spend before caps stop an agent), **Cap Utilization** (spend/budget per agent).
- VISIBLE: **Attribution Completeness** = % of txns with full context chain agent→trace→service→result (compute from duckdb: fraction of txns having agentName + traceId + service + outcome all non-null; use trace-mining data). **Phantom Spend Rate** = naive-sum overstatement vs live spend (the +10% — measures how wrong a supersession-naive pipeline reads the ledger).
- RECOVERABLE: **Hold-Release Latency** p50/p95 (auth→capture recast as capital-freed metric). **Refund-on-Failure Rate** = % failed calls with hold fully released (number comes from BUILD 10's loss_rate.md analysis).
- **KYA Scorecard** (full-width table closing section 2): one row per agent — spend, calls, velocity (median inter-call gap), peak calls/60s, anomaly flag → composite risk grade A-F (simple transparent formula, show it in tooltip). Data already in dashboard_data/traces/reliability outputs; assemble, don't recompute.
**Every Section-2 KPI tile:** one-line DEFINITION under the number (definitions are the product here). Method detail in title= tooltips.
**Also:** update NARRATIVE.md delivery notes with one new beat: after showing Section 1, pivot line — "these are your world's metrics; here's what I think agent payments actually needs to measure" → point at Section 2 headers, close on KYA scorecard.
**Acceptance:** two clearly labeled sections; all Section-2 numbers reproducible from existing data files; greyed placeholders visually distinct (no fake numbers); dashboard stays fully self-contained (relative script src, no CDN/fetch); still renders via file://; word budget — tile bodies ≤ 25 words.
**Ops:** free, zero API spend. Commit; push allowed (verify gh auth active account = jsharma103 first).

### BUILD 13 ⭐ — TRACE DAG (dependency-graph finding + viz)
**The finding (write this into the sheet as context):** Sapiom traces are FLAT grouping IDs — traceId/traceExternalId groups a task's calls, but there is NO parent-child / span hierarchy (contrast: OTel spans). The ledger answers "what did task X cost" but NOT "what caused what." Agent workflows are DAGs; edges can only be INFERRED from timestamps + callSite — heuristic, not protocol truth. Interview framing: for Jordi (protocol) = "should x402 metadata carry a parentSpanId? how should cost attribute across workflow edges?"; for CEO = per-workflow cost attribution is what customer CFOs will demand; flat traces cap the observability product.
**Goal:** small DAG visualization per trace — infer edges (time-order + callSite within each trace), render inline SVG per multi-call trace, either as a dashboard Section-2 addition or standalone `traces.html`. MUST be labeled clearly: "edges inferred from timing — not protocol-recorded". Self-contained (no CDN, no fetch), data from spend.duckdb/traces.md — free, zero API spend.
**Acceptance:** at least the chained-task trace (BUILD 3) renders as a DAG; inferred-label visible; works from file://.
**Ops:** free, zero API spend. Standalone or dashboard addition.

**OPERATIONS addendum for BUILDs 9–11:** ZERO API spend — no spend scripts; BUILD 9 uses web research + existing JSON only. After each build: commit; push allowed (verify `gh auth status` active account = jsharma103 first — else commit only). Order: 9 → 10 → 11.

---

## API RECON — mined from captured dashboard traffic (sapiom_scrape/out/api_log.jsonl, 2026-07-04)
No undocumented PATHS exist, but the dashboard's `include=` graph + query params reveal a richer model than the public docs. High-value leads:

- ⭐ **`unavailableBalance` is a real field** on `GET /v1/accounts` — balance splits 4 ways: `totalBalance / availableBalance / unavailableBalance / pendingCreditBalance`. **`unavailableBalance` = holds/float, exposed directly.** Float dashboard should READ this field, not infer from balance dips. Exact number, cleaner. Re-pull with live in-flight holds to see it move.
- ⭐ **`include=transaction-metrics`** — sub-resource the dashboard sideloads on `/v1/agents` and `/v1/services`, empty in our fresh account. Likely the time-series/analytics payload. PROBE on live account: `GET /v1/agents/{id}?include=transaction-metrics` and `GET /v1/services/{name}?include=transaction-metrics`. Could be the historical analytics we assumed didn't exist.
- ⭐ **Rules carry `include=parameters,conditions`** — `GET /v1/spending-rules?include=services,agents,parameters,conditions,transactions`. The actual policy-enforcement schema (empty here). PROBE with one live rule → answers hold-vs-settlement + rule-engine internals.
- **Undocumented query vocabulary** (use these, cleaner than links.next pagination we fought): `filter[time_period]=7d|all` (probably also 24h/30d/90d), `sort=created_at|-created_at`, `page[limit]=50|100`, `top_agents_limit=N`, `include=<rel,rel>`. Ingest.py could switch to `page[limit]=100`.
- `/v1/agents/metrics` attributes: totalAgents, activeAgents, totalTransactions, totalCostUsd, avgCostPerAgent, avgCostPerTransaction, topAgents[] (leaderboard, needs live data).
- `/v1/services/{name}/stats` attributes: hasTransactions, totalSpendUsd, lastTransactionAt, activeAgents, hasRules. NO pricing field → take-rate finding must diff vs external public prices (confirms plan).
- Confirms: NO traces endpoint (reconstruct from traceId). NO pricing endpoint.
- Texture: keys can mint keys (`createdByApiKeyId`), RBAC scopes `org.<resource>.<verb>` (write scopes: org/api_keys/users/invites/transactions/tenants), vendors proxied via `{slug}.services.sapiom.ai` (service-mesh).

## UNDOCUMENTED API SURFACE (verified 2026-07-04)

**Live REST governance endpoints** (via dryrun/governance_api_probe.md):
- POST /v1/spending-rules → 201; POST /v1/agents → 201. Both work with the transaction Bearer key + User-Agent: curl/8.6.0. NOT in SDK (@sapiom/core, @sapiom/fetch have no governance code), NOT in REST docs (docs.sapiom.ai shows governance only via MCP tools). MCP endpoint itself = https://api.sapiom.ai/v1/mcp (same host as REST).
- Rule schema: required name + ruleType (enum incl. usage_limit); parameters[]{limitValue, measurementType (e.g. sum_transaction_costs), intervalValue, intervalUnit}; agentIds[] for scoping. Full recipe in dryrun/governance_api_probe.md.
- NO hard-delete: DELETE /v1/spending-rules/{id} → 404, PATCH → 404. Only PUT works, requires `version` (optimistic concurrency), supports only status: active|paused. Governance objects effectively append-only / soft-delete-only.
- Interview value: (a) undocumented-but-live REST governance = either pre-GA or oversight — good question for the founding engineer; (b) append-only governance state = same bitemporal/SCD2 pattern as the spend ledger (consistency worth noting).

## Their official docs now local (as a skill)
`~/projects/sapiom-spend-intel/.agents/skills/use-sapiom/references/*.md` — full service docs: governance, ai-models, search, compute, data, images, audio, messaging, scraping, verify. Read these before designing any service experiment (real request/response shapes, params, pricing).
- governance.md: spending rules are **DASHBOARD-ONLY** [SUPERSEDED — REST create works, see UNDOCUMENTED API SURFACE / governance_api_probe.md] (confirmed via SDK source: no spend-rule types/endpoints in SDK or MCP; docs hint `sapiom_dev_*` MCP support may come later). Creating a rule = manual in app.sapiom.ai [HUMAN-UI]. `limitValue`, filters. Does NOT state whether rules evaluate on hold or settlement → the [P1] rules-on-hold-vs-settlement experiment still needed.
- Check `verify.md` + `data.md`/`compute.md` for the traces surface (agent-trace mining prereq).

## What we already know (context for any executor)

- **Payment model**: x402 protocol. Every paid call = a transaction with a `costs[]` chain: an initial **hold** (row later marked `supersededAt`) → a **settlement** (live row, `supersededAt IS NULL`). Wallet moves by live row only.
- **THE finding**: LLM hold is priced at `max_tokens × ~$0.0006/1k` (flat, linear 100→16k tokens, verified). Settlement = actual tokens used. So a big `max_tokens` freezes far more balance than the call costs. Confirmed float is real under concurrency (holds reduce spendable balance in-flight, 4.4× actual, then recover).
- **APIs**: governance (plain Bearer, needs `User-Agent: curl/8.6.0` to dodge Cloudflare 1010): `GET api.sapiom.ai/v1/{transactions,agents,agents/metrics,spending-rules,accounts}`. Transactions paginate JSON:API via `links.next` (prefix `/v1` — their link omits it). Payment calls via `@sapiom/fetch` `createFetch({apiKey, agentName})`.
- **Rules**: `POST /v1/spending-rules` — `ruleType:usage_limit`, `measurementType:sum_payment_amount`, rolling window, `groupBy:[agent]`, `agentIds:[...]`. Each authorization records `ruleExecutions`.
- **Working scripts to copy**: `dryrun/hypothesis_test.js` (balance polling + txn parse), `dryrun/cap_experiment.js` (hold-vs-cap), `dryrun/extrapolation_experiment.js` (scale + concurrency). All handle the curl UA + cost guards.
- Budget: ~$4.7 wallet left. Keep any single experiment < $0.05, guard before firing.

---

## TIER 1 — experiments that could surface a real bug/insight

### [P1] ⭐ Does test/sandbox mode exist? (could make EVERY experiment free)
Recon hint: API keys carry `keyPrefix: "sk_live_..."` + `type: "live"` → strongly implies a `"test"` key type (Stripe pattern; CEO Zerbib is ex-Shopify payments, would build test mode reflexively).
Probe: app.sapiom.ai/settings → is there a test/sandbox key toggle? Mint a key, check its `type`. Try a call with a test key → does it simulate the x402 hold/settle flow WITHOUT moving real wallet balance?
Outcomes: (a) test mode EXISTS → run ALL risky experiments (rules-on-hold-vs-settlement, TOCTOU race, failure-modes, chaining) on it for FREE + safe — huge unlock, re-run the whole Tier-1 list at zero cost. (b) NO test mode / weak → that's a PRODUCT GAP + a build (local x402 sandbox/emulator so devs test agent-payment flows without losing money — DE/infra tooling you'd own). Either way = win. Cost ~$0 (probe) or minimal.
**VERDICT (checked local docs + captured traffic 2026-07-04): NO test mode found.** Every API key is `sk_live_` / `type:"live"` (no `test` type anywhere), no `environment`/`livemode` field on accounts/txns/agents, docs mention no payment sandbox (Blaxel "sandbox" = compute, unrelated), key-creation takes only name+description. One gap: POST /v1/api-keys body not captured + settings-page key-creation UI unscraped → 30-sec manual confirm: app.sapiom.ai/settings → create key → any Live/Test toggle? If only name/description → confirmed no test mode. Conclusion: risky experiments must use real money + guards (as we've done); AND the absence is itself a product-gap finding → see sandbox-emulator build below. SDK also revealed a STAGING host `api.sapiom.dev` — check if it's a free test environment (point a key at it, does it move real money?). Possibly the "test mode" answer. **CONFIRMED 2026-07-04 (live checks): `api.sapiom.dev` staging is up but prod key → HTTP 401 (separate auth); `app.sapiom.dev` signup is INVITATION-ONLY. → No dev-accessible test mode: prod is all live keys, staging is invite-walled. External devs cannot test agent-payment flows without spending real prod money. This is now a CONFIRMED product-gap finding (not speculative) — strengthens the [x402 sandbox/emulator] build and the CEO adoption-leak pitch (Zerbib ex-Shopify: test mode = integration table stakes). Interview framing = ask as a genuine question ("is there a sandbox I missed / on the roadmap?"), not a gotcha.**

### [P1] Do spending rules evaluate on HOLD or SETTLEMENT?  ⭐ highest value
Hypothesis: rules sum `payment_amount`; unclear if that's the hold or the settled cost.
NOTE [HUMAN-UI]: rule creation is dashboard-only (SDK-confirmed) — Jay must create the test rule in app.sapiom.ai first; the script only fires calls + observes.
Method: create rule cap $0.01 on a fresh agent (`rule-test`). Fire ONE LLM call, `max_tokens:16000` (hold ≈ $0.0096, settles ≈ $0.0001). Immediately fire a SECOND identical call before settlement.
- 2nd call BLOCKED → rules evaluate on **holds**. Huge: a lazy `max_tokens` can trip a spend cap at ~1% of real spend → self-inflicted DoS. Finding upgrades from "cost trivia" to "availability bug class."
- 2nd call ALLOWED → rules evaluate on settlements. Also worth stating (rules lag real exposure).
Bonus: generates denial + `ruleExecutions` records → feeds denial-analytics idea.
Cost ~$0.02.

### [P1] What happens to the hold when a call FAILS mid-flight?
Hypothesis: failed/errored calls should release their hold; if not → leaked capital (orphaned holds).
Method: fire call with (a) invalid model name, (b) valid model but abort the socket mid-generation. Poll `/v1/transactions` for that agent + `/v1/accounts` for 30s. Does a hold row appear then release? How long? Any hold with no settlement and no release = orphan.
Outcome: clean release = robust. Stuck hold = classic auditor find (money frozen on failure).
Cost < $0.005.

### [P2] Rule race / double-spend (TOCTOU)
Hypothesis: near-exhausted rule + 2 concurrent calls that each fit alone but not together → do both authorize?
NOTE [HUMAN-UI]: rule creation is dashboard-only (SDK-confirmed) — Jay must create the test rule in app.sapiom.ai first; the script only fires calls + observes.
Method: rule cap set so remaining budget = ~1.5× one call's hold. Fire 2 calls in parallel (`Promise.all`). Both authorized → race window in governance (check-then-commit not atomic).
Outcome: both allowed = double-spend race (report privately + politely — big credibility). Blocked correctly = "I tested for it, it's atomic" still strong.
Cost ~$0.02. Careful: caveats — could just be eventual-consistency, verify by repeating.

### [P2] Denial analytics
After rules exist (from above), dissect `ruleExecutions` + denied transactions: denial rate per rule/agent, latency of denial, cost of denied work. Nobody surfaces this.
Cost: free (uses data from rule experiments).

### [P1] ⭐⭐ Workflow chaining — what happens when calls chain into a multi-step task?
Most realistic agent behavior (real agents chain; single calls are the toy case). One experiment probes 5 unknowns + bridges the float finding and the lineage vertical.
Method: one agent runs a chained task — search → LLM summarize the result → second search on a follow-up. Optionally register via `/v1/workflows/definitions` (unexplored endpoint) to see if a workflow is a first-class object. During the chain, poll `/v1/transactions` + `/v1/accounts` (copy hypothesis_test.js poller). After: dump all txns + costs + traceIds.
→ METHOD: SET same `traceExternalId` across chained calls via per-request `__sapiom` (deterministic stitch). See BUILD 3.
The 5 unknowns:
1. **Shared traceId?** chained calls thread one trace → cost-per-task attribution FREE (unlocks lineage vertical). Fresh trace each → needs external correlation. Check: group txns by traceId, >1 txn per trace? → UPDATE: SDK confirms you can SET `traceExternalId` per call — so stitching is deterministic, not luck. Experiment now CONFIRMS grouping behavior + measures hold-stacking, rather than gambling on auto-group.
2. **Workflow = first-class object?** `/v1/workflows/definitions` — parent record w/ rollup cost, or N loose txns? Can you cap a TASK or only calls?
3. **Do holds STACK across the chain?** ⭐ compounds the float finding. If step-1 hold not released before step-2 fires → a 5-step task holds ALL pre-auths at once → float = Σ holds not max. Chained agent w/ generous caps freezes 5×(the 40×). Check balance dip during chain vs single call.
4. **Latency compounding** — x402 tax (created→authorized) × N steps. Does payment layer become the bottleneck on long chains?
5. **Failure mid-chain** — kill step 3: do steps 1-2 settle or whole task roll back? Holds released? Partial-charge on failed task = trust event.
Feeds: lineage/cost-per-task vertical (#1 trace), float finding (#3 stacking), reliability (#4/#5). Cost ~$0.02.

---

## TIER 2 — cross-service / mechanics (generalize the finding)

### [P2] Hold mechanics for OTHER variable-priced services
Same dissection as max_tokens, per service knob:
- **Image gen (FAL)**: $0.004/megapixel — does hold scale with requested resolution/size param?
- **Compute (Blaxel sandboxes)**: duration-priced — hold on estimated runtime? what's the estimate?
- **Audio (ElevenLabs)**: per-character? hold vs input text length?
Method: vary the size knob 3×, dissect hold vs settlement (copy cap_experiment.js structure).
Payoff: turns one LLM quirk into "**a systematic authorization-hold audit methodology across the platform**." Methodology > finding.
Cost ~$0.01–0.03 each.

### [P3] Search depth pricing
Linkup `depth: 'standard'` vs `'deep'` — flat $0.006 or variable? Single vs chained cost row? (Search looked flat single-row in dryrun — confirm deep isn't different.)
Cost ~$0.02.

### [P3] Multi-provider spread within a capability
AI Search has 2 providers (Linkup, You.com); Databases has 3. Same query both providers → price + latency delta. Is one systematically cheaper? Arbitrage signal for agents.
Cost ~$0.02.

---

## TIER 3 — free findings (SQL over existing DuckDB, zero spend)

### [P2] Settlement latency distribution
`authorizedAt` → superseding-cost `createdAt`, p50/p95/max per service. How long money sits mis-stated on the ledger.

### [P2] x402 overhead tax
Payment-machinery time (`createdAt`→`authorizedAt`) vs service execution (`authorizedAt`→`completedAt`), per call. % overhead the payment layer adds. Is it fixed or scaling?
→ use the PAYMENT sub-object `authorized_at` (SDK) for precise payment-machinery latency, not just txn authorized_at (requires BUILD 0 ingest extension).

### [P3] isEstimate mislabel (data-quality finding)
Both hold and settlement rows carry `isEstimate: false`. Semantically the hold IS an estimate. Their own schema bug — one polite README line or a DQ-check that flags it.

### [P3] Trace anatomy → free cost-per-task
Do multi-call agent runs share a `traceId`? Group costs by trace → if traces span calls, cost-per-task attribution comes free (the thing their dashboard lacks). Check: any traceId with >1 transaction?

### [P3] Cost per successful outcome
Spend ÷ count(`outcome='success'`). Failed calls inflate true unit cost above nominal price. Per service.

### [P3] Retry-storm / duplicate detection
Same agent+service, near-identical timestamps + identical params → wasted duplicate spend.

### [P3] Estimate-accuracy scorecard per service
For every supersession chain: (settled − hold)/hold. Which services over/under-hold most? Predictability ranking. (LLM = −38% workload-shaped; is any service's hold *exact*?)

---

## RESILIENCE / RECOVERY EXPERIMENTS (break-it-and-watch-it-heal)

Frame: these test Ilan Zerbib's stated principle that failures must be "bounded, visible, and recoverable" — each experiment breaks something and observes whether money/state recovers. Cross-link to Jordi Q#13 and BUILD 3.3.

⚠️ **MONEY-SAFETY reminder.** These spend real money and/or create real spending rules. Every run: pre-check `GET /v1/accounts` (Bearer + `User-Agent: curl/8.6.0`), abort if `availableBalance < $2.75` or `< $0.50`; per-run cost cap; pause/cleanup any rule created; inline `set -a && source .env && set +a && <cmd>` (fresh shell each call). Never scope a rule to a real agent or create an unscoped/all-agents rule.

### [PRIORITY: high, the headline] ⭐ R1 — Orphan hold (THE recoverable-edge)

**Goal:** does a placed hold get released when execution dies mid-flight? (The scary failure never seen naturally — our 2 observed failures died BEFORE the hold was placed; this forces a failure AFTER.)

**Method:** fire an LLM call with a large max_tokens (big hold placed), then abort/kill the connection mid-execution (client-side abort after the x402 hold is confirmed but before completion). Inspect the transaction's cost rows afterward: is there a live (supersededAt IS NULL, isEstimate=true) hold left dangling? Does it get reaped on a timer (poll the same txn over a few minutes)? Or a supersession/refund chain releasing it?

**Recovery = frozen funds released** (hold superseded/refunded) within some bound; failure = orphan live hold hangs forever.

**Cost/Risk:** LOW if max_tokens kept modest; the hold may briefly freeze real balance — keep small, verify release. Ties to BUILD 3.3 + Jordi Q#13.

**ANSWERED (2026-07-04).** The lifecycle-position story is now complete across three independent observations:

1. **Pre-hold failure → $0.** The 2 organically-observed failures (`sapiom_fal` 404, blaxel DNS) died before a hold was ever priced — zero cost rows, nothing to release (`loss_rate.md`).
2. **Denied-at-auth hold → released, but slowly.** The hold-vs-settlement experiment's denied-call holds ($0.002403 each — gated RL-005 call + 3 TOCTOU calls, $0.009612 total) had **not** auto-released ~10 min later, past the x402 `maxTimeoutSeconds:300` (5 min) marker — `totalBalance` stayed unchanged throughout (frozen, not lost); release appears to run on a backend sweep/cron cadence, not instantly at timeout. No void/release endpoint exists to force it (confirmed: no `DELETE`/`PATCH` route on `/v1/agents` or the rule/txn objects). See `dryrun/hold_vs_settlement_experiment.md` (Cleanup section).
3. **Post-hold execution failure → the full hold is CAPTURED, not released.** `dryrun/hold_linearity_extension.md`'s 128k-token call errored with a `502 Bad Gateway` *after* its $0.076803 hold was authorized — and that hold was billed as the final settled cost in full, confirmed by an exact $0.076803 balance drop (not a transient dip that reverted). This is R1's original scenario (a hold that survives a mid-EXECUTION death) and it does **not** recover — the opposite of "clean reject" behavior. N=1, one clean observation.

**R1 verdict: NOT uniformly recoverable.** A hold on a call denied-before-execution eventually releases (slowly, on a sweep cadence). A hold on a call that fails *during* execution, after authorization, is captured outright — the worst-case failure mode Zerbib's "bounded/visible/recoverable" framing would flag as unrecovered. **Remaining open item (narrower, not R1 itself):** what IS the backend sweep cadence for released holds on denied auths? (Distinct question from the captured-hold-on-failed-execution finding above, which is now closed.)

### [PRIORITY: medium, cap tightly] ⭐ R2 — Concurrent overspend (money-safety headline)

**Goal:** if combined HOLDS from parallel calls exceed the wallet, does the platform oversell (wallet negative) or reject the excess?

**Method:** given holds stack (~4.4x settled under 10-way concurrency, verified), fire N parallel calls whose summed holds exceed availableBalance. Watch: do all authorize, or do some get rejected once holds exhaust balance? Does availableBalance ever go negative?

**Recovery = wallet never negative, excess cleanly rejected.**

**Cost/Risk:** MEDIUM — actual settlement should be small (tiny actual tokens) but this deliberately stresses the wallet; HARD cap, do only after R1 confirms holds release cleanly, and only if balance safely above floor. Abort if availableBalance < $2.75 or < $0.50.

### [PRIORITY: high, cheap+clean] ⭐ R3 — Idempotency replay

**Goal:** replay the same request twice — charged once or double?

**Method:** the SDK auto-sets X-Idempotency-Key. Fire a call, capture the key + body, then replay the identical request (same idempotency key) via raw HTTP. Compare: one settlement or two? Same transaction id returned?

**Recovery = dedupe** (one charge, same txn id).

**Cost/Risk:** LOW — at most one real charge. Clean finding either way.

### [PRIORITY: high, likely $0] ⭐ R4 — Abandoned x402 handshake

**Goal:** start the payment flow, get the hold, never send the signature — does the pending hold expire/release or lock funds forever?

**Method:** drive the x402 wire flow manually (POST /transactions → poll → reauthorize gets the x402 challenge/hold) then STOP — never send X-PAYMENT/PAYMENT-SIGNATURE. Poll the transaction + availableBalance over several minutes: does the pending authorization expire (hold TTL) and free the funds?

**Recovery = pending hold expires and releases within a TTL.**

**Cost/Risk:** LOW — handshake never completes so likely $0 settled; only tests whether the interim hold frees.

### [PRIORITY: low, do LAST, small] ⭐ R5 — Wallet-boundary drain

**Goal:** at near-zero balance, does a call reject cleanly or leave a partial/stuck state?

**Method:** with balance drained close to a small threshold (do NOT actually empty the real wallet below the $0.50 floor — simulate the boundary with a tightly-scoped per-agent spending rule instead, using the REST governance API, so we hit a *rule* limit not a real empty wallet), fire a call that would exceed the remaining allowance. Observe reject vs partial charge.

**Recovery = clean reject, no partial/stuck charge.**

**Cost/Risk:** HIGH conceptually but de-risked by using a rule-based boundary instead of draining the real wallet. Do last.

**Interview story note:** "All tie to one interview story: 'I tried to break your ledger five ways — here's what recovered and what didn't.' Maps to Zerbib's bounded/visible/recoverable. R1/R3/R4 are cheap+safe (run first); R2/R5 stress the wallet (cap hard, run last). NOTE: the hold-vs-settlement rule experiment (dryrun/hold_vs_settlement_experiment.md) is a related in-flight probe."

---

## STRUCTURED + UNSTRUCTURED — agent-trace mining (they want a DE who does both)
A trace = execution log: tool sequence + timing + cost (structured) AND inputs/outputs/reasoning per step (unstructured). Richest "analyze both" substrate, and it's THEIR data. Sapiom confirmed to have "a bunch of agent traces."

**ACCESS — RESOLVED (checked official docs 2026-07-04): NO traces API.** Docs are MCP-tool-shaped, zero REST traces endpoint ("trace" in docs = compute job stdout, unrelated). Tenants' traces private (expected). BUT: every txn carries server-assigned `traceId` + caller-`trace.externalId` (null by default; no documented setter — calls do accept custom `headers`, mechanism unknown). → Reconstruct YOUR OWN traces by grouping `/v1/transactions` on `traceId`. Feasibility collapses to ONE unknown: **how does traceId auto-group?** (per-call / per-chained-task / per-burst) — the [P1] workflow-chaining experiment measures exactly this. If chained calls share a traceId → mining works free on real grouping. If fresh traceId per call → need externalId (probe: try a header, inspect @sapiom/fetch opts). RUN CHAINING EXPERIMENT FIRST — it gates both trace ideas.

### [P1] ⭐⭐ Trace-path mining — how is the platform REALLY used (CEO product intelligence)
What tool SEQUENCES do agents run? Mine frequent paths, Sankey of behavior, longest / most-expensive / most-failing paths.
Method: group calls by traceId, order by timestamp → path string (e.g. search→llm→search). Frequent-sequence mining (count n-grams / prefix tree). Structured sequence + unstructured step content for labeling. Render Sankey or prefix-tree.
Payoff: tells CEO how his platform is used at the BEHAVIORAL level (his own dashboard shows spend, never paths). "60% of traces are research→summarize; your most expensive path is X→Y→Z at $N avg." DE-analyzes-both signal: messy execution logs → structured insight.

### [P1] ⭐ Trace → cost-per-task attribution (the gap their dashboard can't fill)
Roll each trace up: "this research task = 3 searches + 2 LLM calls = $0.42, 8s, 5 steps." Cost per OUTCOME, not per API call (transactions = raw calls, not tasks).
PREREQ: trace-anatomy probe — confirm multi-call runs share a traceId (the [P1] workflow-chaining experiment above answers this directly).
Method: group costs by traceId → sum cost + wall-time (min created → max completed) + step count per trace. Rank most expensive tasks. Join trace content to label task type.
If traceId doesn't auto-group chained calls: modify generate_spend.js so one agent runs a multi-step "task" (search → LLM summarize → search again) passing a shared trace/externalId if the SDK allows; else check if traceId auto-groups a burst.
Payoff: the cost-per-outcome attribution Realism + their dashboard both lack. Pairs with path-mining. Pure DE — graph rollup, ~2-3hr + trace probe (free if the chaining experiment already confirms grouping).
Both feed [[the lineage vertical]] and pair with the workflow-chaining experiment (which confirms whether chained calls share a traceId — the enabler for both).
→ group on `trace_external_id` (not just traceId); generate trace data by setting one traceExternalId across a multi-step task. See BUILD 4.

## NEW VERTICALS (beyond money-correctness)

### [P2] Reliability / SLA observability layer  ⭐ cleanest sibling
Their dashboard shows spend, zero health. All data already in DuckDB (`outcome`, `status`, `createdAt`/`authorizedAt`/`completedAt`).
Build: per-service success rate, error taxonomy (denied/cancelled/failed breakdown), latency p50/p95/p99 (execution = authorized→completed), SLA-breach flags. Pure DE — metrics pipeline + percentiles + time-series. New `reliability.py` or a section in audit.py.
Pitch: "Audited the money; here's the reliability layer beside it." Zero new spend, ~2hr.

ENABLER CONFIRMED: SDK lets you set `traceExternalId` → deterministic chain-stitching; this item is now unblocked (no longer waiting on auto-group discovery).
(Trace-based lineage / cost-per-task attribution merged into the [P1] entry above under STRUCTURED + UNSTRUCTURED — do not build twice.)

## ENGINEERING BUILDS (build-side — infra other agents use, not read-side analysis)

### [P1] ⭐⭐ Governance-as-Code — declarative control plane for agent spend
⚠️ **PRE-CHECK before writing any code:** ⚠️ BLOCKER: SDK source confirms NO programmatic rule create (not SDK, not MCP) [SUPERSEDED — REST create works, see UNDOCUMENTED API SURFACE / governance_api_probe.md] — governance is dashboard-only today. sapiomctl has no write API to target. Either (a) park this until Sapiom exposes governance via API/MCP, or (b) rescope to a READ-ONLY drift-detector (fetch live rules, diff vs YAML, REPORT drift — no apply). Don't build the apply path.

The pitch nobody else will have: their rules/agents/budgets are configured by clicking the dashboard. Build the IaC layer — GitOps for agent governance. **This is the DQX CI-sync pattern (YAML → diff → reconcile-merge) ported to Sapiom's API.** Same senior muscle, their domain. Real backend software, not scripts.

Why it wins the interview:
- Declarative reconciler = actual engineering (state diff, dry-run, drift detection), not a report.
- 1:1 retell of the DQX story (YAML rules → CI diff → Delta merge on rule_id) → interviewer sees transferable pattern instantly.
- Fills a real gap: no infra-as-code for their governance today.
- Buildable lazy: YAML + diff + 3-4 API calls.

Architecture:
```
spend-policy.yaml            desired state (agents, spending-rules, budgets)
   │
sapiomctl plan               fetch live state → diff → print create/update/delete
   │                          (dry-run, no writes; exit 0 if in sync)
sapiomctl apply              execute the diff to converge live → desired
```

Spec:
- **Desired state** = `spend-policy.yaml`: list of agents (name, description) + spending-rules (name, ruleType, measurementType, limit, window, groupBy, agentIds). One readable file = whole org governance.
- **Live state**: `GET /v1/agents`, `GET /v1/spending-rules` (Bearer + curl UA).
- **Diff/reconcile** keyed on `name` (stable id): in-yaml-not-live = CREATE; in-both-but-changed = UPDATE; live-not-in-yaml = DELETE (or flag as "unmanaged" unless `--prune`). Mirrors DQX Delta-merge-on-rule_id.
- **plan** prints colored diff, writes nothing, exits nonzero if drift (CI-friendly — same as DQX CI gate).
- **apply**: POST/PATCH/DELETE to converge. Idempotent — apply twice = second is no-op.
- NOTE: SDK auto-sets X-Idempotency-Key on writes; don't rebuild write-side idempotency, only ingest-side (INSERT OR REPLACE).
- **FIRST verify** (60s, ~free): does `/v1/spending-rules` support PATCH + DELETE, not just POST? If create-only → reconcile degrades to create + warn-on-drift (still valuable, note the ceiling).
- Lazy build: single `sapiomctl.js` (~150 ln), no framework, no state file (live API IS the state). Skipped: multi-env, secrets mgmt, plan-file artifact — add when >1 consumer.
- Loom money-shot: edit yaml (drop a cap 50%), `plan` shows red diff, `apply`, dashboard updates live. GitOps in 20 seconds.
Effort ~3-4hr. Highest interview leverage of anything in this doc — it's the DQX story made runnable on their stack.

### [P2] Budget-enforcing SDK middleware / circuit-breaker
Their holds fire AT the limit (reactive). Build a client wrapper around `@sapiom/fetch`: pre-flight budget check (query `/v1/accounts` + in-flight holds), circuit-breaker trips on burn-rate, auto-downgrade `max_tokens` when float tight. **Consumes the max_tokens finding** — turns the discovery into a live guardrail. Engineering: request interceptor, rolling-window state, exponential backoff. Narratively tight (finding → fix in one artifact). ~3hr.

### [P3] OpenTelemetry exporter
Their data is trapped in the dashboard. Build exporter: transactions → OTel spans (`traceId`→trace, cost→span attribute, lifecycle ts→span timing) → any backend (Grafana/Honeycomb/Jaeger). Agent spend shows up next to app metrics. Engineering: incremental streaming poller (cursor on createdAt), span mapping, OTLP export. Platform-plumbing flavored. ~3-4hr.

### [P3 — lowest priority] Local x402 sandbox / emulator (validated product gap: they have NO test mode)
Since Sapiom has no test/sandbox mode (verified — see test-mode probe above), devs can't test agent-payment flows without spending real money. Build a faithful local mock of the x402 hold→settle→void lifecycle so agents (and CI) test spend flows offline, free.
Dual appeal: CEO Zerbib (ex-Shopify payments — knows Stripe test mode = dev-adoption table stakes; "your onboarding leaks devs who won't risk real money experimenting") + Jordi (x402/L402 protocol — the emulator is his domain). DE/infra flavored.
Scope (ponytail): mock server implementing the documented gateway shapes (search/LLM/etc.) + a hold/settle state machine + fake wallet, so existing scripts point at localhost instead of *.services.sapiom.ai. Skipped: real payment rails, full service parity — mock only what experiments need. Lowest priority — a post-hire / stretch idea, not interview-critical.
→ mirror exact SDK wire flow: POST /transactions → poll → reauthorize{x402} → header X-PAYMENT(v1)/PAYMENT-SIGNATURE(v2) → complete; two x402 versions (see SDK CAPABILITIES).

## SYSTEM-OF-RECORD FEATURES

### [P3 — build LAST, after the rest] ⭐ Auto-Cap Tuner — the flagship REMEDY (finding → fix, same repo)
NOTE: same core computation as the [P1] Spend-optimization advisor — build the advisor first; Auto-Cap Tuner = that logic repackaged as a live tuner later. Don't double-build.
Directly kills the headline finding (max_tokens holds freeze ~40× actual spend). Pure DE: analyze each agent's ACTUAL token usage from settled costs → recommend/set optimal `max_tokens` = p95(actual tokens) × safety buffer → float eliminated.
Method: over spend.duckdb — per agent/service, distribution of actual output tokens (back out from settled cost ÷ per-token rate), compute p95, emit recommended cap + projected float reduction. Optional: a middleware that dynamically sets max_tokens per call. 
Why flagship: closes the narrative in ONE artifact — "found the 40× float → built the thing that eliminates it." The remedy a Sapiom DE would genuinely own. Build AFTER shipping MVP + DQX prep; it's the capstone, not the opener.
Remedy-map framing (pair every finding with its fix — reads senior): max_tokens float→auto-cap tuner; rules-fire-on-hold→hold-aware budget shim; double-count→canonical spend view; hold-stacking→chain-aware reservation; runaway→auto-kill guardrail; no cost-per-task→trace rollup; hold variance→per-service calibration.

### [P1] ⭐ Bitemporal time-travel / replay — as-of-T ledger queries
Reconstruct wallet + spend state as of ANY past timestamp from the supersession chains. Their dashboard shows current state only; the ledger holds full history nobody exposes.
Why useful (concrete):
- **Disputes**: "you overcharged me Tuesday" → replay to Tuesday, show exact held/settled state. Payments platforms live on this.
- **Debug rule decisions**: why did a rule block an agent last week? Reconstruct the state the rule saw at that instant. Ties to open "rules fire on hold or settlement?" question — need as-of state to prove it.
- **DE-5894 bug class**: CH's $1.12M bug was point-in-time attribution error (contra-row split across date window). Time-travel is the exact tool that catches it: "does balance at time T reconcile?" Jay has lived why this matters.
- **Compliance**: "prove your books at Q1 close" — point-in-time correctness = table stakes, not surfaced.
Method: SQL over costs — for target T, the live cost of each txn = the row where created_at ≤ T AND (superseded_at IS NULL OR superseded_at > T). Sum → wallet-as-of-T. Free.
Appeal: DE core (as-of-date, `fact_medical_claim_line` verbatim) + protocol correctness (Jordi: "reproduce belief at T"). Caveat: 50 txns/one evening = thin dataset; sell the CAPABILITY + story, not current data.

### [P1] ⭐ Spend-optimization advisor — findings → actionable product
Turn the findings into a recommender. Analyze an agent's patterns → recommend: optimal max_tokens (cut float, uses THE finding), cheaper provider for same capability (cut cost, uses take-rate finding), tighter cap. Output: "cut float 90%, spend 15%." Consumes float + margin findings → product.
Method: over spend.duckdb — per agent: hold-utilization ratio → suggest max_tokens = p95(actual tokens)×buffer; per service → flag if a cheaper provider exists (from take-rate data). Free.
Appeal: CEO (customer value / stickiness) + customer-facing. Closes loop: discovery → guardrail → recommendation.

## AUDIT TOOL FEATURES (build on the pipeline)

- [P1] **Check 5: runaway detection** — per-agent burstiness (median inter-call gap + peak calls/min) vs peer baseline; flag `spend-runaway`. Data already generated. Closes "dashboard says top-spender, audit says incident."
- [P2] SKETCH — needs a method spec before building: **Hold-utilization KPI** — per agent settled/held ratio. Actionable (tune max_tokens). SQL over chains.
- [P2] SKETCH — needs a method spec before building: **Burn-rate forecast** — spend velocity → time-to-cap projection.
- [P3] SKETCH — needs a method spec before building: **Continuous reconciliation monitor** — check 2 over the balance-snapshot series, not point-in-time.
- [P3] SKETCH — needs a method spec before building: **DQ contracts on event stream** — ingest asserts → standing DQX-style contracts.

## DATA & INFRA
- [P1] SKETCH — needs a method spec before building: Second `generate_spend.js` run (~$0.24) — produces a multi-day time series ONLY if run on a different real calendar day than the first run (no backdating param exists); rerunning it same-day just adds more single-day volume, not a time series.
- [P3] SKETCH — needs a method spec before building: Incremental ingest (cursor on createdAt) — answers "at 50M txns?" → see BUILD 0 for the schema extension that must precede this.
- [P3] SKETCH — needs a method spec before building: Streamlit dashboard — checks + KPIs live view.
- [P3] SKETCH — needs a method spec before building: `/v1/workflows/definitions` — unexplored endpoint, dissect.

## CEO-GRADE FINDINGS (Zerbib = ex-Shopify payments; thinks take-rate / margin / float / moat)

### [P1] ⭐ Take rate / margin — Sapiom price vs raw provider price
Compare what Sapiom charges vs the underlying provider's public price:
- OpenRouter `gpt-4o-mini`: public price ~$0.15/1M input, $0.60/1M output. Our settled call = $0.0001. Compute implied tokens, compare to public rate → is Sapiom marking up, at-cost, or subsidizing?
- Linkup search: public price ~$5/1000 searches ($0.005) vs Sapiom's $0.006 → ~20% markup? Verify.
Method: for each service, back out Sapiom's effective unit price from settled costs, diff vs the provider's published rate. Table: service | provider list price | Sapiom price | markup %.
Payoff: "You take ~X% on LLM, ~Y% on search, 0% on Z — intentional?" Outsider quantifying his own margin/revenue model = irresistible to a payments CEO. Prereq: pull public provider prices (WebSearch). ~$0.02 to confirm live prices.

### [P2] ⭐⭐ Float as a balance-sheet asset (this CEO specifically)
NO new build — re-lens the existing 40× hold finding in payments-CEO terms Zerbib invented at Shopify. Holds = parked capital = float. At scale, aggregate in-flight holds across all customers = working capital Sapiom controls. Stripe/Shopify monetize float.
Framing: "Your hold mechanism generates float — right now ~40× realized spend under concurrency. Is that a balance-sheet asset you intend to play, or a customer capital-efficiency cost you're eating? Either way it's currently implicit." 
Deliverable: one slide/paragraph + the concurrency chart from extrapolation_result.json. Highest CEO-resonance item in the doc.

### [P3] Cheaper-than-direct? (the moat / churn question)
Same data as take-rate. Would a customer save money bypassing Sapiom and calling the provider directly? Cheaper via Sapiom (bulk/negotiated) → moat. Pricier → churn risk a CFO spots immediately. Answers the CEO's core anxiety: "why use us vs direct?" Frame honestly per service — some cheaper, some premium-for-governance. Free once #1 done.

## LESSONS FROM THE REPO THAT GOT SOMEONE HIRED (sapiom/Showcase — "Realism" by Yash Nadge)

Realism = goal-execution app: type a goal → LLM classifies → creates a Sapiom spending rule → runs agentic job → streams live cost → outputs a bespoke deployed mini-app. 90 files, Next.js, live on Vercel, Loom in README. Soundbite: "$30, 2 days, one person." Wow mechanic: ONE pipeline → 3 visually unrelated apps (finance terminal / music magazine / utility tool) via a design-personality classifier. Got hired on product-taste + making Sapiom's spend primitive first-class UI (live SpendMeter, itemized Receipt).

**What Realism SKIPPED = our whitespace (own it explicitly):**
- No x402 hold/settle/void lifecycle — every call is synchronous post-then-record. NO reconciliation of authorized-vs-captured. ← our entire finding.
- No historical spend analysis — only instantaneous running total + flat receipt. No trend/anomaly/forecast/audit.
- One-dimensional governance — single flat cap per job. No tiered rules, no per-service breakdown viz.
- No tests, squashed git history (single commit).

**Lessons to apply:**
1. Lead with a quotable one-liner + hard number. Ours: "$0.27, one evening — found your x402 holds freeze 40× actual spend." Match "$30, 2 days."
2. **Make the primitive VISIBLE, don't bury in a report.** They made spend a UI component. We must make hold→settle→release + the audit findings VISUAL (timeline/ledger view), not markdown. ← biggest gap to close for CEO-cool.
3. 2-3 contrasting demo scenarios, not one happy path. Show catching: stuck hold, double-live-charge, budget breach, runaway. Distinct failure modes = memorable.
4. Live URL + Loom + a "Sapiom services used" table (checkable proof of real integration).
5. Differentiate on the seam they skipped: settlement lifecycle + historical analysis + proactive flags (before budget blown, not after).
6. Cheap edge: even a thin test suite + real (non-squashed) git history beats their repo.

### [P1] ⭐ WOW UPGRADE — visual hold-lifecycle view (makes it CEO-cool)
Turn the finding from report → seen. Single static HTML page (NO Next.js — ponytail): reads the balance-poller + transaction data, renders money moving held → settled/released in real time; the 40× float divergence animates as concurrent agents fire; runaway agent flags red. This is Realism's lesson #2 applied to our differentiated content. Lazy build: one HTML + a bit of JS charting off existing extrapolation_result.json / live poll (~2-3hr). Skipped: framework, backend, auth — it's a viewer, add none.

## CEO DASHBOARD — closed-loop build spec (agent can build HTML from existing data)

Goal: single static `dashboard.html` (ponytail — NO framework, NO backend; inline JS reads local JSON the pipeline already produced + a small exported DuckDB dump). For CEO Zerbib: shows correctness + economics + risk, NOT activity (his own dashboard already has txns/spend/denials KPIs, time-series, top agents/services — DO NOT duplicate those).

### Data artifacts already on disk (every panel traces to one — closed loop)
- `spend.duckdb` — tables `transactions` (50 rows: agent_name, service_name, outcome, status, created_at, authorized_at, completed_at), `costs` (fiat_amount, is_active, superseded_at, supersedes_cost_id, transaction_id), `balance_snapshots`. Builder: export needed aggregates to `dashboard_data.json` via a small `export_dashboard.py` (duckdb → json), so the HTML has no DB dependency.
- `dryrun/cap_experiment_result.json` — max_tokens 100/400/900 → holds 0.000243/0.000543, final flat $0.0001.
- `dryrun/extrapolation_result.json` — Exp A caps 2000/8000/16000 → holds 0.001203/0.004803/0.009603 (hold = $0.0006/1k, linear). Exp B: 10 concurrent calls, balance_series showing dip $4.767518→$4.763074 (holds froze 4.4× settled) then recover.
- `report.md` — 4 audit checks: reconcile diff $0.000000; naive-sum overstates +2.35%; revision −38.2%; chain integrity 0/0/0.

### Panels → data source → compute → render (the closed loop)

**HERO ROW**
1. **Float meter (held vs settled)** ⭐ — SOURCE: extrapolation_result.json Exp B. COMPUTE: peak held = 10×0.000543≈$0.0054 vs settled $0.001 → 4.4×; label the dip/recover from balance_series. RENDER: gauge or two-bar (held tall, settled short) + "4.4× capital frozen under 10-way concurrency." Build-story tie: this IS the concurrency experiment, visualized.
2. **Take-rate / margin strip** — SOURCE: costs table (Sapiom price per service) + public provider prices (WebSearch: OpenRouter gpt-4o-mini $0.15/$0.60 per 1M; Linkup ~$0.005/search). COMPUTE: markup % = (sapiom−provider)/provider per service. RENDER: table service | list | Sapiom | markup%. (See CEO-GRADE FINDING #1.)
3. **Capital-efficiency ratio** — SOURCE: costs table. COMPUTE: Σ live settled ÷ Σ initial holds across all chains = settled/held headline %. RENDER: one big number.

**TRUST & CORRECTNESS ROW**
4. **Reconciliation health** — SOURCE: report.md check 2 + check 1. RENDER: green ✅ "$0.000000 — ties out" + "naive sum overstates +2.35%" subtitle. Tie: audit.py output.
5. **Runaway caught** — SOURCE: transactions table, agent spend-runaway (25 calls @0.3s). COMPUTE: per-agent median inter-call gap + peak calls/min (BACKLOG check-5). RENDER: agent list, runaway row red-flagged, "caught before top-spender ranking would."
6. **Trust-failure risk** — SOURCE: report.md check 4 (chain integrity 0/0/0) + concept. RENDER: counters orphan holds / double-live rows = "$ at risk from mis-summing," currently clean.

**ECONOMICS ROW**
7. **GMV by service** — SOURCE: costs+transactions, Σ live by service_name. RENDER: bar, concentration.
8. **Cost per successful outcome** — SOURCE: Σ live ÷ count(outcome='success') per service. RENDER: table vs nominal price.
9. **Reliability strip** — SOURCE: transactions lifecycle ts. COMPUTE: success rate + p95 (authorized→completed) per service. RENDER: SLA row.

**FLOAT-AT-SCALE CALLOUT**
10. **Extrapolation tile** — SOURCE: Exp B 4.4× × linear-hold model. COMPUTE: project "at 100 concurrent agents, cap 16k → ~$Xk frozen." RENDER: callout. Zerbib's ex-Shopify float lens.

### The demo cut (build these 5, not 10): panels 1, 3, 4, 5, 2
Float meter · efficiency ratio · reconciliation-green · runaway-red · margin. Five tiles = whole story: "audited your money's correctness AND unit economics, from outside, in a weekend."

### Build approach (ponytail)
`export_dashboard.py` (duckdb → dashboard_data.json, ~40 ln) + `dashboard.html` (inline CSS + vanilla JS, read dashboard_data.json + the two experiment JSONs, render tiles; charts = inline SVG or a single vendored chart lib as one <script>, no npm). Skipped: framework, backend, live-refresh — it's a viewer over frozen experiment data. Add live-poll only if demoing live. One test: assert export produces non-empty numbers matching report.md (reconcile diff==0, markup computed).

### Closed-loop narrative (build story ↔ panel story)
Each panel is a filmed experiment result, not a mockup: dry-run proved chains exist → cap_experiment proved holds price on max_tokens → extrapolation proved linear + float-real → generate_spend produced the fleet + runaway → ingest/audit proved reconciliation. Dashboard = those five experiments made visible. That's the demo script AND the README arc AND the Loom order.

## TWO-AUDIENCE FRAMING (one project, two pitches — don't build twice)

Same artifact (spend-intel + x402 hold finding), same Loom, two 30-sec intros:
- **Jordi (Founding Eng, invented L402→x402)**: protocol teardown. "Your x402 pre-auth holds price on max_tokens not usage — linear to 16k, freeze ~40× actual spend under concurrency. Hold amount vs settlement amount diverge; rules may evaluate on the inflated hold. Intended pre-auth padding or worth tightening?" Native language: pre-auth vs settlement, macaroon holds, 402 semantics. Invite him to reason together (podcast host). See memory sapiom-people.
- **Zerbib (CEO, ex-Shopify payments)**: business skin, SAME finding. "Customers freeze ~40× the capital they spend; your budget rules may block agents at 1% of real limit. Found in a weekend on $0.27. Gift + question, never gotcha." Drama + one number + vision ("dashboard shows what happened; moat is what's about to go wrong").
- CEO hero-demo (if live): fire concurrent agents → balance drops by holds in real time → guardrail catches runaway before their dashboard flags it. Visceral proof of Sapiom's reason-to-exist, built on their platform.

## [P3 — 2nd-last priority, capstone at the very end] "DATA 1.0" PITCH — the future of Sapiom's data platform
The DE-charter capstone: a maturity story grounded in REAL data Jay generated. One artifact (doc/deck) that says "I see your entire data future." Do at the END, after MVP ships + DQX prep + the interesting experiments. Second-last (only the service-sweep prereq and final delivery come around it).

Maturity narrative (3 stages):
- **Data 0 (their now)**: transactional Postgres, dashboard reads live state, no history, metrics on-the-fly. Reactive, current-state-only.
- **Data 1.0 (the pitch)**: analytical foundation — BQ lakehouse + dbt medallion, ledger modeled (append-only + derive-current, NOT MERGE — scale-correct), DQ contracts, canonical semantic layer (one definition of spend), cost-per-task lineage, reconciliation as standing service. The system-of-record.
- **Data 2.0 (horizon)**: intelligent — anomaly, forecast, auto-cap optimization, ML on traces, data-as-a-product (customer analytics, benchmarks).

What it needs (only #1 is new work; rest assembles from what we have):
1. **PREREQ — 9-service data-generation sweep (~$1-2):** touched only 2 of 9 services. Fire ONE call each to capture every data SHAPE for a real inventory: Linkup/You.com (search results+sources), OpenRouter (text), Fal.ai (IMAGE binary MBs), ElevenLabs (AUDIO binary), Blaxel (compute stdout/stderr+artifacts), Anchor Browser (scraped HTML/DOM), data/Postgres (structured rows), SMS Verify (OTP/status events), QStash (scheduling/webhook events). Read skill refs for each service's request shape first. Also independently feeds per-service hold mechanics, take-rate, benchmarking.
2. **Data catalog artifact** — table: data type | source | structure | example | volume-at-scale | what it unlocks. Built from #1's real samples. Spine of the pitch.
3. **Reference architecture** — the BQ+dbt layered design (Cloud SQL hot path → Datastream CDC → Pub/Sub+Dataflow → BigQuery lakehouse → dbt medallion staging→marts → BQ materialized views/BI Engine serving; payloads→GCS pointers). Append-derive at scale (MERGE doesn't scale in BQ). See scale-thesis.
4. **Experiments become the evidence** — float, reconciliation, hold mechanics, cost-per-task = "here's what's already extractable from a trickle; imagine it modeled at petabyte scale."
5. **Package** — deck: inventory (what) → architecture (how) → roadmap 0→1.0→2.0 (vision) → findings (proof). One artifact = "I see your entire data future."
Appeal: THE DE-charter proof; pairs with the petabyte scale-thesis; maps to Jay's CH stack (medallion, SCD2/append-derive claims ledger, DQX, reconciliation at scale).

## INTERVIEW QUESTION BANK

> **⚠️ Number correction (2026-07-04) — read before any interview prep.** The dashboard's earlier "$1M/day TPV → $4.57M customer capital frozen daily" scale-hook was WRONG and has been corrected everywhere (dashboard, `findings.md`, `NARRATIVE.md`). It was a per-day *flow* quantity (a pure capture-ratio effect with no time dimension) mislabeled as an instantaneous frozen *stock* — it implicitly assumes a ~4.57-DAY average hold lifetime, when the measured reality is 5.3–12.0 SECONDS (~33,000x shorter). The defensible figure via Little's Law (L = λW): **≈$61–$138 instantaneously frozen at $1M/day TPV**, holds clearing in ~5.3–12.0s; the two levers that actually shrink it are hold-lifetime (settle faster) and hold-size (`max_tokens` right-sizing, ~79% reduction achievable per `advisor.md`). Full derivation + sensitivity table: `dryrun/float_model.md`. **Do NOT re-cite the $4.57M number from any stale notes, emails, or earlier prep.**

### For Jordi (Founding Engineer, protocol)
1. [ANSWERED — rules fire on the HOLD, not settlement; a $0.001 `usage_limit` rule denied a call whose real settlement was ~$0.0001 because the hold was $0.002403 (`violations[].currentValue` matched the hold exactly). Present as finding, then ask:] Is holding-based enforcement intended, given `max_tokens` can inflate the hold ~40× actual spend? (Original question: "Do spending rules evaluate on the hold amount or the settlement amount?") — earned by: 5.5× hold overhang measured; confirmed empirically 2026-07-04 — see `dryrun/hold_vs_settlement_experiment.md`.
14. [REPRODUCED, scales with concurrency — reframed from open question to a finding-plus-question, 2026-07-04] "I reproduced the TOCTOU check-then-act race deliberately: a hold-based usage_limit rule sized to permit exactly 1 call leaked 2 of 20 concurrent calls (`max_tokens=8000`) and 3 of 50 (`max_tokens=4000`) — while a fast, small-hold batch (N=10, `max_tokens=500`) leaked 0, exactly as designed. Both confirmed by the rule engine's own decisions AND client HTTP status. The leak tracks the spread of `completedAt` across the batch — more concurrent calls (and, to a lesser extent, larger holds) widen the window where checks race against a stale cumulative ledger. Is the authorization check meant to be atomic per-wallet/per-rule, and is there a design reason it isn't serialized under concurrency?" — earned by: `dryrun/hold_vs_settlement_experiment.md` TOCTOU variant (RL-006, the original 3-call anecdote) + `dryrun/toctou_latency_experiment.md` (the FAST/SLOW-A/SLOW-B reproduction, `findings.md` §8).
15. "`measurementScope` defaults to `\"all\"`, which sums spend TENANT-WIDE rather than per-scoped-agent — a rule meant to cap one agent (`agentIds:[...]`) can silently sum the whole tenant's historical spend unless `measurementScope:\"rule\"` (undocumented, found only by probing the parameter schema) is set explicitly. Is tenant-wide-by-default intended, or a misconfiguration footgun worth surfacing at rule-creation time?" — earned by: `dryrun/hold_vs_settlement_experiment.md` Rule 1 (RL-004) false start.
16. "Two failure-lifecycle findings, combined, produce a worst case: (a) holds are priced off the *requested* `max_tokens`, confirmed linear to 64k tokens, even when that's 4x past `gpt-4o-mini`'s real ~16k completion ceiling — the model silently accepts and gets held against a number it can never produce; (b) when a call then fails mid-flight (our 128k rung hit a 502 gateway error), the FULL hold is captured as the final settled cost, not refunded or superseded — confirmed by an exact balance drop. So the worst case is: a caller over-requests `max_tokens`, the call fails for a transient/unrelated reason, and they're billed the maximum possible amount for zero output. For Jordi: is capture-on-failure the intended semantics of the x402 `\"upto\"` scheme, or should a gateway-level failure (as opposed to a clean model rejection) release the hold? For Zerbib: is 'recoverable' meant to cover this case — a hold that survives a mid-execution death — or only clean-reject paths?" — earned by: `dryrun/hold_linearity_extension.md` (128k rung), `findings.md` §9/§10, BACKLOG R1 (now answered).
2. "Traces are flat grouping IDs — is span hierarchy / parentSpanId in x402 metadata on the roadmap? How should cost attribution work for agent DAGs?" — earned by: BUILD 4 trace-mining + the DAG-inference limitation (BUILD 13).
3. "Tiny calls skip the hold/settle chain entirely (single cost row), and OpenRouter shows a $0.0001 minimum-billing floor — is the floor protocol-level or per-service?" — earned by: min-charge-floor lead + take_rate.md OpenRouter +2930% artifact.
4. "Hold pricing is linear on max_tokens — intended pre-auth padding, or worth model-aware estimates? Right-sizing caps cuts hold size ~79% in our fleet." — earned by: advisor.md.
5. "Under 10-way concurrency, holds stacked to 4.4× settled spend. At fleet scale, does wallet sizing become the customer's working-capital planning problem?" — earned by: extrapolation experiment.
12. "Governance rules + agents are creatable over plain REST (POST /v1/spending-rules, POST /v1/agents) — but your docs only expose governance via MCP, and the SDK has zero rules code. Is the REST governance surface intentionally undocumented / not-yet-GA, or an oversight? Also: rules have no hard-delete, only pause via PUT with optimistic-concurrency version — is governance state intentionally append-only?" — earned by: dryrun/governance_api_probe.md (OPTIONS advertised POST/PUT/PATCH/DELETE; POST returned 201; DELETE/PATCH 404; SDK @sapiom/core + @sapiom/fetch have no governance code; docs.sapiom.ai documents governance only via MCP at api.sapiom.ai/v1/mcp).
13. "A failed call today creates a full transaction row with outcome='error' but ZERO cost rows — the hold is never placed because execution fails AFTER authorization but before pricing (auth ≠ execution, verified in our sample). But what happens when a vendor dies MID-execution, after the hold is placed? Does the ledger emit an orphan live-hold that must be reaped, or a supersession/refund chain that releases it? We have zero such records in 81 txns, so I couldn't observe it — how does hold-release-on-failure actually work?" — earned by: failure-record shape analysis (outcome='error' + costs:[] + currentPaymentTransactionId:null + authorizationRequests[].status='authorized'; raw JSON in the failed-record investigation). **Maps to Zerbib's "failures must be bounded, visible, RECOVERABLE"** — this is the recoverable edge, unobserved in our data. See also BUILD 3.3 (deliberate post-hold-failure test).

### For Ilan Zerbib (CEO)
6. "What's the GPV-equivalent north star — agent spend through your rails? How do you think about penetration vs agents calling vendor APIs directly?" — earned by: fluency (his Shopify world: GPV 67% of GMV).
7. "Every developer's first experiment costs real money — no test mode, staging is invite-only. Is a sandbox on the roadmap?" — earned by: test-mode probe verdict; adoption-funnel-leak framing; x402-emulator backlog idea.
8. "You coined KYA — what does the scorecard concretely look like? Here's my attempt from your own ledger." — earned by: KYA scorecard (BUILD 12 dashboard Section 2).
9. "Measured take rates run 0% (Linkup) to +233% (ElevenLabs), blended 789bps — is long-term margin pass-through-plus-floor or real markup?" — earned by: take_rate.md 9-service table. CAUTION: frame as margin-observability, not gotcha.
10. "At agent-scale TPV this ledger is petabytes/day with supersession restatements. Append-only + derive-current, not MERGE — who owns the analytics stack today?" — earned by: scale thesis; their stack = BigQuery + dbt.

### For the data team
11. "How do supersession chains land in the warehouse today — SCD2-style or overwrite? A naive sum overstates spend +10% — I measured it." — earned by: reconciliation finding (phantom spend rate).

## SHOWCASE & DELIVERY
- [P1] Git push (personal GitHub), topics, pin.
- [P1] Loom 2-min: dashboard → runaway → `audit.py` live → penny-exact + max_tokens finding.
- [P1] Email Jeff + David (Tue night) — lead with max_tokens finding as a question.
- [P2] PR into sapiom/Showcase (post-interview if signals good).
- [P3] Host dashboard on Sapiom compute ("built on Sapiom, hosted on Sapiom").
- [P3] Blog/LinkedIn — the audit methodology as public artifact.

---

## Interview honesty rules (carry into every finding)
- State sample size + conditions. "n=11, one model, one evening" not "the platform does X."
- Mechanism (confirmed) vs magnitude (workload-shaped) — keep separate.
- Any suspected bug (race, orphan hold) → frame as "I tested for X; here's what I saw; worth confirming at scale," and report privately/politely, never as a gotcha.
