# NARRATIVE — interview story scripts

Every number below traces to `report.md`, `findings.md`, `advisor.md`, or the dashboard's own
derived scale-hooks (which are computed live from those same files by `export_dashboard.py` — see
"Numbers & sources" at the bottom for the exact trace of each one). No invented figures.

Per the interview honesty rules in BACKLOG.md: sample size and conditions are stated inline where
they matter, mechanism (confirmed) is kept separate from magnitude (workload-shaped, small-sample),
and anything that reads like a possible bug is framed as an open question, never a gotcha.

---

## 30-sec — CEO (Zerbib)

I put a fleet of agents on your platform and audited it like a payments ledger. It reconciles
penny-exact — $0.000000 diff on real spend — but the **capture ratio is 18%: you freeze $5 to
settle $1**. At agent-scale transaction volume that's real customer capital sitting frozen, not
spent, and the ledger that has to track it honestly runs at petabytes a day. That's the data
platform I build.

*(70 words)*

---

## 2-min — CEO (Zerbib)

Over one evening I ran a fleet of 16 agents through Sapiom's live API — 81 transactions, $0.277472
in real settled spend — and audited the ledger the way you'd audit a payments book, not a demo.

First finding: every LLM call authorizes a hold sized to the `max_tokens` you configure, not what
the model actually generates. You set the meter, not the model.

Second: naively summing every cost row the way a careless pipeline would overstates spend by
**+10%** — Sapiom restates costs the way a claim gets re-adjudicated, an initial estimate replaced
by a final capture, and only the live row is real money. Filter for that, and the ledger ties out
to the penny: $0.000000 diff against the account balance.

Put those two together and you get the headline number: **capture ratio is 18%** — for every
dollar authorized, eighteen cents actually settles. Run that at $1M/day of agent-scale volume and
you're looking at roughly $4.6M of customer capital frozen at any moment, not spent, just parked —
a real balance-sheet cost, not a rounding error.

Third: one test agent fired ten calls in under a second. A peer-relative velocity check — no fixed
threshold, just "is this agent firing anomalously fast relative to its own peers" — flagged it
automatically. Same shape of defense a card network runs for card-testing fraud, aimed at agent
spend instead.

The fix is already sitting in the data: right-sizing `max_tokens` per agent, instead of one
generous cap for everyone, cuts hold size by an estimated **79%** in this sample (small sample,
one model, one evening — directionally right, worth validating at scale).

And the bigger point: none of this required insider access — append-only ledger math, reconcile
instead of overwrite, derive the current state instead of mutating it. At agent scale that's a
petabyte-a-day data platform, and it's the same discipline I'd bring in-house.

---

## 30-sec — protocol engineer variant (Jordi)

Same audit, protocol lens: I traced the pre-auth hold against the final settlement on every LLM
call. Holds price off `max_tokens`, not actual usage — mechanism confirmed, magnitude
workload-shaped (one evening, one model, n=27 chained calls, so treat it as directional). Open
question, genuinely, not a gotcha: **do spending rules evaluate against the hold or the
settlement?** If it's the hold, a budget rule fires on a number nobody's actually spending. Would
love to compare notes on how the SDK resolves that today.

*(83 words)*

---

## Delivery notes — which tile to point at, per beat

| Story beat | Dashboard tile | What's on screen |
|---|---|---|
| "audited it like a payments ledger" / "81 transactions, 16 agents" | Header subtitle + **TPV** hero | `81 txns · 16 agents · generated <date>`; TPV hero shows `$0.277472` |
| "reconciles penny-exact" | **Reconciliation** hero | `$0.000000` badge `TIES OUT` |
| "naive-sum trap, +10%" | **Reconciliation** hero subline | "naive sum overstates +10% — must filter, not sum, chains" |
| "capture ratio is 18%: freeze $5 to settle $1" | **Capture Ratio** hero | `18.0%`, subline `authorize $1.00 → capture $0.18` |
| "$1M/day → $4.6M frozen" scale hook | **Capture Ratio** hero, amber scale-note line | "at $1M/day TPV → $4.57M customer capital frozen daily" |
| "one test agent fired 10 calls in under a second" | **Velocity Checks** tile | `fleet-test` row, red-flagged, `0.08s` median gap vs peers' `~8s` |
| max_tokens hold-sizing / 79% remedy | *not on dashboard* — pull up `advisor.md` directly | per-agent recommendation table + the fleet-wide "+79.0%" line |
| unit-economics side question, if asked | **Take Rate** tile | Linkup +20% markup row |
| "restates like an adjudicated claim" (chain detail, if pressed) | **Auth → Capture Time** tile | `sapiom_openrouter` row, p50 5.29s / p95 11.96s |

---

## Numbers & sources

| Number | Value | Source |
|---|---|---|
| Transactions / agents | 81 / 16 | `report.md` Overview |
| Live spend (TPV) | $0.277472 | `report.md` Overview; `dashboard_data.json.header.live_spend_usd` |
| Reconciliation diff | $0.000000 | `report.md` Check 2 |
| Naive-sum overstatement | +10.03% (~+10%) | `report.md` Check 1 |
| Capture ratio | 18.0% (17.95%) | derived from `costs` table (Sigma settled / Sigma held across supersession chains); computed identically to `report.md` Check 1's naive/live split — see `export_dashboard.py:hero_capture_ratio` |
| Scale hook: $1M/day → ~938,000x today's pace | 938,367x | computed from `report.md`'s period + live-spend (daily-rate extrapolation); `export_dashboard.py:hero_tpv` |
| Scale hook: $1M/day → $4.57M/day frozen | $4,569,828 | computed from the capture ratio above; `export_dashboard.py:hero_capture_ratio` |
| Scale hook: $1M/day → ~$100K/day phantom spend | $100,327 | computed from the +10.03% overstatement above; `export_dashboard.py:hero_reconciliation` |
| Auth→capture latency (openrouter) | p50 5.29s / p95 11.96s | `findings.md` section 1 |
| Velocity flag | `fleet-test`, 10 calls, 0.08s median gap vs ~8.4s peer median | `findings.md` section 5 |
| max_tokens hold-sizing remedy | fleet-wide hold reduction +79.0% | `advisor.md` |
| Linkup take rate | Sapiom $0.006/call vs public $0.005/call = +20% | prior dashboard `tile_take_rate` computation, unchanged in v2; sourced from `costs` table + WebSearch (RUN_LOG.md) |
