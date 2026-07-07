# OVERNIGHT RUN — handoff for autonomous Sonnet agent

Running UNATTENDED overnight. Real API key, real money. Follow these rules exactly.

## Read first (in order)
BACKLOG.md top blocks: HOW TO USE · OPERATIONS & EDGE CASES · PREREQUISITES · SDK CAPABILITIES · EXECUTION ORDER · TOP BUILD PRIORITIES. Then PLAN.md for verified API facts.

## Money rules (HARD — real wallet)
- Key is in `.env`. **⚠️ In this harness EACH shell call is a FRESH shell — env does NOT persist between separate commands.** `source .env` in one call has no effect on the next. EVERY key-needing command must inline the load in the SAME command: `set -a && source .env && set +a && <command>` (for node: `node --env-file=.env script.js`, or inline the same `set -a && source .env && set +a &&` prefix). This applies to service_sweep, ingest.py, chaining, and any spend script — no exceptions.
- SPEND CAP TONIGHT = **$2.00**. Wallet started ~$4.75. Before EVERY spend script: `GET https://api.sapiom.ai/v1/accounts` (Bearer + header `User-Agent: curl/8.6.0`), read `availableBalance`. STOP ALL SPENDING if `availableBalance` < **$2.75** (=$2 spent) OR < $0.50 (absolute floor) — whichever first.
- Every spend script MUST have its own per-run cost guard + abort threshold (copy pattern from `dryrun/extrapolation_experiment.js`). NO unbounded loops. NO retry-on-error that re-fires paid calls.
- Skip ALL `[HUMAN-UI]` items (dashboard rule creation, settings checks) — no browser.

## Scope tonight (interview-critical first, in order)
1. Fix `dryrun/service_sweep.js` endpoints: Fal image path (was 404 — get correct path from `.agents/skills/use-sapiom/references/images.md`) + Blaxel compute host (`compute.` → `blaxel.services.sapiom.ai`); confirm the FULL Blaxel path from compute.md (not just host compute.→blaxel.). Re-run ONLY those 2 (~$0.03). Complete the data-shape inventory in `service_sweep_result.json`.
2. BUILD 0 — extend `ingest.py` schema (add `trace_external_id`, payment sub-object, `fact_phase`, `outcome`). Free. Re-ingest real data. PROBE FIRST: GET one real transaction and inspect its JSON (also try `?include=`) to confirm which of {payment sub-object, factPhase, costDetails, trace.externalId, outcome} actually appear — add columns ONLY for fields present; log absent ones in RUN_LOG. (See verification results appended to BACKLOG BUILD 0 by this task.)
3. BUILD 2 — `findings.py` bundle (settlement latency, x402 tax, cost-per-task, estimate-accuracy, runaway check-5) → `findings.md`. Free. NOTE: cost-per-task section is EMPTY until BUILD 3 (chaining) generates txns sharing a trace_external_id — re-run findings after BUILD 3.
4. BUILD 1 — CEO dashboard (`export_dashboard.py` + `dashboard.html`, 5 tiles). Free. Verify it renders offline, numbers match report.md.
5. If budget + time remain: BUILD 3 chaining experiment (~$0.02, set `traceExternalId`), then BUILD 4 trace-mining, BUILD 5 advisor+reliability.
- Do NOT: rule experiments (need dashboard `[HUMAN-UI]`), git push, Loom, email.

## Logging + safety
- Append to `RUN_LOG.md` after EACH item: timestamp (use `date`), item, status (done/failed/skipped), cost this item, cumulative spend, output file, notes. This is the human's morning report.
- On any error: log it, SKIP that item, continue to next. Do NOT halt the whole run. Do NOT retry-loop paid calls.
- After each successful build: `git add -A && git commit -m "overnight: <what>"`. Do NOT push (no auth).
- Keep a running cumulative-spend total at the top of RUN_LOG.md; update after every spend.

## Stop when: $2 spent (balance < $2.75) · OR all scoped items done · OR 3 consecutive errors (something's wrong — stop, log, leave for human).

## Morning deliverables: findings.md · dashboard.html · updated report.md · service_sweep_result.json (full 9) · RUN_LOG.md · local git commits for review.
