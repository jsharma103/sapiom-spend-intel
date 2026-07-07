# Sapiom Trace-Path Mining

Free — groups transactions by `trace_external_id` (populated by BUILD 3's chaining experiment; requires it to have run at least once). Zero spend, `spend.duckdb` only.

## Overview

- Traces (distinct `trace_external_id`): **2**
- Total steps across all traces: **6**
- Total cost across all traces: **$0.024200**

## Path frequency (prefix-tree over service-name sequences)

| Path | Count |
|---|---|
| `sapiom_linkup -> sapiom_openrouter -> sapiom_linkup` | 2 |

Only one distinct path observed across 2 trace(s) — sample too small yet for meaningful path-diversity analysis. The mining logic above is written to scale to many distinct paths; re-run after more chained-task variety exists.

### Dominant path, visualized

<svg xmlns="http://www.w3.org/2000/svg" width="590" height="80" style="background:#0b0e14;font-family:monospace"><rect x="10" y="20" width="150" height="40" rx="6" fill="#131722" stroke="#5b8ff9" stroke-width="1.5"/><text x="85.0" y="45.0" fill="#e6e9f0" font-size="12" text-anchor="middle">sapiom_linkup</text><line x1="160" y1="40.0" x2="212" y2="40.0" stroke="#8a92a6" stroke-width="1.5"/><polygon points="212,36.0 220,40.0 212,44.0" fill="#8a92a6"/><rect x="220" y="20" width="150" height="40" rx="6" fill="#131722" stroke="#5b8ff9" stroke-width="1.5"/><text x="295.0" y="45.0" fill="#e6e9f0" font-size="12" text-anchor="middle">sapiom_openrouter</text><line x1="370" y1="40.0" x2="422" y2="40.0" stroke="#8a92a6" stroke-width="1.5"/><polygon points="422,36.0 430,40.0 422,44.0" fill="#8a92a6"/><rect x="430" y="20" width="150" height="40" rx="6" fill="#131722" stroke="#5b8ff9" stroke-width="1.5"/><text x="505.0" y="45.0" fill="#e6e9f0" font-size="12" text-anchor="middle">sapiom_linkup</text><text x="10" y="75" fill="#8a92a6" font-size="11">seen 2x</text></svg>

## Most expensive / most failing trace

- **Most expensive:** `chain-1783163079023-ddff4761` — $0.012100 across 3 steps (16.21s wall time).
- **Failing trace(s):** none — all 2 traces completed every step with `outcome='success'`.

## Per-trace detail

### `chain-1783163079023-ddff4761`

Path: `sapiom_linkup -> sapiom_openrouter -> sapiom_linkup` — $0.012100 total, 16.21s wall time.

| Step | Service | Action | Outcome | Live cost |
|---|---|---|---|---|
| 1 | sapiom_linkup | execute | success | $0.006000 |
| 2 | sapiom_openrouter | generate | success | $0.000100 |
| 3 | sapiom_linkup | execute | success | $0.006000 |

### `chain-1783163183588-07885448`

Path: `sapiom_linkup -> sapiom_openrouter -> sapiom_linkup` — $0.012100 total, 15.23s wall time.

| Step | Service | Action | Outcome | Live cost |
|---|---|---|---|---|
| 1 | sapiom_linkup | execute | success | $0.006000 |
| 2 | sapiom_openrouter | generate | success | $0.000100 |
| 3 | sapiom_linkup | execute | success | $0.006000 |

## Cost-per-task rollup

| Trace | Steps | Cost | Wall time |
|---|---|---|---|
| `chain-1783163079023-ddff4761` | 3 | $0.012100 | 16.21s |
| `chain-1783163183588-07885448` | 3 | $0.012100 | 15.23s |

Average cost per task: **$0.012100** (n=2). Small sample — both traces so far come from the same BUILD 3 experiment script (search -> LLM -> search); this rolls up cleanly and matches `findings.md`'s cost-per-task section exactly, but isn't yet diverse enough to generalize into a per-workflow benchmark.

