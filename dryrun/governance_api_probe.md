# Governance API Probe — Can spending rules be created via API?

Date: 2026-07-04
Scope: read-only recon + a careful write probe (with cleanup) against `https://api.sapiom.ai/v1`.

## Verdict

**YES — governance spending rules (and agents) CAN be created via the plain HTTP API**, using the
same `Authorization: Bearer $SAPIOM_API_KEY` transaction key already used for GETs (plus the
`User-Agent: curl/8.6.0` Cloudflare workaround). This contradicts the standing assumption in
`BACKLOG.md` / `.agents/skills/use-sapiom/references/governance.md` that rule creation is
"dashboard-only" / "MCP-only, no gateway SDK equivalent."

What's true and what isn't:
- **True**: no *documented* public REST API for this exists. `docs.sapiom.ai` only describes
  governance actions via MCP tools (`sapiom_create_agent`, `sapiom_create_spending_rule`, ...),
  served at `https://api.sapiom.ai/v1/mcp`. The `@sapiom/core` / `@sapiom/fetch` JS SDK has zero
  governance/rules/policy code (grepped `node_modules/@sapiom`, no hits).
- **False**: that this means the write is inaccessible outside the dashboard/MCP. The MCP server
  itself lives on `api.sapiom.ai/v1`, the same host as the plain REST API — and the underlying
  REST routes (`POST /v1/agents`, `POST /v1/spending-rules`, `PUT /v1/spending-rules/{id}`) are
  live, unauthenticated-by-scope-restriction (any Bearer key with default permissions can call
  them), and accept plain JSON bodies. It's an undocumented-but-functional surface, not a
  genuinely private one.
- **Partial gap**: no working DELETE was found for either resource (see Cleanup below) — creation
  and update (PUT) work, hard-delete does not (404 "Cannot DELETE ..." — route simply isn't wired
  up), despite CORS preflight advertising DELETE as an allowed method.

## 1. Read recon

`GET /v1/spending-rules` (Bearer + curl UA) → `200`, one pre-existing human-created rule:
```json
{"data":[{"type":"rules","id":"59767099-9727-4edd-9d2c-00a360e32068","attributes":{"numericId":1,"formattedId":"RL-001","name":"Linkup Spend Limit","ruleType":"usage_limit","resolutionStrategy":"automatic","status":"paused","version":1,"metadata":null,"createdAt":"2026-07-04T04:52:22.445Z","updatedAt":"2026-07-04T09:27:53.258Z"}}],"links":{"self":"/spending-rules?","next":null,"prev":null},"meta":{"page":{"limit":20,"hasNext":false,"hasPrev":false}}}
```

`GET /v1/spending-rules?include=parameters,conditions,agents,services,transactions` → `200`,
revealed the full JSON:API shape (relationships to `rule-parameters` and `rule-conditions`):
```json
{
  "attributes": {"name":"Linkup Spend Limit","ruleType":"usage_limit","resolutionStrategy":"automatic","status":"paused","version":1},
  "included": [
    {"type":"rule-parameters","attributes":{"limitValue":"1.000000000000000000","measurementType":"sum_transaction_costs","intervalValue":1,"intervalUnit":"days","isRolling":true,"groupBy":null,"measurementScope":"all","includeEstimates":true}},
    {"type":"rule-conditions","attributes":{"fieldType":"service","operator":"equals","value":"linkup","conditionGroup":"primary"}}
  ]
}
```

`OPTIONS /v1/spending-rules` and `OPTIONS /v1/spending-rules/{id}` → `204`, CORS header
`access-control-allow-methods: GET,POST,PUT,PATCH,DELETE,OPTIONS` (misleading — see below, PATCH
and DELETE are not actually wired to a handler on this route).

## 2. Write-surface discovery

`POST /v1/spending-rules` with empty body `{}` → `400` (route exists, validates before touching
auth-scope):
```json
{"message":["name must be shorter than or equal to 255 characters","name should not be empty","name must be a string","ruleType should not be empty","ruleType must be one of the following values: usage_limit, payment_authorization, allowlist, blocklist"],"error":"Bad Request","statusCode":400}
```

