# Dashboard Journey — Top-Down Tour of Every Tile

A walkthrough of `dashboard.html` (the Sapiom Spend — CEO Dashboard): what each tile
measures, why it earned a spot, and what to be careful about when reading it.

**Part 1** explains each tile in full detail. **Part 2** re-explains everything in
plain, simple words. Same tiles, same order, two depths.

---

## The shape of the page (top-down)

```
Sapiom Spend — CEO Dashboard
│
├── Section 1 — Payments KPIs (measured on Sapiom)
│   │   "Metrics a payments executive already knows how to read"
│   ├── Hero row:    TPV · Capture Ratio · Reconciliation
│   └── Detail row:  Auth → Capture Time · Velocity Checks · Loss Rate · Auth Rate
│
└── Section 2 — Agent-native KPIs (proposed definitions)
    │   "What agent payments actually needs to measure"
    ├── Bounded:     Capital Overhang Ratio · Blast Radius $ 🔒 · Cap Utilization 🔒
    ├── Visible:     Attribution Completeness · Phantom Spend Rate
    ├── Recoverable: Hold-Release Latency · Refund-on-Failure
    └── KYA Scorecard — Know Your Agent (full-width table)
```

The split is deliberate. **Section 1** speaks the reader's existing language —
standard payments-industry metrics, computed live on Sapiom's own ledger, so a
payments person can orient instantly. **Section 2** is the pitch: the argument that
agent payments needs *new* metrics, organized around Sapiom's own public framing
that agent-spend failures must be **bounded** (damage has a ceiling), **visible**
(you can see every dollar), and **recoverable** (money comes back when things fail).
The definitions are the product; the numbers prove each one is computable today.

---

# Part 1 — Every tile, in detail

## Section 1: Payments KPIs — measured

### Hero 1 · TPV — Total Payment Volume

**Number tonight:** $0.277472 · 81 transactions · 16 agents.

**What it measures:** The sum of all live (non-superseded) spend in the ledger
snapshot — the single number every payments business is sized by.

**Why it's here:** It's the anchor. Every other tile's "at $1M/day" projection
scales off this. The scale note ("~938,367× tonight's pace") is honest about being
a ratio, not a load test — it exists to let the reader translate tiny real numbers
into the magnitudes they think in, without pretending the pipeline was run at that
volume.

**How it's computed:** Sum of cost rows where `superseded_at IS NULL`, over a
~6.2-hour live session.

---

### Hero 2 · Capture Ratio

**Number tonight:** 18.0% — authorize $1.00 → capture $0.18.

**What it measures:** Dollar-weighted, across all 27 hold→settle chains: settled
dollars ÷ held dollars. Sapiom authorizes a hold at your `max_tokens` cap, then
settles for actual usage — this ratio says how oversized those holds are.

**Why it's here:** It's the project's headline finding. Holds are ~5.6× larger
than what actually settles. That is *not* lost revenue — settling below the hold
is the system working as designed — it's a **float inefficiency**: customer money
frozen that didn't need to be. The scale note applies Little's Law to say what
that means at volume: at $1M/day TPV, roughly $61–$138 frozen at any instant
(because holds clear in 5.3–12.0s). The tile deliberately renders in neutral ink,
never a status color, because it's a magnitude to manage, not an alarm.

**Caveats baked into the tile:** n=27 LLM chains, one service (`sapiom_openrouter`),
one model (gpt-4o-mini), one session — LLM-specific, not platform-wide. The method
note also preserves the *superseded wrong framing* (naively scaling gives $4.57M —
a per-day flow, ~33,000× off from the instantaneous stock) so nobody re-derives
the mistake. Full derivation: `dryrun/float_model.md`.

---

### Hero 3 · Reconciliation

**Number tonight:** $0.000000 diff · chip: TIES OUT.

**What it measures:** Latest account balance vs. (initial balance − live spend).
If a spend ledger is telling the truth, this is $0.000000 exactly.

**Why it's here:** This is the trust check — the one number that, if nonzero,
means the ledger is lying somewhere. It's also where the double-count trap lives:
summing *every* cost row (including superseded holds) gives $0.305310 against a
true $0.277472 — a **+10% overstatement**. At $1M/day that's ~$100K/day of phantom
spend if a consumer of this ledger sums naively instead of filtering to live rows.

