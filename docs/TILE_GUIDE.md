# Dashboard Tile Guide — know every tile cold (CEO-conversation prep)

Private prep. One block per tile: what it says · how it's computed · the one-breath line · what to say if pushed.
The page story in one sentence: **"57 cents moved, 53 stuck, and my books prove both to the micro-dollar — then I measured your own three words."**
Never fumble these three numbers: **$0.528502 frozen · 18% capture · $0.000000 diff.**

---

## HERO ROW — the money story

### 1. TPV — Settled Payment Volume · **$0.567745**
- **Means:** money that actually moved. Settled charges only.
- **Computed:** all live cost rows ($1.096) minus frozen holds ($0.529). Cross-checks as $5.00 − totalBalance.
- **One breath:** "375 real transactions, 41 agents, 9 services — 57 cents of it actually settled."
- **If pushed — why exclude holds?** "Payments TPV means settled volume. The frozen $0.53 includes 85 *denied* calls — counting money for calls that never executed as payment volume would be wrong." Txn/agent counts stay total (they're activity, not money).

### 2. Frozen Capital — Uncaptured, Never-Voided Auths · **$0.528502 · 0 RELEASED / 3 DAYS**
- **Means:** money in a third state — not charged, not returned. 11.2% of the wallet.
- **Computed:** live account snapshot: totalBalance − availableBalance. Composition: 4 failed-call holds ($0.307, $0.076803 each) + 85 denied-call holds ($0.221). Ties to the ledger to the micro-dollar.
- **One breath:** "When a call fails or gets denied after its hold is placed, the money never comes back — no void API, no sweep observed, zero released in three days."
- **If pushed:** the 4 failures were *forced* (128k max_tokens → gateway 502) — the retention mechanic is deterministic (4/4, zero variance), but how often organic traffic fails post-hold is NOT measured. Never quote a $/day loss rate. Key mechanics: availableBalance drops, totalBalance never moves — so it's frozen, not charged.

### 3. Reconciliation — Ledger vs Account Balance · **±$0.000000 · TIES OUT**
- **Means:** two *independently produced* numbers agree — my ledger math ($5.00 − active rows) vs their API's reported availableBalance.
- **Computed:** settled $0.57 + frozen $0.53 + available $3.90 = $5.000000 exactly. The whole wallet partitioned into three states, provably.
- **One breath:** "I predict their own account balance to the micro-dollar. If either their ledger or my pipeline dropped a single row, this wouldn't be zero."
- **If pushed:** it reconciles against availableBalance; the gap up to totalBalance is exactly the Frozen Capital number — the two heroes prove each other. Bonus: naive sum of every cost row overstates spend +48% (superseded chains) — why derive-current modeling matters.

---

## DETAIL ROW — the payments ops console

### 4. Authorization Rate · **77%**
- **Means:** share of calls governance approved. THE payments optimization metric (Zerbib's world).
- **Computed:** 289 approved / 375, 86 denied by spending rules.
- **One breath:** "77% approval — and the denials are real: my own governance experiments created them."
- **If pushed:** with zero rules configured it reads 100% (nothing to say no) — meaningless. The 86 denials also connect to Frozen Capital: **denial itself freezes the hold** (85/85). Approval rate and frozen capital are coupled.

### 5. ATV — Average Transaction Value · **$0.002175**
- **Means:** average sale size. The gift tile — it argues Sapiom's thesis FOR them.
- **Computed:** settled $0.567745 ÷ 261 settled txns.
- **One breath:** "A fifth of a cent per transaction — card rails carry a ~$0.30 fixed fee, so this traffic is orders of magnitude below what card economics can process. That's why x402 rails exist."
- **If pushed:** workload-shaped (LLM-dominated fleet, one 83h window) — not a market measurement. Stay at "orders of magnitude," don't quote precise fee schedules.

### 6. Capture Rate ($-weighted) · **18.0%**
- **Means:** authorize $1.00 → capture $0.18. Holds ~5.6× oversized vs settlement.
- **Computed:** Σ settled ÷ Σ held across 27 organic LLM supersession chains (dollar-weighted).
- **One breath:** "Float inefficiency, not lost revenue — the system settles correctly, it just grabs 5.6× too much on the way. And it's LLM-only: I surveyed the other five services, all price flat, no holds."
- **If pushed:** all-traffic figure is 3.8% (my adversarial experiments force oversized holds — disclosed). Workload-shaped: right-sized caps ≈100%, lazy 16k caps ≈1%. At $1M/day: ≈$341–$771 frozen at any instant (Little's Law, validated live within 9%). Levers: hold lifetime + max_tokens right-sizing (~79% reduction available).

---

## SECTION 2 — his three words, measured (ComputerWeekly: "The goal isn't zero failure. It's making failures bounded, visible and recoverable.")

### BOUNDED

### 7. Effective Budget · **0–80% of cap**
- **Means:** you set a cap; agents actually get 0–80% of it before denial.
- **Computed:** true settled spend ÷ cap at the moment of denial, across 4 test rules (54–80%) + the bricked case: one 8000-token hold ≥ a $0.002 cap = denied at $0 spent (engine read 240% utilization from one hold).
- **One breath:** "The engine double-counts its own holds — it reports 100% spent when the agent really used 54 to 80 percent. Worst case, one oversized call bricks an agent at zero dollars."
- **If pushed:** n=4 rules + 3 blast agents, LLM-only, corroborated across two independent experiment sessions (experiments/03).

### 8. Concurrency Leak Factor · **up to 3×**
- **Means:** the bound *breaks* under concurrency — opposite failure of tile 7 (which fires too early).
- **Computed:** rule sized to permit exactly ONE call's hold: sequential-ish 10 → 1 allowed (correct); 20 concurrent → 2; 50 concurrent → 3.
- **One breath:** "Authorization checks race a stale cumulative ledger — fire enough calls at once and money leaks past the cap."
- **If pushed:** confirmed two ways (the rule engine's own per-txn decisions AND client HTTP 200s — leaked calls really executed). One trial per round — mechanism proven, magnitude small (2–3×), scales with concurrency. Maps to Zerbib's public claim: "rate limits, quotas and backpressure… always within defined boundaries." Ask, don't gotcha: "is per-wallet auth meant to be atomic?"

### VISIBLE

### 9. Ledger Blind Spots · **25% of all calls**
- **Means:** calls the ledger can't fully explain — who/what/how it ended.
- **Computed:** 94/375 = 86 denied (no outcome ever written) + 6 service='unknown' + 2 zombies (authorized, never completed).
- **One breath:** "A quarter of all calls, the record is incomplete — a denied call just stops, no terminal state; one entire service lands unlabeled."
- **THE TRAP — "isn't this just your auth rate inverted?"** Answer: "Mostly, and that's the finding — a denial leaves NO record of its outcome. Governance acts and the ledger doesn't write down the ending. Plus 8 calls that executed fine and still can't be explained — including 100% of the scraping service's revenue, which logs as 'unknown'."

### 10. Cost-per-Task Traceability · **2% of spend traceable to a task**
- **Means:** the ledger sees calls, not jobs. "What did this task cost end-to-end?" — unanswerable for 98% of spend.
- **Computed:** 6/375 txns carry a trace_external_id; those carry $0.024 of $1.096 live spend.
- **One breath:** "Traces are flat grouping IDs today — no parent/child. Span hierarchy in x402 metadata would unlock task-level cost attribution."
- **If pushed:** quote Ilan back (ComputerWeekly): "When you can trace spend to a specific agent or workflow, you can evaluate whether it's producing value." His vision, this measures the gap.

### RECOVERABLE

### 11. Hold Recovery · **5.3s–12.0s / never**
- **Means:** recovery works on the happy path only. Success: hold releases in seconds. Failure or denial: never observed released.
- **Computed:** success-path = p50/p95 hold→settlement on 31 organic LLM chains; failure-path = the same 89 frozen holds as hero 2, 0 released.
- **One breath:** "In card payments an uncaptured auth gets voided — authorization reversal, standard mechanism. Auth-reversal rate here: zero percent."
- **If pushed:** 4/4 forced trials, zero variance, frozen-not-charged; organic timing n=31 (all-traffic n=188 runs 2.0–8.5s); frequency in live traffic unmeasured.

### 12. Refunds & Disputes · **🔒 NO MECHANISM EXISTS**
- **Means:** post-settlement recovery. Card rails: refund APIs + chargebacks (Visa monitors dispute rates network-wide). Agent rails: when an agent pays for a bad result — no refund API, no dispute flow, no adjudication path.
- **One breath:** "When an agent buys garbage, who adjudicates? Nothing exists yet — the money is unrecoverable by design, not by failure."
- **Pairs with tile 11:** pre-settlement money never comes back on failure; post-settlement money can't come back even in principle. Together = the Recoverable verdict.

### 13. KYA Scorecard — Know Your Agent
- **Means:** his own coinage made real — one behavioral risk grade per agent.
- **Computed:** velocity-only score: 60 pts if peer-relative anomaly flagged + peak-burst×3 (max 30) → A–F. Spend shown but NOT scored. <3 calls = N/A.
- **One breath:** "It graded the *actual* runaway — fleet-test, 10 calls in under a second — F. The agent literally *named* spend-runaway grades C, because its behavior is steady. The detector judges behavior, not names."
- **If pushed:** illustrative, velocity-only, one session — labeled as such on the tile. Peer-relative threshold (median gap < 20% of peer median) adapts to the account's own baseline instead of magic numbers. It flagged my TOCTOU race agents too — adversarial traffic it was never tuned for.

---

## Echo defenses (the three "aren't these the same?" traps)
1. **Blind Spots vs Auth Rate** — see tile 9. Record quality vs approval decision; same 86 txns, different question.
2. **Capture Rate vs Frozen Capital** — capture = the *ratio* on successful LLM chains (efficiency); frozen = the *stock* of money stuck on failed/denied calls (loss-shaped). Different populations: capture's holds DID release; frozen's never will.
3. **Hold Recovery vs Frozen Capital** — same 89 holds on the failure side; Hold Recovery adds the success-path timing and the missing-mechanism (auth reversal) framing.

## If the CEO asks "what would you build first?"
"Three things from what I've already seen: standing data-quality contracts on the ledger — the invariants I checked, as blocking gates. Reconciliation as continuous monitoring — you should catch drift before a customer does; the concurrency race is exactly the class it catches. And the analytical platform — the current system answers what's-true-now; customers will ask what-happened-and-what's-next. That's Data 1.0."
