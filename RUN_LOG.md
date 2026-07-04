# Overnight Run Log

Cumulative spend: $0.00369 / $2.00 cap
Wallet start: ~$4.75 (confirmed $4.750418 pre-run via /v1/accounts)

| time | item | status | cost | cumulative | output | notes |
|---|---|---|---|---|---|---|
| 2026-07-04 03:48:40 -0700 | Item 1: fix + re-run service_sweep (images, compute) | done | $0.003690 | $0.003690 | dryrun/service_sweep_result.json | TONIGHT's spend = $0.003690 only (images+compute). Fal images path was `${host}/v1/run/fal-ai/flux/schnell` (404) — probed unauthenticated (404=no route, 402=route exists=needs payment) and found correct path drops the `/v1/` prefix: `https://fal.services.sapiom.ai/run/fal-ai/flux/schnell` → 200 ($0.003). Blaxel compute host `compute.services.sapiom.ai` doesn't resolve in DNS at all (confirmed via dig/curl, not just a wrong path) — correct host is `blaxel.services.sapiom.ai` + singular path `/v1/run` (not `/v1/runs`) → 200 ($0.00069). Added `--only=svc1,svc2` flag to service_sweep.js so re-fires merge into the existing 9-service result file instead of re-spending on the 7 services that already worked from the PRIOR (pre-overnight) run: search $0.006, llm $0.0001, audio $0.001, scraping $0.009 — those are historical/already-spent, not tonight's cost. data=$0 (documented free endpoint), messaging+verify SKIPPED by design (side-effecting, real SMS/webhook). Balance $4.750418 → $4.746728 (tonight only). |
