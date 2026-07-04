# Data

Provision and use Redis (key-value), Vector (embeddings), Search (full-text), and Postgres (relational) databases. Powered by Upstash and Neon.

## MCP Tools

### Redis (6 tools)

Serverless Redis for caching, session storage, counters, and general key-value operations.

#### `sapiom_redis_create` — Create Serverless Redis
Create a new serverless Redis database.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Database name |
| `region` | string | no | Region (default: us-east-1) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_redis_create
Parameters: { "name": "my-cache" }
```

#### `sapiom_redis_create_fixed` — Create Fixed-Size Redis
Create a fixed-size (non-serverless) Redis database for predictable performance.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Database name |
| `region` | string | no | Region |
| `agentName` | string | no | Agent name for spend tracking |

#### `sapiom_redis_list` — List Redis Databases
List all Redis databases with connection URLs.

#### `sapiom_redis_delete` — Delete Redis Database
Delete a Redis database by ID.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Database ID (e.g. `rds_abc123`) |

#### `sapiom_redis_update` — Rename Redis Database
Update a Redis database name.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Database ID |
| `name` | string | yes | New name |

#### `sapiom_redis_command` — Execute Redis Command
Execute any Redis command on a database. Supports all standard Redis commands (GET, SET, HSET, LPUSH, etc.).

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Data-plane URL (`*.data.sapiom.ai`) |
| `command` | string[] | yes | Redis command as array (e.g. `["SET", "key", "value"]`) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_redis_command
Parameters: { "url": "https://rds-abc.data.sapiom.ai", "command": ["SET", "user:1", "Alice"] }
```

### Vector (6 tools)

Vector database for semantic search, embeddings storage, and RAG pipelines.

#### `sapiom_vector_create` — Create Vector Index
Create a new vector index with specified dimensions and similarity function.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Index name |
| `dimensions` | number | yes | Vector dimensions (e.g. 1536 for OpenAI) |
| `similarityFunction` | string | no | `cosine`, `euclidean`, or `dot_product` |
| `region` | string | no | Region |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_vector_create
Parameters: { "name": "my-embeddings", "dimensions": 1536, "similarityFunction": "cosine" }
```

#### `sapiom_vector_list` — List Vector Indexes
#### `sapiom_vector_delete` — Delete Vector Index
#### `sapiom_vector_update` — Update Vector Index Settings

#### `sapiom_vector_upsert` — Upsert Vectors
Add or update vectors with metadata and optional raw data.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Data-plane URL |
| `vectors` | array | yes | Array of `{ id, vector, metadata?, data? }` |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_vector_upsert
Parameters: {
  "url": "https://vec-abc.data.sapiom.ai",
  "vectors": [{ "id": "doc-1", "vector": [0.1, 0.2, ...], "metadata": { "source": "blog" } }]
}
```

#### `sapiom_vector_query` — Query Vectors
Find similar vectors by similarity search.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Data-plane URL |
| `vector` | number[] | yes | Query vector |
| `topK` | number | no | Number of results (default: 10) |
| `filter` | string | no | Metadata filter expression |
| `includeMetadata` | boolean | no | Include metadata in results |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_vector_query
Parameters: { "url": "https://vec-abc.data.sapiom.ai", "vector": [0.1, 0.2, ...], "topK": 5, "includeMetadata": true }
```

### Search Index (6 tools)

Full-text search index for document search and filtering.

#### `sapiom_searchindex_create` — Create Search Index
Create a full-text search index with a document schema.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Index name |
| `region` | string | no | Region |
| `agentName` | string | no | Agent name for spend tracking |

#### `sapiom_searchindex_list` — List Search Indexes
#### `sapiom_searchindex_delete` — Delete Search Index
#### `sapiom_searchindex_update` — Update Search Index Schema

#### `sapiom_searchindex_upsert` — Upsert Documents
Add or update documents in a search index.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Data-plane URL |
| `documents` | array | yes | Array of `{ id, content }` |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_searchindex_upsert
Parameters: {
  "url": "https://srch-abc.data.sapiom.ai",
  "documents": [{ "id": "doc-1", "content": { "title": "Hello", "body": "World" } }]
}
```

#### `sapiom_searchindex_query` — Query Search Index
Full-text search across documents.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Data-plane URL |
| `query` | string | yes | Search query |
| `agentName` | string | no | Agent name for spend tracking |

### Neon Postgres (5 tools)

Ephemeral Postgres databases with specified lifetimes. Perfect for testing, prototyping, and one-off data analysis.

#### `sapiom_database_create` — Provision Postgres
Create an ephemeral Neon Postgres database. Returns connection URI when ready.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `duration` | string | yes | Lifetime: `15m`, `1h`, `4h`, `24h`, `7d` |
| `handle` | string | no | Stable handle for lookups (e.g. `analytics-db`) |
| `name` | string | no | Human-readable name |
| `description` | string | no | What this DB is for |
| `region` | string | no | Region (default: aws-us-east-1) |
| `pgVersion` | number | no | PostgreSQL version: 15, 16, or 17 |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_database_create
Parameters: { "duration": "1h", "handle": "analytics-db", "description": "Temp DB for data analysis" }
```

#### `sapiom_database_price` — Get Price Estimate (Free)
Check cost before creating. Free endpoint — no payment required.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `duration` | string | yes | `15m`, `1h`, `4h`, `24h`, `7d` |

#### `sapiom_database_list` — List Databases
List active and provisioning Postgres databases with connection URIs.

#### `sapiom_database_get` — Get Database Details
Get connection URI and status. Accepts database ID or handle.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Database ID (`ndb_xxx`) or handle |

#### `sapiom_database_delete` — Delete Database
Delete a database. Irreversible.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Database ID or handle |

---

## SDK Access (Direct HTTP)

### Redis/Vector/Search

**Gateway:** `https://upstash.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const UPSTASH = "https://upstash.services.sapiom.ai";
```

```js
// Create Redis
const res = await safeFetch(`${UPSTASH}/v1/databases`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "my-cache", type: "redis" }),
});
const { id, url } = await res.json();

// Execute Redis command (via data-plane URL)
const cmd = await safeFetch(`${url}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(["SET", "key", "value"]),
});
```

### Neon Postgres

**Gateway:** `https://neon.services.sapiom.ai`

```js
const NEON = "https://neon.services.sapiom.ai";

// Check price (free)
const price = await safeFetch(`${NEON}/v1/databases/price`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ duration: "1h" }),
}).then(r => r.json());

// Create database
const db = await safeFetch(`${NEON}/v1/databases`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ duration: "1h", handle: "my-db" }),
}).then(r => r.json());
// db.connectionUri contains the Postgres connection string
```

---

## Gotchas

- **Provision before using** — must `sapiom_redis_create` / `sapiom_vector_create` / `sapiom_database_create` before executing commands
- **Data-plane URLs** — Redis commands, vector queries, and search queries use the `*.data.sapiom.ai` URL returned at creation, not the gateway URL
- **Postgres is ephemeral** — databases auto-delete after their duration expires; export data before expiry
- **`sapiom_database_price` is free** — always check cost before creating
- **Vector dimensions must match** — upserted vectors must match the dimensions set at index creation
- **Redis commands are arrays** — `["SET", "key", "value"]` not `"SET key value"`