**Caveats:** Ties out *as of this snapshot* — the live account has spent more in
dry-run experiments since (see `RUN_LOG.md`); re-ingest before claiming it ties
today. The chip is computed from the data (`t.green`), never hardcoded.

---

### Detail · Auth → Capture Time

**Number tonight:** 5.30s / 11.96s (p50/p95) for `sapiom_openrouter`, n=31.

**What it measures:** Per service, time from authorization (hold placed) to final
capture (settlement row written).

**Why it's here:** It's the payments-world "settlement latency" analog, and it
feeds the float math directly — hold lifetime is the other input to Little's Law
in the Capture Ratio tile. It also surfaces a ledger quirk worth knowing: the five
flat (non-chained) services show small *negative* latencies (−832ms to −95ms)
because their cost row is written as part of authorization itself, before
`authorizedAt` is stamped. Not a bug — but a trap for anyone computing latency
naively, which is exactly why the tile shows it instead of hiding it.

---

### Detail · Velocity Checks

**Number tonight:** 1 FLAGGED — `fleet-test`, median inter-call gap 0.076s vs.
peer median 8.4s.

**What it measures:** Per agent: call count, median gap between calls, peak calls
in any 60-second window. An agent is flagged "runaway" when its median gap is
under 20% of the peer-agent median gap.

**Why it's here:** It's the card-testing analog for agents. In card payments,
velocity checks catch stolen cards being tested in rapid bursts; in agent payments
the same signal catches a looping or runaway agent burning budget. The flag is
peer-relative rather than a fixed threshold, so it adapts to whatever "normal"
looks like in the fleet.

---

### Detail · Loss Rate

**Number tonight:** 0 bps of TPV. 2/81 transactions failed (2.5%), 0/2 were charged.

**What it measures:** Of the TPV, what fraction was paid for failed calls.

**Why it's here:** "Do I pay for failures?" is the first question any buyer asks.
The honest answer tonight is layered: both natural failures died *pre-settlement*
(client/gateway errors before any hold), so nothing was charged. But the tile
explicitly cross-references Refund-on-Failure: **post-hold** failures are NOT
free — in a direct test, 4/4 forced post-hold failures had their hold retained.
The 0 bps applies only to this sample's pre-hold failure mode. Full queries:
`loss_rate.md`.

---

### Detail · Auth Rate

**Number tonight:** 100% — 81/81 approved, 0 denied.

**What it measures:** Share of authorization attempts approved.

**Why it's here:** Mostly as an honesty exhibit. In card payments, auth rate is a
core health metric. Here, 100% reflects an **unconfigured account** — no spending
rules were active, so there was nothing to deny. The tile says so in its own
subline. It exists to show what the metric *would* be, and to make the point that
a perfect number can mean "no governance," not "good governance." Details:
`findings.md` §7.

---

## Section 2: Agent-native KPIs — proposed

Grouped under Sapiom's own three-word framing of what safe agent spend requires:
**bounded / visible / recoverable**. Two tiles are greyed placeholders with 🔒
tags — deliberately shown *without* fake numbers, because the honest state is
"computable once governance rules exist, and here's the definition ready to go."

### Bounded · Capital Overhang Ratio

**Number tonight:** 5.57× — $0.027838 held ÷ $0.004998 settled, 27 chains.

**What it measures:** The inverse framing of Capture Ratio: for every dollar that
settles, how many dollars were frozen to get there.

**Why it's here:** Same underlying data as the Capture Ratio hero, but framed as
the *bound* on capital exposure — the multiplier on wallet size a fleet needs
relative to what it actually spends. The direct lever is right-sizing `max_tokens`
and hold lifetime. Caption keeps it honest: holds clear in 5.3–12.0s, so this is
not permanently parked capital. Same LLM-only scope caveat.

### Bounded · Blast Radius $ 🔒 (placeholder)

**Definition:** Max spend one agent reaches before a cap stops it.

**Why it's here (even empty):** It's the single most important *bounded* number —
"if one agent goes rogue, how much can it burn?" It cannot be measured tonight
because no spending rule was configured in this sample (BACKLOG #8, requires the
human UI). Showing it greyed, with a lock tag and no fake number, is the point:
the definition is ready, the measurement honestly isn't.

