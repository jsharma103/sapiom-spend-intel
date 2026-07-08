# Loom Script — Sapiom Spend Dashboard (~2:50)

**[0:00–0:30 — intro | face cam or dashboard top]**
"Hey, I'm Jay — I'm interviewing for the Data Engineer role at Sapiom. Over the weekend I tried what Sapiom had to offer — pretty cool, honestly. And the more I used it, the more I wondered: can I monitor my own usage? What would be the KPIs worth tracking — for an external customer like me, and for internal stakeholders? So I came up with a set of hypotheses, ran experiments against them, and built this."

**[0:30–1:00 — hypotheses + APIs | slow scroll or terminal]**
"The hypotheses: does the ledger reconcile exactly? How do payment holds behave, and how much capital do they tie up? Do spending rules actually bound an agent? Is every dollar attributable? And when calls fail — does the money come back? To test them, I drove real spend through the @sapiom/fetch SDK across all nine service families — LLMs, search, images, audio, compute, scraping, data — and ingested everything from the backend APIs: /v1/transactions for the ledger, /v1/accounts for balances, /v1/spending-rules for governance. Three hundred seventy-five real transactions into DuckDB — and every number here traces to a file."

**[1:00–1:30 — hero row | hero tiles]**
"Top row, the money story. Fifty-seven cents settled. Fifty-three cents **frozen** — held but never released. Not charged, not returned — zero came back in three days. And the trust check: my ledger predicts Sapiom's own account balance to the micro-dollar — settled plus frozen plus available equals five dollars, exactly. Books tie out — so the rest of this, you can believe."

**[1:30–2:05 — sharp findings | capture rate → concurrency leak]**
"Two findings worth pausing on. Capture rate: authorize a dollar, only eighteen cents settles — holds run five-point-six times oversized. And only the LLM service does this — I surveyed the other five services, they all price flat. Then concurrency: fire calls in parallel, and a spending cap sized for exactly one call let three through — the checks race a stale ledger."

**[2:05–2:30 — Section 2 | scroll in, land on KYA]**
"Section one was industry-standard payments KPIs. Section two — in his ComputerWeekly interview, Ilan said the goal isn't zero failure, it's making failures **bounded, visible and recoverable**. So I turned his three words into three groups of measurable KPIs. Bounded: you set a cap, agents really get zero to eighty percent of it. Visible: a quarter of calls, the ledger can't fully explain. Recoverable: failed holds never come back — refunds don't even exist yet. And the Know-Your-Agent scorecard caught the *real* runaway agent — not the one named runaway."

**[2:30–2:45 — close | back to top]**
"Five-dollar wallet, one weekend, reconciles to the penny. Repo and methodology linked below — looking forward to talking about it."

---

## Cue card (one line per shot)

1. Jay · DE role · tried Sapiom · "can I monitor my own usage?" → hypotheses → built this
2. 5 hypotheses → SDK across 9 services → /v1/transactions · /v1/accounts · /v1/spending-rules → 375 txns → DuckDB
3. $0.57 settled · $0.53 frozen, 0 released · predicts balance to micro-dollar, = $5.00 exactly
4. $1 → $0.18 · 5.6× holds · LLM-only (5 others flat) · cap for 1 let 3 through
5. Ilan: bounded/visible/recoverable → 0–80% of cap · 25% unexplained · refunds don't exist · KYA caught real runaway
6. $5, one weekend, penny-exact · link below

## Recording notes

- Hero row + close from memory; cue cards for blocks 2 and 4 (they carry the numbers).
- Speak the bolded words slower: frozen · bounded, visible and recoverable.
- Record blocks separately if trimming is available; target ≤3:00 total.
