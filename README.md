# Sapiom Ledger Audit

▶ **[Live dashboard](https://jsharma103.github.io/sapiom-spend-intel/dashboard.html)** · [2-min demo](LOOM_LINK_TBD)

- **TPV:** $0.277472 across 81 transactions / 16 agents — one evening, live Sapiom API, real money.
- **Capture ratio:** 18% — authorize $1.00 → capture $0.18.
- **Reconciliation:** $0.000000 diff — ties out to the penny.

I put a fleet of agents on Sapiom and audited it like a payments ledger. It reconciles penny-exact
— $0.000000 diff on real spend — but the **capture ratio is 18%: you freeze $5 to settle $1**. At
agent-scale transaction volume that's real customer capital sitting frozen, not spent, and the
ledger that has to track it honestly runs at petabytes a day. That's the data platform I build.

*(Full story + delivery notes: [`NARRATIVE.md`](./NARRATIVE.md). Full numbers: [`report.md`](./report.md) / [`findings.md`](./findings.md).)*

---

## Method / Full findings

A reconciliation audit over Sapiom's agent-spend ledger — built on the live API, with real agents spending real money.

## Why

Agents are starting to spend money on their own — calling search APIs, calling LLMs, racking up a bill nobody watched in real time. The moment spend is autonomous, the money math has to be *provably* correct, not just "probably fine." You can't eyeball a ledger an agent is writing to 24/7.

Building this against Sapiom's real API surfaced something worth knowing: Sapiom restates transaction costs. An OpenRouter call doesn't post one final number — it posts an initial cost row, then supersedes it with a revised final, the same way a gas-station hold authorizes for $100 and settles for whatever you actually pumped. Naively summing every cost row in the ledger silently double-counts every one of these chains.

I spent three years building exactly this class of restatement-safe reconciliation for healthcare claims — claims get adjudicated, re-adjudicated, and re-priced constantly, and the balance still has to tie out to the penny. This project applies that same discipline to agent spend: the ledger has to reconcile, chains have to resolve cleanly, and every dollar has to be traceable to a live, non-superseded row.

## What the audit found

Running the four checks against 50 real transactions across 5 agents:

- **Balance reconciles exactly.** Initial $5.000000 − live spend $0.231882 = expected $4.768118. Actual account balance: $4.768118. **Diff: $0.000000.**
- **Naive summation overstates spend by +2.35%.** Summing every cost row (including superseded ones) gives $0.237327 against a true live total of $0.231882 — the double-count trap, quantified.
- **Holds authorize at your token cap; settlements bill actuals — confirmed by experiment.** Fired the same prompt three times varying only `max_tokens` (100/400/900): final cost identical ($0.0001) every time, while the initial hold scaled linearly with the cap ($0.000243 at 400, $0.000543 at 900 — ratio 2.23 vs cap ratio 2.25). The −38.2% average revision in the main sample is therefore workload-shaped: it's the gap between the caps you set and the tokens you actually generate. Implication: `max_tokens` is a hidden cost-control knob — generous caps inflate wallet float and can trip authorization-time budget rules long before real spend justifies it.
- **The hold rate is linear to at least 16k tokens.** Caps of 2,000 / 8,000 / 16,000 produced holds of $0.001203 / $0.004803 / $0.009603 — a constant $0.0006 per 1k tokens of cap (0.2% spread), while the final cost stayed $0.0001. No plateau: hold exposure grows with whatever cap you set.
- **The float is real, not bookkeeping.** Ten parallel calls (cap 900) were fired while polling the account balance every 500ms: balance dropped from $4.767518 to $4.763074 mid-flight — the in-flight holds froze **4.4× the actual settled cost** ($0.00444 held vs $0.001 settled) — then recovered as settlements landed. Under concurrency, holds genuinely reduce available balance: a fleet of agents with generous caps needs proportionally more wallet than it actually spends.
- **Chain integrity is clean.** 0 orphaned superseded rows, 0 completed transactions with no cost row, 0 double-live-row transactions (the double-charge bug). No structural corruption in the ledger.

Full numbers and per-agent breakdown: [`report.md`](./report.md).

## The four checks

1. **Double-count guard** — naive sum vs. live-only sum. Catches the single most common way a spend ledger silently overstates itself: counting superseded rows as if they were real charges.
2. **Balance reconciliation** — initial balance minus live spend vs. the account's actual reported balance. This is the check that matters most on a payments platform: if it doesn't tie to $0.000000, something in the ledger is lying.
3. **Revision analysis** — for every superseded chain, how much did the final cost move from the initial? Surfaces systemic bias in cost estimation, not just isolated bugs.
4. **Chain integrity** — orphans, missing cost rows, double-live rows. The structural sanity checks that catch corruption before it becomes a reconciliation failure.

## How it works

Three-stage pipeline:

1. **`generate_spend.js`** — drives real spend through 3 Sapiom agents (a steady researcher, a steady writer, and a deliberate runaway agent that bursts calls with almost no delay — anomaly data for later).
2. **`ingest.py`** — pulls transactions and account balance from the Sapiom API into DuckDB. Idempotent (safe to re-run), with inline data-quality asserts (unique IDs, no negative costs, no orphaned foreign keys).
3. **`audit.py`** — runs the four SQL checks above against `spend.duckdb` and writes `report.md`.

To run it:

```bash
export SAPIOM_API_KEY=your_key_here
node generate_spend.js
./.venv/bin/python ingest.py
./.venv/bin/python audit.py
```

## Cost

| | |
|---|---|
| Total spend | $0.24 |
| Services used | Linkup search, OpenRouter LLM (`gpt-4o-mini`) |
| Transactions | 50 |
| Agents | 5 |
| Build time | one weekend |

## Next steps

- **Hold-utilization KPI** — per-agent ratio of settled cost to authorized hold; directly actionable (tune max_tokens) and computable from the existing supersession chains.
- **Runaway-agent anomaly detection** — the burst-spend data is already generated (`spend-runaway`, 25 calls, 0.3s apart); next is flagging that pattern automatically instead of eyeballing it in the agent breakdown.
- **Burn-rate forecasting against a cap** — project time-to-exhaustion from live spend velocity so a budget cap is a warning, not a surprise.
- **DQ contracts on the event stream** — turn the inline asserts in `ingest.py` into standing contracts that run continuously, not just at ingest time.
- **Dashboard** — the four checks as a live view instead of a generated markdown report.