`POST /v1/spending-rules` with `{"name":"api-probe-test-rule","ruleType":"usage_limit"}` →
**`201 Created`** — a real, "active" rule with no scoping and no limit parameter:
```json
{"id":"8f733ab9-0895-46b8-bd4b-16039818934f","numericId":2,"formattedId":"RL-002","name":"api-probe-test-rule","ruleType":"usage_limit","resolutionStrategy":"automatic","status":"active","version":1,"lastEditedBy":{"apiKeyId":"bfb69755-474f-41c3-bc82-22ca4aa97eec"},"deletedAt":null,"conditions":[],"parameters":[],"agentRules":[]}
```
(Immediately paused — see Cleanup. Because it had zero `parameters`, it had no enforceable limit,
so it could not have affected real traffic even while briefly active/unscoped.)

Follow-up probes with a nested `conditions` array revealed the condition-field enum (no `agent`
option — confirms agent-scoping is a separate relationship, not a condition):
```json
{"message":["conditions.0.fieldType must be one of the following values: service, action, resource, qualifier, transaction_property, payment_property","parameters.0.limitValue must be a string"],"error":"Bad Request","statusCode":400}
```

`POST /v1/agents` with empty body `{}` → `400` (also a live write route, not MCP-only):
```json
{"message":["label must be shorter than or equal to 255 characters","label should not be empty","label must be a string"],"error":"Bad Request","statusCode":400}
```

## 3. Harmless scoped rule — created, verified, cleaned up

Step A — created a throwaway agent identity that never appears in real traffic:
```
POST /v1/agents  {"label":"API Probe Test Agent","name":"api-probe-test-agent","description":"Harmless test agent created during governance-API recon; scoped-only, never used for real calls; safe to ignore/delete."}
→ 201  {"id":"5fe6632c-e5ee-4b7c-a49b-d5c4e5e61056","name":"api-probe-test-agent","status":"active","numericId":17,"formattedId":"AG-017"}
```

Step B — created a $100/day rule scoped ONLY to that fake agent (via `agentIds`, not
`conditions` — `limitValue` must be a **string**):
```
POST /v1/spending-rules
{
  "name": "api-probe-test-rule-scoped",
  "ruleType": "usage_limit",
  "agentIds": ["5fe6632c-e5ee-4b7c-a49b-d5c4e5e61056"],
  "parameters": [{"limitValue":"100","measurementType":"sum_transaction_costs","intervalValue":1,"intervalUnit":"days","isRolling":true}]
}
→ 201 Created
{"id":"9226f698-ae34-4de0-a0a7-aa2d0f88b7fa","numericId":3,"formattedId":"RL-003","name":"api-probe-test-rule-scoped","ruleType":"usage_limit","status":"active","version":1,
 "parameters":[{"id":"2c2d0da1-...","limitValue":"100","measurementType":"sum_transaction_costs","intervalValue":1,"intervalUnit":"days","isRolling":true,"measurementScope":"all"}],
 "agentRules":[{"id":"52cdf4f4-...","agentId":"5fe6632c-e5ee-4b7c-a49b-d5c4e5e61056","ruleId":"9226f698-..."}]}
```

Step C — confirmed via GET with includes: rule RL-003 exists, `status:"active"`, correctly linked
to agent `api-probe-test-agent` (AG-017) and its `rule-parameters` ($100/day, rolling, sum of
transaction costs). Since it is scoped only to a nonexistent test agent, it could never have
affected real spend/other experiments.

## 4. Cleanup

Tried `DELETE /v1/spending-rules/{id}` on both test rules → **`404`** both times:
```json
{"message":"Cannot DELETE /v1/spending-rules/<id>","error":"Not Found","statusCode":404}
```
Also tried: `DELETE /v1/rules/{id}` (404), `DELETE /v1/spending-rules/{id}/archive` (404),
`DELETE /v1/spending-rules` with `{"id":...}` body (404), `PATCH /v1/spending-rules/{id}` (404),
`PATCH /v1/rules/{id}` (404). None of these routes are implemented — hard delete is not available
via this API surface today, despite CORS advertising DELETE/PATCH as allowed methods.

