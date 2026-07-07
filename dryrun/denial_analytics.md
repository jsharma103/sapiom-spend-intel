# Denial Analytics — governance decisions dissected

Generated 2026-07-07T03:40:02.462Z — free, GET-only over /v1/transactions (292 txns, 578 authorization requests).

## Headline

- **85 denials / 578 authorization requests (14.7%)** — every denial traces to a deliberately-created test rule; zero organic denials (no production rules exist).
- **Denial decision latency: median 141ms** (min 103ms, max 399ms) vs authorized median 118ms — denying is 1.2x the authorized decision time.
- **Cost of denied work: $0.221047** in live holds still attached to denied transactions (denied-at-auth holds release on a slow backend sweep — see hold_vs_settlement_experiment.md Cleanup).

## Denials by rule

| Rule | Denials | Agents hit | currentValue seen |
|---|---|---|---|
| System: Payment Authorization | 84 | r5-boundary-agent, doublecount-slow, doublecount-fast, blast-test-8000, blast-test-2000, blast-test-500, race-lat-agent-slowB50, race-lat-agent-slowA20, race-scale-agent-n10, holdtest-agent-hvs |  |
| r5-boundary-rule | 1 | r5-boundary-agent |  |
| doublecount-slow-rule | 1 | doublecount-slow |  |
| doublecount-fast-rule | 1 | doublecount-fast |  |
| blast-test-8000-rule | 1 | blast-test-8000 |  |
| blast-test-2000-rule | 1 | blast-test-2000 |  |
| blast-test-500-rule | 1 | blast-test-500 |  |
| race-lat-rule-slowB50 | 47 | race-lat-agent-slowB50 |  |
| race-lat-rule-slowA20 | 18 | race-lat-agent-slowA20 |  |
| race-scale-rule-n10 | 9 | race-scale-agent-n10 |  |
| holdtest-rule-hvs-2 | 4 | holdtest-agent-hvs |  |
| holdtest-rule-hvs-toctou | 3 | holdtest-agent-hvs |  |
| holdtest-rule-hvs | 1 | holdtest-agent-hvs |  |

## Denial rate by agent

| Agent | Auth requests | Denied | Rate |
|---|---|---|---|
| race-lat-agent-slowB50 | 102 | 47 | 46.1% |
| race-lat-agent-slowA20 | 42 | 18 | 42.9% |
| race-scale-agent-n10 | 22 | 9 | 40.9% |
| holdtest-agent-hvs | 11 | 5 | 45.5% |
| r5-boundary-agent | 28 | 1 | 3.6% |
| doublecount-slow | 20 | 1 | 5.0% |
| doublecount-fast | 20 | 1 | 5.0% |
| blast-test-8000 | 2 | 1 | 50.0% |
| blast-test-2000 | 10 | 1 | 10.0% |
| blast-test-500 | 20 | 1 | 5.0% |

## Notes

- Decision latency = authorizationRequests.createdAt -> deniedAt/authorizedAt, per the ledger's own timestamps.
- "Cost of denied work" counts live (isActive) cost rows on denied transactions — money frozen for calls that never ran.
- All denials here come from experiment rules (hold-vs-settlement, TOCTOU, R5 boundary); rates describe those experiments, not organic traffic.