### Bounded · Cap Utilization 🔒 (placeholder)

**Definition:** Spend ÷ budget, per agent.

**Why it's here (even empty):** The steady-state companion to Blast Radius — once
budgets exist, this is the gauge that says which agents are near their cap (and
which caps are so loose they're not really bounds). Same lock reason: no per-agent
budget exists without a spending rule.

### Visible · Attribution Completeness

**Number tonight:** 100% — 81/81 transactions have agent, traceId, service, and
outcome all populated. Caveat: 2/81 carry `service_name='unknown'`.

**What it measures:** Can every dollar be traced to who spent it, on what, in
which trace, with what outcome?

**Why it's here:** *Visible* starts with attribution — an unattributed dollar is
an invisible dollar. The tile also demonstrates the audit's standard of honesty:
100% non-null is technically true, but two rows carry the value `'unknown'`, which
is populated-but-unresolved. The caveat is printed on the tile rather than
footnoted away.

### Visible · Phantom Spend Rate

**Number tonight:** +10.0% — naive sum $0.305310 vs. live $0.277472.

**What it measures:** How much a naive consumer of the ledger (summing every cost
row, including superseded holds) would overstate spend versus the true live total.

**Why it's here:** It's the Reconciliation hero's overstatement finding, promoted
to a named, trackable metric. Sapiom *restates* costs — an OpenRouter call posts a
hold row, then supersedes it with the settled row. Any downstream dashboard, bill,
or budget alert that sums naively silently double-counts every chain. Naming the
failure mode makes it monitorable.

### Recoverable · Hold-Release Latency

**Number tonight:** 5.30s / 11.96s (p50/p95), `sapiom_openrouter`, n=31.

**What it measures:** Time from hold to final capture — how long frozen money
stays frozen.

**Why it's here:** *Recoverable* is a time property, not just a yes/no. The same
p50/p95 appears in Auth → Capture Time (Section 1); here it's reframed as the
recovery clock for frozen capital, and it's the duration term in the Little's Law
float math. Same LLM-only scope caveat.

### Recoverable · Refund-on-Failure

**Number tonight:** 100% RETAINED (critical chip) — 4/4 forced post-hold failures
kept the hold frozen; mean $0.076803 retained, zero variance.

**What it measures:** When a call fails *after* a hold is placed, what share of
the hold is released back vs. retained/frozen?

**Why it's here:** This is the sharpest finding on the board and the one tile that
should read as unambiguously serious. In the natural sample, 0/2 failures ever
held a cost (both died pre-hold — nothing to test), so a *direct experiment*
forced the post-hold failure case: 4/4 trials, `availableBalance` dropped by
exactly $0.076803 each time while `totalBalance` never moved — so it is not a
completed charge, and it is not released either. Frozen. Over-requested
`max_tokens` makes the frozen amount larger.

**Caveat printed on the tile:** the per-failure retention mechanic is measured and
deterministic (4/4); the *frequency* of post-hold failures in live traffic is not
measured — do not read this as a $/day loss rate. Sources: `findings.md` §9,
`dryrun/failure_capture_n3.md`, `dryrun/refund_watch.log` (still being watched for
a delayed release).

### KYA Scorecard — Know Your Agent

**What it is:** One row per agent (all 16): spend, calls, median gap, peak burst,
runaway flag, and an illustrative A–F **velocity grade**.

**Formula:** 60 points if the peer-relative velocity anomaly is flagged, plus up
to 30 points scaled from peak calls in any 60s window (peak × 3, capped).
A 0–9 · B 10–24 · C 25–49 · D 50–74 · F 75–100. Agents with <3 calls grade N/A.

**Why it's here:** "Know Your Customer" is the identity layer of payments; KYA is
the proposed agent equivalent — a standing per-agent risk read, not just a
fleet-level alarm. The tile is scrupulously labeled *velocity-only and
illustrative*: spend is displayed but never scored, which the data makes vivid —
`spend-runaway` is ~54% of all TPV and grades C, while `fleet-test` is ~0.4% of
TPV and grades F, because grade tracks *call-rate behavior*, not dollars. (An
earlier "composite risk grade" label overclaimed and was fixed in the adversarial
audit.)

---

# Part 2 — Same tiles, simple words

Imagine the dashboard is a report card for a bunch of robot employees who are
allowed to spend company money on their own.

**The page has two halves.** The top half uses money-words bankers already know,
so a money person trusts it fast. The bottom half says: "robots spending money is
a new thing — here are the new measurements it needs," sorted into three promises:
the damage has a limit (*bounded*), you can see every penny (*visible*), and money
comes back when things break (*recoverable*).

### Top half — the banker numbers

- **TPV** — "How much money moved, total?" About 28 cents, from 81 purchases by
  16 robots in one evening. Small on purpose — the point is the math is real, and
  the tile shows what it looks like scaled up to real volume.

- **Capture Ratio** — Like a gas station putting a $100 hold on your card when
  you only pump $18 of gas. Here the system freezes about $5.60 for every $1
  actually spent. You get the difference back in seconds — but while it's frozen,
  it's your money you can't use. The fix is telling the robots to ask for smaller
  holds.

- **Reconciliation** — The checkbook test. Money at start, minus money spent,
  should equal money left — to the exact penny. It does: difference $0.000000.
  Bonus lesson: if you add up the receipts the lazy way, you count some purchases
  twice and think you spent 10% more than you did.

- **Auth → Capture Time** — How long between "freeze the money" and "take the
  final amount." About 5–12 seconds for the AI service. (Some services look like
  negative time — that's just the order the paperwork gets stamped in, not time
  travel.)

