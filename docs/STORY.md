# Sapiom Spend-Intel — Project Story & Narration Script

*A $5 wallet, pointed at Sapiom's live production API. There is no test or sandbox mode, so every experiment below cost real money. The goal was never "find a bug" — it was to show up as the kind of data engineer you'd trust with a live payments ledger.*

---

## 2. The project in iterations

- **Iteration 0 — The loop.** Start with the smallest honest thing: generate real agent spend, ingest it, audit it, reconcile it against Sapiom's own books. It tied out to the penny. That proved the thesis before anything else did: their payment stream is a ledger, and I can audit a ledger.

- **Iteration 1 — First real finding.** Sapiom prices its pre-authorization hold on `max_tokens`, but settles on actual tokens used. A big cap plus a small real call means they freeze roughly five times what you actually spend. Headline: *"you freeze $5 to settle $1."*

- **Iteration 2 — Scale into an artifact.** An overnight autonomous run turned that one finding into a dashboard, a findings document, trace mining, and a spend-optimization advisor. One insight became a deliverable.

- **Iteration 3 — Learn the audience.** I researched the CEO, Ilan Zerbib. His language isn't volume metrics — it's governance: "bounded, visible, recoverable" failures, and a framework he calls "Know Your Agent" (KYA). I reframed everything in his own words — building the instrument panel for his own pitch, not mine.

- **Iteration 4 — The experiment cascade.** Each question spawned the next one: do governance rules evaluate on the hold or the settlement (they judge money that was never actually spent)? Is there a concurrency race that lets caps leak when calls arrive together (reproduced, 2x and 3x, under load)? Does the hold stay linear all the way to 64k tokens (yes — a solid floor for the float model)? What happens if a call fails *after* the hold is placed (the money freezes, 4 times out of 4)? And is governance itself creatable over an undocumented REST API (yes)?

- **Iteration 5 — The reckoning (the most important one).** Every flashy number broke under scrutiny. "$4.57M frozen daily" turned out to be wrong by roughly 30,000x — rebuilt properly with Little's Law, the real figure is more like $60–$140. "789 bps blended take rate" turned out to rest on N=1, a minimum-fee-floor artifact, and backwards attribution — cut. "Billed for zero output" turned out to be wrong too: checking the real account balance showed the money was FROZEN, not billed — corrected. I caught myself: I built adversarial audits whose whole job was to break my own numbers, and they found the errors before any interviewer could have.

- **Where I am now.** A public, live dashboard where every surviving number reconciles exactly to the raw ledger. Findings ranked by how well they survive a hard question, not by how impressive they sound. Caveats printed on the tile itself, not buried in a footnote. Two audience framings for two different people. A watcher still quietly tracking the one open question — does the frozen money ever get released? And a code freeze — because knowing the difference between *done* and *fiddling* is itself the point.

---

## 3. The meta-lesson

I started out trying to find impressive things. I ended up building a discipline for telling impressive-but-wrong apart from modest-but-true — and choosing to show only the true ones. Every big, scary number was fragile. Every small, boring, exact number held. A data engineer who kills their own best-looking finding because the balance ledger contradicts it is exactly who you want owning a payments data platform. This arc — not any single number in it — is the evidence.

---

## 4. Findings, ranked by defensibility

