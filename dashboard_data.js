window.DASHBOARD_DATA = {
  "generated_at": "2026-07-08T04:55:35.230281+00:00",
  "header": {
    "n_txns": 375,
    "n_agents": 41,
    "live_spend_usd": 1.096247,
    "period_start": "2026-07-04 04:51:39.614000",
    "period_end": "2026-07-07 16:00:34.005000"
  },
  "hero_tpv": {
    "value_usd": 0.5677449999999999,
    "n_txns": 375,
    "n_agents": 41,
    "period_hours": 83.14844194444444,
    "daily_rate_usd": 0.1638741470237544,
    "scale_multiple_to_1m_day": 6102243.814303697,
    "subline": "375 txns \u00b7 41 agents",
    "definition": "Money that actually moved \u2014 settled charges only, holds excluded.",
    "scale_note": "at $1M/day TPV \u2192 ~6,102,244x the observed 83h pace (a ratio, not a load test \u2014 this pipeline has not been run at that volume)",
    "method_note": "TPV = settled volume only: live spend $1.096247 (every active cost row) minus $0.528502 frozen holds (see Frozen Capital) = $0.567745 settled. Frozen holds are excluded because they never became real spend: 85 denied-call holds were placed on calls that never executed, and 4 failure holds never settled after a post-hold error. Observed over 83h (375 txns / 41 agents) \u2014 a ~$0.16/day settled pace; at $1M/day TPV that's ~6,102,244x the observed pace (a ratio, not a load test \u2014 this pipeline has not been run at that volume)."
  },
  "hero_capture_ratio": {
    "ratio_pct": 17.953875996838853,
    "ratio_pct_all": 3.8275369059307875,
    "sum_held_usd": 0.027838,
    "sum_settled_usd": 0.004998,
    "n_chains": 27,
    "sum_held_usd_all": 0.522477,
    "sum_settled_usd_all": 0.019998,
    "n_chains_all": 177,
    "overhang_ratio": 5.569827931172469,
    "overhang_ratio_all": 26.126462646264628,
    "subline": "holds are ~5.6x oversized vs settlement \u2014 a float inefficiency, not lost revenue (authorize $1.00 \u2192 capture $0.18) \u00b7 organic fleet 18% \u00b7 incl. adversarial experiments 3.8% \u00b7 capture % is workload-shaped (cap hygiene): right-sized ~100% \u00b7 lazy 16k caps ~1%",
    "scale_note": "to sustain $1M/day of settled spend at the organic fleet's shape, customer wallets carry \u2248 $341\u2013$771 frozen at any instant (Little's Law, validated live within 9% \u2014 dryrun/ll_validation.md; organic holds clear in 5.3\u201312.0s; held volume = 5.6x settled) \u2014 levers: hold-lifetime & max_tokens right-sizing. Assumes steady-state arrivals \u2014 float_model.md \u00a75.",
    "scope_note": "Scope: n=27 organic LLM chains (n=177 incl. adversarial experiments; sapiom_openrouter only, gpt-4o-mini) \u2014 LLM-specific, not platform-wide.",
    "instantaneous_frozen_p50_usd": 341.3453575874794,
    "instantaneous_frozen_p95_usd": 771.0730542216886,
    "hold_lifetime_p50_s": 5.295,
    "hold_lifetime_p95_s": 11.961,
    "hold_lifetime_p50_s_all": 2.028,
    "hold_lifetime_p95_s_all": 8.53,
    "naive_flow_at_scale_usd": 4569827.931172469,
    "naive_implied_lifetime_days": 4.569827931172469,
    "method_note": "Organic fleet (experiment agents excluded): Sigma settled (0.004998) / Sigma held (0.027838) dollar-weighted across 27 supersession chains (hold \u2192 final capture) = 18.0%. All traffic incl. adversarial experiments: 0.019998 / 0.522477 across 177 chains = 3.8% \u2014 experiments force oversized holds by design, dragging the blended ratio down. Little's Law: frozen$ = settled$/day \u00d7 overhang \u00d7 (hold_lifetime_sec/86400) \u2014 at $1M/day TPV, organic p50 (5.29s) \u2192 $341.35, p95 (11.96s) \u2192 $771.07. Full derivation + sensitivity: dryrun/float_model.md. (Superseded framing: naively scaling the organic capture ratio gives $4,569,828 \u2014 a per-day FLOW, not an instantaneous stock; it implicitly assumes a ~4.57-day hold lifetime vs. the measured 5.3\u201312.0s, \u226533,010x off. See float_model.md \u00a74d.)"
  },
  "hero_frozen_capital": {
    "frozen_total_usd": 0.528502,
    "wallet_total_usd": 4.707228,
    "frozen_pct_of_wallet": 11.2,
    "n_holds": 89,
    "n_failure_holds": 4,
    "failure_holds_usd": 0.307212,
    "n_denied_holds": 85,
    "denied_holds_usd": 0.22129,
    "days_observed": 3,
    "n_released": 0,
    "snapshot_at": "2026-07-07",
    "subline": "11.2% of wallet \u00b7 4 failed + 85 denied holds",
    "definition": "Money stuck in a third state \u2014 not charged, not returned, no void mechanism.",
    "scale_note": "failure mechanic is deterministic \u2014 4/4 forced post-hold failures froze the full max_tokens-priced hold; denial-after-hold froze 85/85. Frequency of post-hold failures in organic traffic is NOT measured \u2014 do not read this as a $/day loss rate.",
    "method_note": "Live account snapshot 2026-07-07: unavailableBalance $0.528502 = 4 x $0.076803 failure holds (failure_capture_n3.md, hold_linearity_extension.md) = $0.307212 + $0.221290 live holds on 85 denied transactions (denial_analytics.md) \u2014 ties to the micro-dollar, and equals the Reconciliation hero's total-vs-available gap. Cross-checked live: sampled failure holds still isActive:true, supersededAt:null, 3 days after placement (refund_watch.log). Money sits in a third state: not charged (totalBalance untouched by the hold), not returned (availableBalance stays reduced) \u2014 no release/void API exists, and no backend sweep has been observed reclaiming it. The failure mechanic is deterministic: 4/4 forced post-hold failures froze the full max_tokens-priced hold, and 85/85 denials froze theirs too \u2014 but the frequency of post-hold failures in organic (non-adversarial) traffic is NOT measured; do not read this as a $/day loss rate."
  },
  "hero_reconciliation": {
    "diff_usd": 0.0,
    "green": true,
    "reconciled_against": "availableBalance",
    "available_balance_usd": 3.903753,
    "total_balance_usd": 4.432255,
    "frozen_gap_usd": 0.528502,
    "frozen_matches": true,
    "settled_usd": 0.5677449999999999,
    "naive_sum_usd": 1.618724,
    "live_sum_usd": 1.096247,
    "overstatement_pct": 47.66051811316245,
    "subline": "settled $0.57 + frozen $0.53 + available $3.90 = $5.000000",
    "definition": "My ledger predicts the live account balance to the micro-dollar.",
    "frozen_match_note": "gap to totalBalance = $0.528502 \u2014 matches Frozen Capital exactly",
    "scale_note": "naive sum overstates +48% \u2014 must filter, not sum, chains; full derivation in the tooltip",
    "phantom_at_scale_usd": 476605.1811316245,
    "method_note": "Reconciled against the live snapshot ingested through 2026-07-07 16:00:34.005000. initial $5.000000 \u2212 Sum active cost rows $1.096247 = $3.903753 = availableBalance (diff $0.000000). totalBalance $4.432255 is higher by $0.528502 = frozen holds (gap to totalBalance = $0.528502 \u2014 matches Frozen Capital exactly). Wallet partition (full precision): settled $0.567745 + frozen $0.528502 + available $3.903753 = $5.000000 of the initial $5.000000. Naive sum (every cost row incl. superseded) $1.618724 vs live (superseded_at IS NULL) $1.096247 \u2014 naive sum overstates +48% \u2014 must filter, not sum, chains."
  },
  "tile_auth_to_capture": {
    "rows": [
      {
        "service_name": "sapiom_blaxel",
        "n": 5,
        "p50_ms": -129,
        "p95_ms": -106
      },
      {
        "service_name": "sapiom_elevenlabs",
        "n": 5,
        "p50_ms": -146,
        "p95_ms": -128
      },
      {
        "service_name": "sapiom_fal",
        "n": 5,
        "p50_ms": -104,
        "p95_ms": -100
      },
      {
        "service_name": "sapiom_linkup",
        "n": 43,
        "p50_ms": -141,
        "p95_ms": -95
      },
      {
        "service_name": "sapiom_neon",
        "n": 14,
        "p50_ms": -129,
        "p95_ms": -105
      },
      {
        "service_name": "sapiom_openrouter",
        "n": 188,
        "p50_ms": 2028,
        "p95_ms": 8530
      },
      {
        "service_name": "unknown",
        "n": 5,
        "p50_ms": -118,
        "p95_ms": -104
      }
    ],
    "headline_service": "sapiom_openrouter",
    "headline_n": 188,
    "headline_p50_ms": 2028,
    "headline_p95_ms": 8530,
    "flat_n": 77,
    "flat_services_label": "sapiom_blaxel, sapiom_elevenlabs, sapiom_fal, sapiom_linkup, sapiom_neon, unknown",
    "flat_min_ms": -146,
    "flat_max_ms": -95,
    "footnote": "Flat single-row services show a small negative latency \u2014 the cost row is written as part of authorization itself, before authorizedAt is stamped, not a bug. Only chained/restated services (LLM calls) show genuine positive wait for final capture."
  },
  "tile_velocity_checks": {
    "flagged": [
      "fleet-test",
      "race-lat-agent-slowA20",
      "race-lat-agent-slowB50",
      "race-scale-agent-n10"
    ],
    "per_agent": [
      {
        "agent_name": "race-lat-agent-slowB50",
        "n": 51,
        "median_gap_s": 0.069,
        "peak_calls_per_min": 51,
        "peer_median_gap_s": 6.295999999999999,
        "runaway": true
      },
      {
        "agent_name": "race-lat-agent-slowA20",
        "n": 21,
        "median_gap_s": 0.069,
        "peak_calls_per_min": 21,
        "peer_median_gap_s": 6.295999999999999,
        "runaway": true
      },
      {
        "agent_name": "race-scale-agent-n10",
        "n": 11,
        "median_gap_s": 0.0695,
        "peak_calls_per_min": 11,
        "peer_median_gap_s": 6.295999999999999,
        "runaway": true
      },
      {
        "agent_name": "fleet-test",
        "n": 10,
        "median_gap_s": 0.076,
        "peak_calls_per_min": 10,
        "peer_median_gap_s": 6.295999999999999,
        "runaway": true
      },
      {
        "agent_name": "bounded-test-agent",
        "n": 39,
        "median_gap_s": 3.918,
        "peak_calls_per_min": 16,
        "peer_median_gap_s": 6.295999999999999,
        "runaway": false
      }
    ]
  },
  "tile_loss_rate": {
    "n_txns": 375,
    "n_failed": 6,
    "failed_pct": 1.6,
    "total_tpv_usd": 1.096247,
    "settled_loss_usd": 0.0,
    "frozen_holds_usd": 0.307212,
    "n_failed_with_frozen_hold": 4,
    "n_failed_pre_hold": 2,
    "loss_rate_pct": 0.0,
    "loss_rate_bps": 0.0,
    "n_failed_with_cost_row": 0,
    "note": "6/375 txns failed (1.6%); 0/6 settled a charge for the failed call \u2192 loss rate = 0 bps of TPV ($0.000000 settled loss). $0.307212 of holds FROZEN on 4 forced post-hold failures ($0.076803 each) \u2014 counted under the Frozen Capital hero, not as charged loss: totalBalance never moved, so nothing settled (dryrun/refund_watch.log). The other 2 (natural) failures died pre-hold \u2014 no cost row at all. Full queries + caveats: loss_rate.md.",
    "cross_reference": "0 bps counts settled charges only, across all 375 txns (organic fleet + adversarial experiments). Post-hold failures are NOT free: see Auth Reversal on Failure and the Frozen Capital hero \u2014 4 forced post-hold failures each froze their full hold ($0.307212 total), neither released nor settled."
  },
  "tile_auth_rate": {
    "approved": 289,
    "denied": 86,
    "auth_rate_pct": 77.06666666666668,
    "note": "100% only when no spending rules are active \u2014 this live snapshot includes 86 denials from governance experiments (see dryrun/denial_analytics.md / experiments/03_governance_cumulative_double_count.md). Real auth rate under those experiment rules \u2248 77%."
  },
  "tile_atv": {
    "atv_usd": 0.002175268199233716,
    "settled_volume_usd": 0.5677449999999999,
    "n_settled_txns": 261,
    "subline": "settled $0.567745 \u00f7 261 settled txns",
    "caption": "Card rails carry a fixed per-transaction fee component (on the order of $0.30 on typical US card pricing) \u2014 2\u20133 orders of magnitude above this ATV. Sub-cent transactions are the economic case for x402-style rails: agent spend is too small for card economics to process profitably.",
    "scope_note": "ATV is workload-shaped \u2014 this fleet's mix (LLM-dominated, incl. adversarial experiments) over one 83h window; not a market measurement.",
    "method_note": "ATV = settled volume \u00f7 settled txn count = $0.567745 / 261 = $0.002175. Settled volume reused from the TPV hero (live spend minus frozen holds). Settled txn = distinct transaction with a live cost row, excluding the 4 frozen-failure-hold txns (outcome='error', live, not part of a supersession chain) and the 85 denied-hold txns (status='denied')."
  },
  "tile_capital_overhang": {
    "overhang_ratio": 5.56982793117247,
    "overhang_ratio_all": 26.126462646264628,
    "sum_held_usd": 0.027838,
    "sum_settled_usd": 0.004998,
    "sum_held_usd_all": 0.522477,
    "sum_settled_usd_all": 0.019998,
    "definition": "held$ \u00f7 settled$ across all supersession chains \u2014 same chains as Capture Rate ($-weighted), inverse framing.",
    "clears_note": "Organic fleet 5.57x (headline) \u00b7 26.13x incl. adversarial experiments. Clears in 5.3\u201312.0s (organic) \u2014 not permanently parked capital.",
    "scope_note": "Scope: n=27 organic LLM chains (n=177 incl. adversarial experiments; sapiom_openrouter only, gpt-4o-mini) \u2014 LLM-specific, not platform-wide.",
    "method_note": "Organic: $0.027838 held / $0.004998 settled across 27 chains = 5.57x \u00b7 incl. adversarial experiments: $0.522477 / $0.019998 across 177 chains = 26.13x."
  },
  "tile_blast_radius": {
    "available": true,
    "headline_pct_range": "0\u201345% of cap",
    "definition": "Real spend an agent reaches before its cap denies it.",
    "finding": "Always less than the configured cap \u2014 the double-count (experiments/03) halves the effective budget, and one max_tokens hold \u2265 cap bricks the agent at $0.",
    "rows": [
      {
        "agent": "blast-test-500",
        "cap_usd": 0.002,
        "max_tokens": 500,
        "calls_before_stop": 9,
        "spend_before_stop_usd": 0.0009,
        "pct_of_cap": 45
      },
      {
        "agent": "blast-test-2000",
        "cap_usd": 0.002,
        "max_tokens": 2000,
        "calls_before_stop": 4,
        "spend_before_stop_usd": 0.0004,
        "pct_of_cap": 20
      },
      {
        "agent": "blast-test-8000",
        "cap_usd": 0.002,
        "max_tokens": 8000,
        "calls_before_stop": 0,
        "spend_before_stop_usd": 0.0,
        "pct_of_cap": 0
      }
    ],
    "caveat": "n=3 test agents, one $0.002 cap, LLM-only. blast-test agents read from the ledger (parallel session), corroborated by our own r5/doublecount runs."
  },
  "tile_cap_utilization": {
    "available": true,
    "headline_pct_range": "54\u201380%",
    "definition": "Spend \u00f7 budget at the moment the cap denies a call. (the credit-utilization analog)",
    "finding": "Agents are cut off at 54\u201380% of their real budget while the engine reports ~100% \u2014 the gap is the double-count (experiments/03).",
    "rows": [
      {
        "agent": "doublecount-confirm",
        "cap_usd": 0.004,
        "true_spend_usd": 0.002143,
        "true_util_pct": 54,
        "engine_util_pct": 100
      },
      {
        "agent": "blast-test-500",
        "cap_usd": 0.002,
        "true_spend_usd": 0.001202,
        "true_util_pct": 60,
        "engine_util_pct": 100
      },
      {
        "agent": "r5-boundary",
        "cap_usd": 0.005,
        "true_spend_usd": 0.003703,
        "true_util_pct": 74,
        "engine_util_pct": 100
      },
      {
        "agent": "blast-test-2000",
        "cap_usd": 0.002,
        "true_spend_usd": 0.001602,
        "true_util_pct": 80,
        "engine_util_pct": 100
      }
    ],
    "caveat": "n=4 test agents/rules, LLM-only. Engine-reported util is ~100% at denial (double-counted); true util is the real settled footprint \u00f7 cap."
  },
  "tile_effective_budget": {
    "headline_pct_range": "0\u201380% of cap",
    "message": "You set a cap; agents actually get 0\u201380% of it before denial.",
    "finding": "Agents cut off at 54\u201380% of true budget while the engine reports ~100% (the hold double-count); worst case one oversized max_tokens hold \u2265 cap bricks the agent at $0 before any spend.",
    "rows": [
      {
        "agent": "doublecount-confirm",
        "cap_usd": 0.004,
        "true_util_pct": 54,
        "engine_util_pct": 100
      },
      {
        "agent": "blast-test-500",
        "cap_usd": 0.002,
        "true_util_pct": 60,
        "engine_util_pct": 100
      },
      {
        "agent": "r5-boundary",
        "cap_usd": 0.005,
        "true_util_pct": 74,
        "engine_util_pct": 100
      },
      {
        "agent": "blast-test-2000",
        "cap_usd": 0.002,
        "true_util_pct": 80,
        "engine_util_pct": 100
      },
      {
        "agent": "blast-test-8000",
        "cap_usd": 0.002,
        "true_util_pct": 0,
        "engine_util_pct": 240
      }
    ],
    "caveat": "Cap utilization: n=4 test agents/rules, LLM-only. Engine-reported util is ~100% at denial (double-counted); true util is the real settled footprint \u00f7 cap. Blast radius: n=3 test agents, one $0.002 cap, LLM-only. blast-test agents read from the ledger (parallel session), corroborated by our own r5/doublecount runs.",
    "method_note": "True/engine util rows reused verbatim from Cap Utilization (54\u201380%, n=4). Bricked row reused from Blast Radius (blast-test-8000: cap $0.002, spend at denial $0.0000 = 0% true util; engine util = hold $0.004802 \u00f7 cap $0.002 = 240%, per experiments/03_governance_cumulative_double_count.md). Range 0\u201380% = min/max true_util_pct across all 5 rows."
  },
  "tile_concurrency_leak_factor": {
    "headline": "up to 3x",
    "definition": "Where Effective Budget shows the cap firing too early (agents cut off before they reach it), this is the opposite failure: under concurrent fire, the same kind of cap lets MORE calls through than it was sized for \u2014 the bound breaks instead of over-triggering.",
    "subline": "A cap sized for ONE call allowed 2 of 20 and 3 of 50 under concurrent fire \u2014 authorization checks race a stale cumulative ledger.",
    "rows": [
      {
        "round": "FAST",
        "n": 10,
        "max_tokens": 500,
        "allowed": 1,
        "denied": 9,
        "leak_factor": 1
      },
      {
        "round": "SLOW-A",
        "n": 20,
        "max_tokens": 8000,
        "allowed": 2,
        "denied": 18,
        "leak_factor": 2
      },
      {
        "round": "SLOW-B",
        "n": 50,
        "max_tokens": 4000,
        "allowed": 3,
        "denied": 47,
        "leak_factor": 3
      }
    ],
    "caveat": "One trial per round \u2014 TOCTOU races are probabilistic, not a measured rate at a given N/max_tokens. Leak confirmed two ways per round: the rule engine's own per-transaction decision AND client-side HTTP 200s (exact match in both SLOW rounds \u2014 real money authorized through, not a counting artifact). Mechanism identified (completedAt spread across the concurrent batch, tracking N at least as tightly as max_tokens); magnitude is small (2\u20133x) and scales with concurrency, not a large blowout.",
    "method_note": "FAST: N=10, max_tokens=500 (dryrun/toctou_scale_experiment.md), 1 allowed / 9 denied, leak 1x (dryrun/toctou_scale_result.json corrected_allowed_count/corrected_denied_count/corrected_leak_factor). SLOW-A: N=20, max_tokens=8000, 2 allowed / 18 denied, leak 2x (dryrun/toctou_latency_slowA20_result.json). SLOW-B: N=50, max_tokens=4000, 3 allowed / 47 denied, leak 3x (dryrun/toctou_latency_slowB50_result.json). Mechanism + verdict: dryrun/toctou_latency_experiment.md; summarized analysis/findings.md \u00a78."
  },
  "tile_ledger_blind_spots": {
    "total": 375,
    "blind_txns": 94,
    "pct": 25.066666666666666,
    "n_denied_no_outcome": 86,
    "n_zombies": 2,
    "n_unknown_service": 6,
    "n_scraping_total": 5,
    "n_scraping_unknown": 5,
    "n_unknown_other": 1,
    "pct_scraping_rev_unknown": 100.0,
    "definition": "% of ALL transactions the ledger cannot fully explain \u2014 outcome never written, or service resolved to 'unknown'. Denials are also counted by Authorization Rate (Section 1) \u2014 that tile measures approval; this one measures record quality.",
    "subline": "86 denied \u2014 no outcome ever written \u00b7 6 service='unknown' (100% of the scraping service's revenue, 5/5 calls + 1 pre-gateway failure) \u00b7 2 zombies (authorized, never completed)",
    "method_note": "blind = COUNT(DISTINCT txns WHERE outcome IS NULL OR service_name='unknown') \u00f7 COUNT(*) txns = (86 denied-no-outcome + 2 zombie-no-outcome + 6 service='unknown', no overlap between the two groups in this data) = 94/375 = 25.1%. Supersedes the old 'Attribution Completeness' check (agent+traceId+service+outcome all non-null), which counted service_name='unknown' as a populated value \u2014 it certified 6 unresolved rows as 'complete'. Metric renamed/redefined 2026-07-07 to close that gap."
  },
  "tile_phantom_spend_rate": {
    "overstatement_pct": 47.66051811316245,
    "naive_sum_usd": 1.618724,
    "live_sum_usd": 1.096247,
    "definition": "Naive sum of every cost row vs. live (non-superseded) spend.",
    "method_note": "Reconciled against the live snapshot ingested through 2026-07-07 16:00:34.005000. initial $5.000000 \u2212 Sum active cost rows $1.096247 = $3.903753 = availableBalance (diff $0.000000). totalBalance $4.432255 is higher by $0.528502 = frozen holds (gap to totalBalance = $0.528502 \u2014 matches Frozen Capital exactly). Wallet partition (full precision): settled $0.567745 + frozen $0.528502 + available $3.903753 = $5.000000 of the initial $5.000000. Naive sum (every cost row incl. superseded) $1.618724 vs live (superseded_at IS NULL) $1.096247 \u2014 naive sum overstates +48% \u2014 must filter, not sum, chains."
  },
  "tile_cost_per_task_traceability": {
    "total_txns": 375,
    "traced_txns": 6,
    "pct_txns": 1.6,
    "total_live_usd": 1.096247,
    "traced_live_usd": 0.0242,
    "pct_dollars": 2.207531696780014,
    "headline": "2% of spend traceable to a task",
    "definition": "The ledger sees calls, not jobs.",
    "subline": "Only 6 of 375 txns carry a task id \u2014 \"what did this task cost end-to-end?\" is unanswerable for the rest.",
    "caption": "Traces are flat grouping IDs today, no parent/child hierarchy \u2014 task-level cost attribution needs span hierarchy in x402 metadata.",
    "method_note": "txn share: COUNT(trace_external_id IS NOT NULL) \u00f7 COUNT(*) = 6/375 = 1.6%. $ share: SUM(fiat_amount WHERE superseded_at IS NULL AND trace_external_id IS NOT NULL) \u00f7 SUM(fiat_amount WHERE superseded_at IS NULL) = $0.024200/$1.096247 = 2.2%."
  },
  "tile_hold_release_latency": {
    "p50_ms": 5295,
    "p95_ms": 11961,
    "n": 31,
    "p50_ms_all": 2028,
    "p95_ms_all": 8530,
    "n_all": 188,
    "service": "sapiom_openrouter",
    "n_frozen_holds": 89,
    "n_frozen_released": 0,
    "days_observed": 3,
    "definition": "p50/p95 time from hold to final capture (chained services only).",
    "subline": "released in seconds when calls settle \u00b7 NEVER observed released on failure or denial",
    "caption": "89 holds on failed/denied calls, 0 released in 3 days and counting (refund_watch.log)",
    "scope_note": "Scope: sapiom_openrouter only \u2014 organic fleet n=31 (headline); incl. adversarial experiments n=188: 2.0s/8.5s p50/p95. gpt-4o-mini \u2014 LLM-specific, not platform-wide."
  },
  "tile_refund_on_failure": {
    "n_failed": 2,
    "n_failed_with_hold": 0,
    "n_failed_total": 6,
    "n_failed_with_cost_row_total": 4,
    "n_failed_forced_with_hold": 4,
    "direct_test_n": 4,
    "direct_test_retained": 4,
    "direct_test_retention_rate_pct": 100.0,
    "direct_test_mean_retained_usd": 0.076803,
    "definition": "In card payments, an uncaptured authorization is released via authorization reversal (void). Measured here: % of a hold reversed vs. retained/frozen when a call fails after the hold is placed.",
    "subline": "100% of hold retained/frozen on post-hold failure (4/4 forced trials) \u2014 an auth-reversal rate of 0%",
    "note": "In-sample: 4/6 failed txns hold a cost row \u2014 the 4 with holds are the FORCED failure-capture experiments (failure-capture-n3-*, hold-ext-test; their $0.076803 frozen holds are the direct test below), while the 2 natural failures died pre-hold, so nothing was ever held or charged (loss_rate.md). Direct test: when a hold DOES exist and the call then errors, 4/4 forced trials show the hold RETAINED/FROZEN \u2014 availableBalance dropped by exactly $0.076803 each time (zero variance) while totalBalance never moved, so this is not a completed charge, and it is never reversed either \u2014 an auth-reversal rate of 0% (findings.md \u00a79; dryrun/failure_capture_n3.md; dryrun/hold_linearity_extension.md; dryrun/refund_watch.log \u2014 still being watched for a delayed release). Over-requested max_tokens makes the frozen amount larger. Honest caveat: the per-failure retention mechanic is deterministic and measured (4/4) \u2014 the FLEET FREQUENCY of post-hold failures in live traffic is NOT measured; do not read this as a $/day loss rate."
  },
  "tile_hold_recovery": {
    "p50_ms": 5295,
    "p95_ms": 11961,
    "n_holds": 89,
    "days_observed": 3,
    "reversal_pct": 0.0,
    "definition": "In card payments an uncaptured authorization is released via authorization reversal (void). No such mechanism observed here.",
    "subline": "released in seconds when calls settle \u00b7 0% ever reversed on failure or denial \u2014 89 holds frozen, 3 days and counting",
    "caption": "4/4 forced trials retained (mean $0.076803, zero variance) \u2014 availableBalance dropped, totalBalance never moved (frozen, not charged). Per-failure mechanic measured; fleet frequency of post-hold failures in live traffic NOT measured.",
    "scope_note": "Scope: sapiom_openrouter only \u2014 organic n=31 headline (5.3s/12.0s); all-traffic n=188 (2.0s/8.5s) \u2014 LLM-specific (gpt-4o-mini), not platform-wide.",
    "method_note": "Hold-release latency (organic n=31, p50 5295ms / p95 11961ms; all-traffic n=188, p50 2028ms / p95 8530ms): 89 holds on failed/denied calls, 0 released in 3 days and counting (refund_watch.log) Auth reversal on failure: In-sample: 4/6 failed txns hold a cost row \u2014 the 4 with holds are the FORCED failure-capture experiments (failure-capture-n3-*, hold-ext-test; their $0.076803 frozen holds are the direct test below), while the 2 natural failures died pre-hold, so nothing was ever held or charged (loss_rate.md). Direct test: when a hold DOES exist and the call then errors, 4/4 forced trials show the hold RETAINED/FROZEN \u2014 availableBalance dropped by exactly $0.076803 each time (zero variance) while totalBalance never moved, so this is not a completed charge, and it is never reversed either \u2014 an auth-reversal rate of 0% (findings.md \u00a79; dryrun/failure_capture_n3.md; dryrun/hold_linearity_extension.md; dryrun/refund_watch.log \u2014 still being watched for a delayed release). Over-requested max_tokens makes the frozen amount larger. Honest caveat: the per-failure retention mechanic is deterministic and measured (4/4) \u2014 the FLEET FREQUENCY of post-hold failures in live traffic is NOT measured; do not read this as a $/day loss rate."
  },
  "tile_refunds_disputes": {
    "lock_tag": "NO MECHANISM EXISTS",
    "definition": "Post-settlement recovery. Card rails: refund APIs + chargeback/dispute processes (Visa monitors dispute rates network-wide). Agent rails: when an agent pays for a bad result, no refund API, no dispute flow, no adjudication path exists \u2014 the money is unrecoverable by design, not by failure.",
    "caption": "Completes the lifecycle with Hold Recovery: pre-settlement money never comes back on failure; post-settlement money can't come back even in principle."
  },
  "kya_scorecard": {
    "rows": [
      {
        "agent_name": "fleet-test",
        "spend_usd": 0.001,
        "n_calls": 10,
        "median_gap_s": 0.076,
        "peak_calls_per_min": 10,
        "runaway": true,
        "velocity_score": 90,
        "velocity_grade": "F"
      },
      {
        "agent_name": "race-lat-agent-slowA20",
        "spend_usd": 0.086754,
        "n_calls": 21,
        "median_gap_s": 0.069,
        "peak_calls_per_min": 21,
        "runaway": true,
        "velocity_score": 90,
        "velocity_grade": "F"
      },
      {
        "agent_name": "race-lat-agent-slowB50",
        "spend_usd": 0.113341,
        "n_calls": 51,
        "median_gap_s": 0.069,
        "peak_calls_per_min": 51,
        "runaway": true,
        "velocity_score": 90,
        "velocity_grade": "F"
      },
      {
        "agent_name": "race-scale-agent-n10",
        "spend_usd": 0.002927,
        "n_calls": 11,
        "median_gap_s": 0.0695,
        "peak_calls_per_min": 11,
        "runaway": true,
        "velocity_score": 90,
        "velocity_grade": "F"
      },
      {
        "agent_name": "blast-test-500",
        "spend_usd": 0.001202,
        "n_calls": 10,
        "median_gap_s": 4.008,
        "peak_calls_per_min": 10,
        "runaway": false,
        "velocity_score": 30,
        "velocity_grade": "C"
      },
      {
        "agent_name": "bounded-test-agent",
        "spend_usd": 0.0038,
        "n_calls": 39,
        "median_gap_s": 3.918,
        "peak_calls_per_min": 16,
        "runaway": false,
        "velocity_score": 30,
        "velocity_grade": "C"
      },
      {
        "agent_name": "doublecount-fast",
        "spend_usd": 0.001202,
        "n_calls": 10,
        "median_gap_s": 5.778,
        "peak_calls_per_min": 10,
        "runaway": false,
        "velocity_score": 30,
        "velocity_grade": "C"
      },
      {
        "agent_name": "doublecount-slow",
        "spend_usd": 0.001202,
        "n_calls": 10,
        "median_gap_s": 3.655,
        "peak_calls_per_min": 10,
        "runaway": false,
        "velocity_score": 30,
        "velocity_grade": "C"
      },
      {
        "agent_name": "ll-validation-agent",
        "spend_usd": 0.0024,
        "n_calls": 24,
        "median_gap_s": 2.5,
        "peak_calls_per_min": 24,
        "runaway": false,
        "velocity_score": 30,
        "velocity_grade": "C"
      },
      {
        "agent_name": "survey-neon-n10",
        "spend_usd": 1e-05,
        "n_calls": 20,
        "median_gap_s": 7.557,
        "peak_calls_per_min": 14,
        "runaway": false,
        "velocity_score": 30,
        "velocity_grade": "C"
      },
      {
        "agent_name": "spend-runaway",
        "spend_usd": 0.15,
        "n_calls": 25,
        "median_gap_s": 7.983499999999999,
        "peak_calls_per_min": 9,
        "runaway": false,
        "velocity_score": 27,
        "velocity_grade": "C"
      },
      {
        "agent_name": "survey-data",
        "spend_usd": 0.001003,
        "n_calls": 13,
        "median_gap_s": 2.2115,
        "peak_calls_per_min": 9,
        "runaway": false,
        "velocity_score": 27,
        "velocity_grade": "C"
      },
      {
        "agent_name": "doublecount-confirm-agent",
        "spend_usd": 0.002143,
        "n_calls": 20,
        "median_gap_s": 8.435,
        "peak_calls_per_min": 8,
        "runaway": false,
        "velocity_score": 24,
        "velocity_grade": "B"
      },
      {
        "agent_name": "ladder-usage-replicate",
        "spend_usd": 0.0014,
        "n_calls": 14,
        "median_gap_s": 6.524,
        "peak_calls_per_min": 7,
        "runaway": false,
        "velocity_score": 21,
        "velocity_grade": "B"
      },
      {
        "agent_name": "r5-boundary-agent",
        "spend_usd": 0.003703,
        "n_calls": 14,
        "median_gap_s": 8.551,
        "peak_calls_per_min": 7,
        "runaway": false,
        "velocity_score": 21,
        "velocity_grade": "B"
      },
      {
        "agent_name": "blast-test-2000",
        "spend_usd": 0.001602,
        "n_calls": 5,
        "median_gap_s": 4.577999999999999,
        "peak_calls_per_min": 5,
        "runaway": false,
        "velocity_score": 15,
        "velocity_grade": "B"
      },
      {
        "agent_name": "hold-ext-test",
        "spend_usd": 0.077103,
        "n_calls": 4,
        "median_gap_s": 7.976,
        "peak_calls_per_min": 4,
        "runaway": false,
        "velocity_score": 12,
        "velocity_grade": "B"
      },
      {
        "agent_name": "spend-researcher",
        "spend_usd": 0.072,
        "n_calls": 12,
        "median_gap_s": 18.789,
        "peak_calls_per_min": 4,
        "runaway": false,
        "velocity_score": 12,
        "velocity_grade": "B"
      },
      {
        "agent_name": "survey-blaxel",
        "spend_usd": 0.00276,
        "n_calls": 4,
        "median_gap_s": 4.661,
        "peak_calls_per_min": 4,
        "runaway": false,
        "velocity_score": 12,
        "velocity_grade": "B"
      },
      {
        "agent_name": "survey-fal",
        "spend_usd": 0.012,
        "n_calls": 4,
        "median_gap_s": 6.068,
        "peak_calls_per_min": 4,
        "runaway": false,
        "velocity_score": 12,
        "velocity_grade": "B"
      },
      {
        "agent_name": "survey-scrape",
        "spend_usd": 0.036,
        "n_calls": 4,
        "median_gap_s": 5.99,
        "peak_calls_per_min": 4,
        "runaway": false,
        "velocity_score": 12,
        "velocity_grade": "B"
      },
      {
        "agent_name": "cap-test",
        "spend_usd": 0.0003,
        "n_calls": 3,
        "median_gap_s": 8.8155,
        "peak_calls_per_min": 3,
        "runaway": false,
        "velocity_score": 9,
        "velocity_grade": "A"
      },
      {
        "agent_name": "chain-task",
        "spend_usd": 0.0242,
        "n_calls": 6,
        "median_gap_s": 7.955,
        "peak_calls_per_min": 3,
        "runaway": false,
        "velocity_score": 9,
        "velocity_grade": "A"
      },
      {
        "agent_name": "holdtest-agent-hvs",
        "spend_usd": 0.009712,
        "n_calls": 6,
        "median_gap_s": 61.019,
        "peak_calls_per_min": 3,
        "runaway": false,
        "velocity_score": 9,
        "velocity_grade": "A"
      },
      {
        "agent_name": "scale-test",
        "spend_usd": 0.0003,
        "n_calls": 3,
        "median_gap_s": 6.9755,
        "peak_calls_per_min": 3,
        "runaway": false,
        "velocity_score": 9,
        "velocity_grade": "A"
      },
      {
        "agent_name": "spend-writer",
        "spend_usd": 0.00291,
        "n_calls": 10,
        "median_gap_s": 23.046,
        "peak_calls_per_min": 3,
        "runaway": false,
        "velocity_score": 9,
        "velocity_grade": "A"
      },
      {
        "agent_name": "survey-audio",
        "spend_usd": 0.2232,
        "n_calls": 4,
        "median_gap_s": 6.545,
        "peak_calls_per_min": 3,
        "runaway": false,
        "velocity_score": 9,
        "velocity_grade": "A"
      },
      {
        "agent_name": "blast-test-8000",
        "spend_usd": 0.004802,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "dryrun-researcher",
        "spend_usd": 0.006,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "estimate-test",
        "spend_usd": 0.000972,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "failure-capture-n3-1",
        "spend_usd": 0.076803,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "failure-capture-n3-2",
        "spend_usd": 0.076803,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "failure-capture-n3-3",
        "spend_usd": 0.076803,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "r3-idem-agent",
        "spend_usd": 0.0001,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-audio",
        "spend_usd": 0.001,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-compute",
        "spend_usd": 0.00069,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-data",
        "spend_usd": 0.0,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-images",
        "spend_usd": 0.003,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-llm",
        "spend_usd": 0.0001,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-scraping",
        "spend_usd": 0.009,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      },
      {
        "agent_name": "sweep-search",
        "spend_usd": 0.006,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "velocity_score": null,
        "velocity_grade": "N/A"
      }
    ],
    "visible_caveat": "Illustrative \u2014 velocity-only, one session; spend is shown but not a factor in this grade.",
    "formula_compact": "score = 60 if peer-flagged + peak-burst\u00d73 (max 30) \u2192 A \u22649 \u00b7 B \u226424 \u00b7 C \u226449 \u00b7 D \u226474 \u00b7 F \u226575 \u00b7 <3 calls = N/A",
    "formula_note": "Velocity score = 60 pts if peer-relative velocity anomaly flagged (findings.md \u00a75) + up to 30 pts scaled from peak calls in any 60s window (peak x 3, capped). Grade: A 0-9 / B 10-24 / C 25-49 / D 50-74 / F 75-100. Agents with <3 calls show N/A \u2014 not enough data for a median gap. Spend is NOT part of this score (spend-runaway is ~54% of all TPV and grades C; fleet-test is ~0.4% of TPV and grades F) \u2014 velocity-only, illustrative, one session."
  }
};
