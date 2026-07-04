# Sapiom Reliability / SLA Report

Success rate + latency (authorized -> completed) + error taxonomy per service. Zero spend, `spend.duckdb` only.

## Per-service SLA

| Service | N | Success | Error | Other | Success rate | p50 latency | p95 latency |
|---|---|---|---|---|---|---|---|
| sapiom_linkup | 43 | 43 | 0 | 0 | 100.0% | 6.25s | 9.17s |
| sapiom_openrouter | 31 | 31 | 0 | 0 | 100.0% | 5.91s | 11.97s |
| sapiom_fal | 2 | 1 | 1 | 0 | 50.0% | 1.18s | 2.69s |
| unknown | 2 | 1 | 1 | 0 | 50.0% | 1.06s | 1.49s |
| sapiom_blaxel | 1 | 1 | 0 | 0 | 100.0% | 1.35s | 1.35s |
| sapiom_elevenlabs | 1 | 1 | 0 | 0 | 100.0% | 2.75s | 2.75s |
| sapiom_neon | 1 | 1 | 0 | 0 | 100.0% | 1.30s | 1.30s |

## Error taxonomy

**2 error transaction(s) found.** NOTE: the ledger itself has no error-reason/message field (checked: no `error`/`reason`/`failureMessage` key on any outcome='error' transaction — only the `outcome` flag). Root causes below for tonight's 2 errors are manually cross-referenced from independent debugging context (RUN_LOG item 1), not derived from the ledger. Anything beyond these 2 known cases would show as "unknown" until a real error-detail field exists — itself worth flagging as a ledger gap for incident triage.

| Transaction ID | Service | Status | Completed At | Known root cause |
|---|---|---|---|---|
| 7333a425-6a4f-476d-9610-955c642b9c87 | sapiom_fal | completed | 2026-07-04 10:23:37.379000 | Pre-fix Fal.ai image endpoint had a wrong URL path (images.md documents /v1/run/... but the live gateway needs the path without /v1/) -> HTTP 404 before any real image generation happened. Fixed same night (RUN_LOG item 1). |
| eb918dba-a2b5-46b0-96e1-5aff42e92b76 | unknown | completed | 2026-07-04 10:23:45.875000 | Pre-fix Blaxel compute host (compute.services.sapiom.ai) does not resolve in DNS at all -> client-side fetch failure before the request ever reached a real gateway. serviceName shows as 'unknown' because the transaction record itself has no service name resolved. Fixed same night (RUN_LOG item 1, corrected host to blaxel.services.sapiom.ai). |