| Tier | Finding | Status / N | How to state it honestly | Caveat |
|---|---|---|---|---|
| 1 | Rules fire on the HOLD, not the settlement | Reproduced, exact to the penny | A `usage_limit` rule with limit $0.001 denied a call whose real settlement would have been ~$0.0001 — because the call's hold was $0.002403. The denial's own evidence (`violations[].currentValue: 0.002403`) matches the hold to the micro-dollar. | The mechanism itself needs no hedge. Related footgun worth mentioning in the same breath: `measurementScope` defaults to `"all"` (tenant-wide sum), not per-agent, unless explicitly set to `"rule"`. |
| 1 | Fail-after-hold freezes the money | 4/4, zero variance, $0.076803 each | If a call fails after its hold is placed, the full hold is retained — four independent trials, every one exactly $0.076803. `availableBalance` drops by that amount each time; `totalBalance` never moves. | This is a hold RETAINED / FROZEN, not a completed charge — don't call it "billed." The capture *mechanic* is measured (4/4); how often calls fail post-hold in ordinary traffic is not. `refund_watch.js` is tracking whether the freeze ever releases. |
| 2 | Hold scales linearly with `max_tokens`, confirmed through 64k tokens | Confirmed (extends an earlier 2k–16k result) | Hold tracks `max_tokens × $0.0006/1k` almost exactly at every rung through 64k tokens — the foundation the float model stands on. | A confirmation, not a headline on its own. Its value is what it lets you build (the Little's-Law float model below). |
| 2 | TOCTOU concurrency race on a hold-based spending rule | Reproduced, 2x and 3x leak | A rule sized to allow exactly one call's hold let through 2 of 20 concurrent calls (`max_tokens=8000`) and 3 of 50 (`max_tokens=4000`); a fast, small-hold batch (N=10) leaked 0, exactly as designed. | Can't cleanly separate per-call latency from concurrency depth — the money-safety cap coupled the two. Magnitude is small (a 2–3 call slip). State it as an invitation — *"is the check meant to be atomic per-wallet?"* — never as a hard claim of a bug. |
| 3 | Take rate / margin table | N=1 per service; floor artifact suspected | Measured take rates ran from 0% (Linkup, Fal.ai) to +233% (ElevenLabs); blended 789 bps, dollar-weighted across the 4 high-confidence rows. | The entire blended margin comes from one LLM call ($0.0001 charged vs. $0.0000033 real cost) — very likely a per-call minimum-billing floor, not a percentage markup. Cut the blended headline from the lead pitch. |
| 3 | "$4.57M frozen daily" (original scale-hook) | Dead — corrected | Superseded by a Little's-Law model: at the same $1M/day TPV scale, the defensible instantaneously-frozen figure is ~$61–$138. | The original number was wrong by roughly 30,000x. It silently assumed a ~4.57-day average hold lifetime; the measured reality is 5.3–12.0 seconds. Never cite $4.57M again, from any stale notes or emails. |

The pattern across Tier 3 is the whole point of this project: the flashiest numbers were the wrongest ones.

---

## 5. What to actually present

Don't present all fourteen tiles. Lead with three, one breath each.

1. **Reconciliation** — *I can audit your ledger, and it ties to the penny.* What to say: "I generated real agent spend against your live API, ingested it, and reconciled it against your own ledger — it ties out to $0.000000."
2. **Capture Ratio / Capital Overhang** — *you freeze about 5.6x what you settle, and it clears in seconds — an efficiency point, not lost revenue.* What to say: "For every dollar you eventually settle, you're holding roughly $5.60 of customer capital at some point in the process — and it clears in seconds, so this is a capital-efficiency conversation, not a 'you're losing money' one."
3. **Refund-on-Failure** — *if a call fails after the hold is placed, that freeze gets stuck — 4 out of 4 times.* What to say: "When a call fails after its hold is already placed, in every one of four tests, that hold stayed frozen instead of releasing."

---

## 6. Two audiences

- **Jordi (Founding Engineer, protocol)** — hold-vs-settlement mechanics, and the open question *"do rules fire on the hold or the settlement?"* — now answered, so lead with the answer and let the follow-up questions (TOCTOU, `measurementScope`, undocumented REST governance) carry the conversation.
- **Ilan Zerbib (CEO, ex-Shopify payments)** — his own governance vocabulary, played back to him: bounded / visible / recoverable, Know Your Agent. Pair it with capital efficiency, framed in payments language he already speaks — GPV, capture, float — and no invented numbers.

---

## 7. Freeze state (as of this doc)

**Code freeze declared.** No new findings, tiles, experiments, or paid calls. The backlog stays an idea parking lot — nothing further gets built from it.

**Carve-outs (read-only, allowed):** `refund_watch.js` (a GET-only balance watcher — no spend, no writes), and final dashboard verification reads.

**Money, as of freeze** (source: `dryrun/failure_capture_n3.md`'s final balance check):
- Wallet started at $5.00.
- ~$0.28 truly settled / spent (totalBalance has dropped to $4.721228).
- ~$0.52 currently frozen in unreleased holds (availableBalance $4.202282, totalBalance $4.721228 — the gap is the freeze), mostly the failure-capture experiments.
- availableBalance ≈ $4.20 ($4.202282) · totalBalance ≈ $4.72 ($4.721228).

**Open item being watched:** does the ~$0.52 frozen — especially the four failure-capture holds at $0.076803 each ($0.307212 combined) — ever release, settle to gone, or stay stuck? `refund_watch.js` is the tracker. Its log currently has one seed reading (`STILL-CAPTURED`) against the original N=1 transaction; the three replication holds share the identical mechanism and exact dollar amount, so that seed reading is treated as representative of all four pending a further check.

**Live dashboard:** https://jsharma103.github.io/sapiom-spend-intel/dashboard.html

---

## 8. Next gate

The real next gate is DQX prep for Wednesday's interview — not more Sapiom building.