- **Velocity Checks** — The "is a robot going haywire?" alarm. One robot was
  making a call every 0.08 seconds while its peers took ~8 seconds between calls.
  Flagged. Same idea banks use to catch a stolen card being tested rapid-fire.

- **Loss Rate** — "Did we pay for stuff that failed?" In this sample, no — 2 calls
  failed but both failed before any money was touched, so $0 lost. Careful though:
  the bottom half shows failures *after* money is frozen are a different, worse
  story.

- **Auth Rate** — 100% of purchases approved. Sounds great; actually means nobody
  set any spending rules, so there was nothing to say no. A perfect score on a
  test with no questions.

### Bottom half — the new robot-money numbers

- **Capital Overhang Ratio** — Same gas-station story, flipped: $5.57 frozen for
  every $1 spent. The size of the "wallet must be bigger than the bill" problem.

- **Blast Radius $** 🔒 — "If one robot goes rogue, what's the most it can burn
  before a limit stops it?" Can't be measured yet — no limits were set up. Shown
  greyed-out instead of faking a number.

- **Cap Utilization** 🔒 — "How close is each robot to its allowance?" Also needs
  allowances to exist first. Also greyed-out on purpose.

- **Attribution Completeness** — "Can every penny be traced to which robot spent
  it and on what?" Yes, 100% — except 2 purchases are tagged 'unknown' service,
  which is a name that answers nothing. The tile admits that instead of hiding it.

- **Phantom Spend Rate** — Add up receipts the lazy way and you'll believe you
  spent 10% more than reality, because the system writes a guess-receipt first
  and a real receipt after. Count only the real ones.

- **Hold-Release Latency** — How long frozen money stays frozen: usually ~5
  seconds, worst case ~12. Fine at this speed — a problem if it ever gets slow.

- **Refund-on-Failure** — The scariest tile. If a call fails *after* money is
  frozen, does the money come back? We forced it to happen 4 times: the money
  stayed frozen all 4 times. Not charged — but not returned either. Just stuck.
  And the bigger the hold you asked for, the more gets stuck. (We don't yet know
  how *often* this happens naturally — only that when it happens, this is the
  outcome.)

- **KYA Scorecard** — Report card, one row per robot, grade A–F. The grade only
  measures *how fast* a robot fires calls (the haywire signal) — not how much it
  spends. That's why the robot that spent over half the money got a C, and a robot
  that spent almost nothing got an F for machine-gunning calls.

---

*Numbers in this document are from the dashboard snapshot generated 2026-07-04
(81 txns, 16 agents). Regenerate with `python export_dashboard.py`; deeper method
docs: `findings.md`, `report.md`, `loss_rate.md`, `dryrun/float_model.md`.*
