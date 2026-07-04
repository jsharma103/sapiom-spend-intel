window.DASHBOARD_DATA = {
  "generated_at": "2026-07-04T16:30:53.740505+00:00",
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
    "scale_note": "at $1M/day TPV \u2192 $4.57M customer capital frozen daily",
    "frozen_at_scale_usd": 4569827.931172469,
    "method_note": "Sigma settled (0.004998) / Sigma held (0.027838) dollar-weighted across all 27 supersession chains (hold \u2192 final capture)."
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
    "linkup": {
      "service_label": "Linkup search",
      "sapiom_price_usd": 0.006,
      "public_price_usd": 0.005,
      "markup_pct": 20.0,
      "n_calls": 43
    },
    "openrouter": {
      "service_label": "OpenRouter LLM (gpt-4o-mini, settled avg)",
      "sapiom_price_usd": 0.00018651612903225806,
      "public_price_usd": null,
      "markup_pct": null,
      "n_calls": 31
    },
    "note": "Linkup is flat per-call both sides (apples-to-apples): Sapiom $0.006 vs public $0.005 -> +20%. OpenRouter has no clean per-call comparison (no token-usage field in this ledger to price against OpenRouter's public per-token rate) \u2014 shown for reference, markup n/a."
  }
};