`PUT /v1/spending-rules/{id}` **does** work (requires `version` in the body — optimistic
concurrency) and is the only functional mutate/cleanup path:
```
PUT /v1/spending-rules/{id}  {"status":"paused","version":1}
→ 200  {"status":"paused","version":2,...}
```
Also confirmed the `status` enum is only `active | paused` (no `deleted`/`archived` state):
```json
{"message":["status must be one of the following values: active, paused"],"error":"Bad Request","statusCode":400}
```

**Final state (cleanup outcome — verified via GET):**
- `RL-002` (`api-probe-test-rule`, unscoped, no parameters) → **`status: paused`** ✅
- `RL-003` (`api-probe-test-rule-scoped`, agent-scoped $100/day) → **`status: paused`** ✅
- `AG-017` (`api-probe-test-agent`) → still exists, `status: active`. No `DELETE`/`PUT`/`PATCH`
  route exists on `/v1/agents/{id}` (all return 404 "Cannot DELETE/PUT ..."), so this identity
  record cannot be removed via API. It is inert: an agent record by itself does not spend money,
  it has zero associated transactions, and its only rule is now paused. Description field
  explicitly flags it as safe test residue.

Neither test rule was ever in a state that could have affected real traffic: RL-002 had no
parameters (unenforceable), and RL-003 was scoped exclusively to the nonexistent `api-probe-test-agent`.

## 5. SDK / docs cross-check

- `node_modules/@sapiom/core` and `node_modules/@sapiom/fetch`: grepped for
  `governance|rule|policy` (any case, all files) — **zero matches**. SDK only covers
  transactions/api-keys/telemetry/http/config types, confirming governance was never intended as
  an SDK-level feature.
- `docs.sapiom.ai` (via WebFetch): governance (agent registration, spending rules, scoped API
  keys) is documented **only** under the Remote MCP section (tools `sapiom_create_agent` →
  `sapiom_create_spending_rule` → `sapiom_create_transaction_api_key`, served at
  `https://api.sapiom.ai/v1/mcp`). No dedicated REST governance page. This is the likely reason
  the SDK/skill docs call it "MCP-only" — the *documented* integration path is MCP — but since the
  MCP endpoint is hosted on the same `api.sapiom.ai/v1` base, and the plain REST routes underneath
  accept a standard Bearer transaction key, the write surface is reachable directly with curl,
  bypassing MCP entirely.

## Exact working curl recipe (create a scoped, harmless rule)

```bash
set -a && source .env && set +a

# 1. Create a throwaway agent identity (never used for real calls)
curl -sS -X POST \
  -H "Authorization: Bearer $SAPIOM_API_KEY" -H "User-Agent: curl/8.6.0" \
  -H "Content-Type: application/json" \
  -d '{"label":"My Test Agent","name":"my-test-agent","description":"scoped-only test"}' \
  https://api.sapiom.ai/v1/agents
# → capture the returned "id"

# 2. Create a rule scoped ONLY to that agent (limitValue MUST be a string)
curl -sS -X POST \
  -H "Authorization: Bearer $SAPIOM_API_KEY" -H "User-Agent: curl/8.6.0" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Test Rule",
    "ruleType": "usage_limit",
    "agentIds": ["<agent-id-from-step-1>"],
    "parameters": [{
      "limitValue": "100",
      "measurementType": "sum_transaction_costs",
      "intervalValue": 1,
      "intervalUnit": "days",
      "isRolling": true
    }]
  }' \
  https://api.sapiom.ai/v1/spending-rules

# 3. Cleanup (no hard DELETE available — pause instead; version required)
curl -sS -X PUT \
  -H "Authorization: Bearer $SAPIOM_API_KEY" -H "User-Agent: curl/8.6.0" \
  -H "Content-Type: application/json" \
  -d '{"status":"paused","version":1}' \
  https://api.sapiom.ai/v1/spending-rules/<rule-id>
```

`ruleType` enum: `usage_limit, payment_authorization, allowlist, blocklist`.
`conditions[].fieldType` enum: `service, action, resource, qualifier, transaction_property, payment_property`
(no `agent` — agent scoping is done via top-level `agentIds`, materializing as an `agentRules`
relationship, not a condition).

## Money safety

No paid endpoints (`/proxy`, LLM/search/image calls) were touched. Governance CRUD calls are free.
No spend scripts were run.
