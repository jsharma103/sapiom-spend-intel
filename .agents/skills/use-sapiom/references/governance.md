# Governance

Manage agent identities, spending rules, and API keys. MCP-only tools — no gateway SDK equivalent.

## MCP Tools

### `sapiom_create_agent` — Register Agent
Create a named agent identity for transaction tracking and spend attribution.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | yes | Human-readable display name |
| `name` | string | no | Programmatic identifier for find-or-create (e.g. `marketing-bot-01`) |
| `description` | string | no | Agent purpose/functionality |

**Example:**
```
Tool: sapiom_create_agent
Parameters: { "label": "Marketing Bot", "name": "marketing-bot-01", "description": "Handles marketing automation" }
```

**Returns:** Agent ID (formatted), label, name, status, creation timestamp.

### `sapiom_list_agents` — List Agents
List registered agents with optional status filter.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | no | Filter: `active` or `paused` |
| `limit` | number | no | Max results (default: 20, max: 100) |

### `sapiom_create_spending_rule` — Create Spending Rule
Create a rule that enforces limits on agent transactions. Cap total cost, transaction count, or per-transaction amounts within time windows.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Rule name |
| `ruleType` | string | yes | `usage_limit` |
| `limitValue` | number | yes | Threshold value |
| `measurementType` | string | yes | What to measure (see below) |
| `agentIds` | string[] | no | Scope to specific agent UUIDs |
| `intervalValue` | number | no | Time window size (e.g. `24`) |
| `intervalUnit` | string | no | `seconds`, `minutes`, `hours`, `days` |
| `isRolling` | boolean | no | Rolling window (default: true) |

**Measurement types:**
- `count_transactions` — number of transactions
- `sum_payment_amount` — cumulative payment in USD
- `this_payment_amount` — single payment amount in USD
- `sum_transaction_costs` — cumulative cost in USD
- `this_transaction_cost` — single transaction cost in USD

**Example — $100/day cap:**
```
Tool: sapiom_create_spending_rule
Parameters: {
  "name": "Daily cost cap",
  "ruleType": "usage_limit",
  "limitValue": 100,
  "measurementType": "sum_transaction_costs",
  "intervalValue": 24,
  "intervalUnit": "hours",
  "isRolling": true
}
```

**Example — Max 500 transactions/hour:**
```
Tool: sapiom_create_spending_rule
Parameters: {
  "name": "Rate limit",
  "ruleType": "usage_limit",
  "limitValue": 500,
  "measurementType": "count_transactions",
  "intervalValue": 1,
  "intervalUnit": "hours"
}
```

### `sapiom_list_spending_rules` — List Rules
List spending/usage rules with optional filters.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | no | Filter: `active` or `paused` |
| `agentId` | string | no | Filter by agent UUID |
| `limit` | number | no | Max results (default: 20) |

### `sapiom_create_transaction_api_key` — Create API Key
Create a new transaction API key. The plain key is shown only once.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Key name (1–255 chars) |
| `description` | string | no | What this key is for |

**Example:**
```
Tool: sapiom_create_transaction_api_key
Parameters: { "name": "Production Agent Key", "description": "Used by the production marketing agent" }
```

**Returns:** Key ID, name, type, and the plain key (shown once — store immediately).

### `sapiom_authenticate` — Get Auth Instructions
Returns step-by-step instructions for authenticating with Sapiom. Supports browser-based and device code flows.

**Parameters:** None.

---

## Gotchas

- **Governance tools are MCP-only** — no direct HTTP gateway equivalent
- **Rules are tenant-scoped** — all agents under your API key share the same rule set
- **Agent UUIDs for scoping** — use `sapiom_list_agents` to get UUIDs before scoping rules
- **API key shown once** — the plain key from `sapiom_create_transaction_api_key` is never retrievable again
- **Set rules before deploying autonomous agents** — prevents runaway spending
- **Omit interval for per-transaction limits** — `this_payment_amount` and `this_transaction_cost` don't need a time window
