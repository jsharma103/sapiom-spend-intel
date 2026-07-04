window.DASHBOARD_DATA = {
  "generated_at": "2026-07-04T18:02:11.779363+00:00",
  "header": {
    "n_txns": 81,
    "n_agents": 16,
    "live_spend_usd": 0.277472,
    "period_start": "2026-07-04 04:51:39.614000",
    "period_end": "2026-07-04 11:06:35.634000"
  },
  "hero_tpv": {
    "value_usd": 0.277472,
    "n_txns": 81,
    "n_agents": 16,
    "period_hours": 6.248894444444445,
    "daily_rate_usd": 1.0656809871257225,
    "scale_multiple_to_1m_day": 938367.1211936768,
    "subline": "81 txns \u00b7 16 agents \u00b7 live spend",
    "scale_note": "at $1M/day TPV \u2192 ~938,367x tonight's pace, same pipeline",
    "method_note": "Tonight's fleet ran at a ~$1.07/day pace over 81 txns / 16 agents; scale multiple = $1M/day / that rate."
  },
  "hero_capture_ratio": {
    "ratio_pct": 17.953875996838853,
    "sum_held_usd": 0.027838,
    "sum_settled_usd": 0.004998,
    "n_chains": 27,
    "subline": "authorize $1.00 \u2192 capture $0.18",
    "scale_note": "instantaneously frozen \u2248 $61\u2013$138 at $1M/day TPV (Little's Law; holds clear in 5.3\u201312.0s) \u2014 lever = hold-lifetime & max_tokens right-sizing",
    "instantaneous_frozen_p50_usd": 61.284722222222214,
    "instantaneous_frozen_p95_usd": 138.4375,
    "hold_lifetime_p50_s": 5.295,
    "hold_lifetime_p95_s": 11.961,
    "naive_flow_at_scale_usd": 4569827.931172469,
    "method_note": "Sigma settled (0.004998) / Sigma held (0.027838) dollar-weighted across all 27 supersession chains (hold \u2192 final capture). Little's Law: frozen$ = held$/day \u00d7 (hold_lifetime_sec / 86400) \u2014 at $1M/day TPV, p50 (5.29s) \u2192 $61.28, p95 (11.96s) \u2192 $138.44. Full derivation + sensitivity: dryrun/float_model.md. (Superseded framing: naively scaling the capture ratio gives $4,569,828 \u2014 a per-day FLOW, not an instantaneous stock; it implicitly assumes a ~4.57-day hold lifetime vs. the measured 5.3-12.0s, ~33,000x off. See float_model.md \u00a74d.)"
  },
  "hero_reconciliation": {
    "diff_usd": 0.0,
    "green": true,
    "naive_sum_usd": 0.30531,
    "live_sum_usd": 0.277472,
    "overstatement_pct": 10.032724022604082,
    "subline": "naive sum overstates +10% \u2014 must filter, not sum, chains",
    "scale_note": "at $1M/day TPV \u2192 ~$100K/day phantom spend if uncorrected",
    "phantom_at_scale_usd": 100327.24022604081,
    "method_note": "Latest balance snapshot vs (initial balance \u2212 live spend): diff $0.000000. Naive = every cost row including superseded holds ($0.305310); live = superseded_at IS NULL only ($0.277472)."
  },
  "tile_auth_to_capture": {
    "rows": [
      {
        "service_name": "sapiom_blaxel",
        "n": 1,
        "p50_ms": -832,
        "p95_ms": -832
      },
      {
        "service_name": "sapiom_elevenlabs",
        "n": 1,
        "p50_ms": -142,
        "p95_ms": -142
      },
      {
        "service_name": "sapiom_fal",
        "n": 1,
        "p50_ms": -520,
        "p95_ms": -520
      },
      {
        "service_name": "sapiom_linkup",
        "n": 43,
        "p50_ms": -141,
        "p95_ms": -95
      },
      {
        "service_name": "sapiom_openrouter",
        "n": 31,
        "p50_ms": 5295,
        "p95_ms": 11961
      },
      {
        "service_name": "unknown",
        "n": 1,
        "p50_ms": -128,
        "p95_ms": -128
      }
    ],
    "headline_service": "sapiom_openrouter",
    "headline_p50_ms": 5295,
    "headline_p95_ms": 11961,
    "flat_n": 47,
    "flat_services_label": "sapiom_blaxel, sapiom_elevenlabs, sapiom_fal, sapiom_linkup, unknown",
    "footnote": "Flat single-row services show a small negative latency \u2014 the cost row is written as part of authorization itself, before authorizedAt is stamped, not a bug. Only chained/restated services (LLM calls) show genuine positive wait for final capture."
  },
  "tile_velocity_checks": {
    "flagged": [
      "fleet-test"
    ],
    "per_agent": [
      {
        "agent_name": "fleet-test",
        "n": 10,
        "median_gap_s": 0.076,
        "peak_calls_per_min": 10,
        "peer_median_gap_s": 8.3995,
        "runaway": true
      },
      {
        "agent_name": "spend-runaway",
        "n": 25,
        "median_gap_s": 7.983499999999999,
        "peak_calls_per_min": 9,
        "peer_median_gap_s": 8.38525,
        "runaway": false
      },
      {
        "agent_name": "spend-researcher",
        "n": 12,
        "median_gap_s": 18.789,
        "peak_calls_per_min": 4,
        "peer_median_gap_s": 7.96925,
        "runaway": false
      },
      {
        "agent_name": "spend-writer",
        "n": 10,
        "median_gap_s": 23.046,
        "peak_calls_per_min": 3,
        "peer_median_gap_s": 7.96925,
        "runaway": false
      },
      {
        "agent_name": "chain-task",
        "n": 6,
        "median_gap_s": 7.955,
        "peak_calls_per_min": 3,
        "peer_median_gap_s": 8.3995,
        "runaway": false
      }
    ]
  },
  "tile_take_rate": {
    "rows": [
      {
        "service": "search",
        "provider": "Linkup",
        "operation": "1 query, standard depth, sourcedAnswer",
        "sapiom_price_usd": 0.006,
        "public_price_usd": 0.006,
        "markup_pct": 0.0,
        "confidence": "HIGH"
      },
      {
        "service": "llm",
        "provider": "OpenRouter (gpt-4o-mini)",
        "operation": "14 prompt + 2 completion tokens",
        "sapiom_price_usd": 0.0001,
        "public_price_usd": 3.2999999999999997e-06,
        "markup_pct": 2930.303030303031,
        "confidence": "HIGH"
      },
      {
        "service": "images",
        "provider": "Fal.ai (flux/schnell)",
        "operation": "1 image, 512x512 (1MP billed)",
        "sapiom_price_usd": 0.003,
        "public_price_usd": 0.003,
        "markup_pct": 0.0,
        "confidence": "HIGH"
      },
      {
        "service": "audio",
        "provider": "ElevenLabs (multilingual v2)",
        "operation": "text-to-speech, 3 characters",
        "sapiom_price_usd": 0.001,
        "public_price_usd": 0.00030000000000000003,
        "markup_pct": 233.33333333333331,
        "confidence": "HIGH"
      }
    ],
    "blended_take_rate_pct": 7.888118811881196,
    "blended_take_rate_bps": 788.8118811881195,
    "blended_markup_pct": 8.563627959971203,
    "blended_markup_bps": 856.3627959971203,
    "n_high_rows": 4,
    "note": "9-service sweep (dryrun/service_sweep_result.json), full table + MED/DROP rows + sources in take_rate.md. Blended take rate is dollar-weighted margin / Sapiom-charged TPV across the 4 HIGH-confidence rows only (search, llm, images, audio); scraping (MED, vendor plan tier unknown) and compute (DROP, memory tier undisclosed) are excluded from this dashboard tile."
  },
  "tile_loss_rate": {
    "n_txns": 81,
    "n_failed": 2,
    "failed_pct": 2.4691358024691357,
    "total_tpv_usd": 0.277472,
    "failed_tpv_usd": 0.0,
    "loss_rate_pct": 0.0,
    "loss_rate_bps": 0.0,
    "n_failed_with_cost_row": 0,
    "note": "2/81 txns failed (2.5%) but 0/2 produced a cost row \u2014 Sapiom did not charge for either failure in this sample (both were pre-settlement client/gateway errors, not mid-flight failures after a hold). Loss rate = 0 bps of TPV. Full queries + caveats: loss_rate.md."
  },
  "tile_auth_rate": {
    "approved": 81,
    "denied": 0,
    "auth_rate_pct": 100.0,
    "note": "No spending rules were active in this sample \u2014 100% reflects an unconfigured account (nothing to deny), not proof governance works. Full distribution + caveat: findings.md \u00a77."
  },
  "tile_capital_overhang": {
    "overhang_ratio": 5.56982793117247,
    "sum_held_usd": 0.027838,
    "sum_settled_usd": 0.004998,
    "definition": "held$ \u00f7 settled$ across all supersession chains \u2014 same chains as Capture Ratio, inverse framing.",
    "method_note": "$0.027838 held / $0.004998 settled across 27 chains = 5.57x."
  },
  "tile_blast_radius": {
    "available": false,
    "definition": "Max spend one agent reaches before a cap stops it.",
    "note": "Needs governance rules active \u2014 no spending rule was configured in this sample (BACKLOG #8, [HUMAN-UI])."
  },
  "tile_cap_utilization": {
    "available": false,
    "definition": "Spend \u00f7 budget, per agent.",
    "note": "Needs governance rules active \u2014 no per-agent budget exists without a spending rule configured."
  },
  "tile_attribution_completeness": {
    "complete": 81,
    "total": 81,
    "pct": 100.0,
    "n_unknown_service": 2,
    "definition": "% of txns with agent, traceId, service, outcome all populated.",
    "note": "81/81 txns have all 4 fields non-null (100%), but 2/81 carry service_name='unknown' \u2014 present, but an unresolved value, so non-null isn't always meaningfully attributed. Noted, not hidden."
  },
  "tile_phantom_spend_rate": {
    "overstatement_pct": 10.032724022604082,
    "naive_sum_usd": 0.30531,
    "live_sum_usd": 0.277472,
    "definition": "Naive sum of every cost row vs. live (non-superseded) spend.",
    "method_note": "Latest balance snapshot vs (initial balance \u2212 live spend): diff $0.000000. Naive = every cost row including superseded holds ($0.305310); live = superseded_at IS NULL only ($0.277472)."
  },
  "tile_hold_release_latency": {
    "p50_ms": 5295,
    "p95_ms": 11961,
    "service": "sapiom_openrouter",
    "definition": "p50/p95 time from hold to final capture (chained services only)."
  },
  "tile_refund_on_failure": {
    "n_failed": 2,
    "n_failed_with_hold": 0,
    "definition": "% of failed calls whose hold was fully released.",
    "note": "0/2 failed calls ever produced a cost row \u2014 neither did (loss_rate.md): no hold was placed on either failure, so there's nothing to release. Vacuous in this sample, not 0% or 100% \u2014 becomes real once a call fails after a hold is placed (BACKLOG's mid-flight-failure experiment, not yet run)."
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
        "risk_score": 90,
        "grade": "F"
      },
      {
        "agent_name": "spend-runaway",
        "spend_usd": 0.15,
        "n_calls": 25,
        "median_gap_s": 7.983499999999999,
        "peak_calls_per_min": 9,
        "runaway": false,
        "risk_score": 27,
        "grade": "C"
      },
      {
        "agent_name": "spend-researcher",
        "spend_usd": 0.072,
        "n_calls": 12,
        "median_gap_s": 18.789,
        "peak_calls_per_min": 4,
        "runaway": false,
        "risk_score": 12,
        "grade": "B"
      },
      {
        "agent_name": "cap-test",
        "spend_usd": 0.0003,
        "n_calls": 3,
        "median_gap_s": 8.8155,
        "peak_calls_per_min": 3,
        "runaway": false,
        "risk_score": 9,
        "grade": "A"
      },
      {
        "agent_name": "chain-task",
        "spend_usd": 0.0242,
        "n_calls": 6,
        "median_gap_s": 7.955,
        "peak_calls_per_min": 3,
        "runaway": false,
        "risk_score": 9,
        "grade": "A"
      },
      {
        "agent_name": "scale-test",
        "spend_usd": 0.0003,
        "n_calls": 3,
        "median_gap_s": 6.9755,
        "peak_calls_per_min": 3,
        "runaway": false,
        "risk_score": 9,
        "grade": "A"
      },
      {
        "agent_name": "spend-writer",
        "spend_usd": 0.00291,
        "n_calls": 10,
        "median_gap_s": 23.046,
        "peak_calls_per_min": 3,
        "runaway": false,
        "risk_score": 9,
        "grade": "A"
      },
      {
        "agent_name": "dryrun-researcher",
        "spend_usd": 0.006,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "estimate-test",
        "spend_usd": 0.000972,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-audio",
        "spend_usd": 0.001,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-compute",
        "spend_usd": 0.00069,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-data",
        "spend_usd": 0.0,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-images",
        "spend_usd": 0.003,
        "n_calls": 2,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-llm",
        "spend_usd": 0.0001,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-scraping",
        "spend_usd": 0.009,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      },
      {
        "agent_name": "sweep-search",
        "spend_usd": 0.006,
        "n_calls": 1,
        "median_gap_s": null,
        "peak_calls_per_min": null,
        "runaway": false,
        "risk_score": null,
        "grade": "N/A"
      }
    ],
    "formula_note": "Risk score = 60 pts if peer-relative velocity anomaly flagged (findings.md \u00a75) + up to 30 pts scaled from peak calls in any 60s window (peak x 3, capped). Grade: A 0-9 / B 10-24 / C 25-49 / D 50-74 / F 75-100. Agents with <3 calls show N/A \u2014 not enough data for a median gap."
  }
};
