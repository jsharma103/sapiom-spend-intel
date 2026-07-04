# Search

Search the web with two providers: Linkup (AI-synthesised answers) and You.com (formatted results).

## MCP Tools

### `sapiom_search` — Web Search (Linkup)
Search the web and receive an AI-synthesised answer with source citations. Use `depth=deep` for complex topics.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Search query |
| `depth` | string | no | `standard` (fast) or `deep` (thorough) — default: `standard` |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_search
Parameters: { "query": "latest developments in quantum computing", "depth": "standard" }
```

**Returns:** AI-synthesised answer with source citations (name, URL, snippet).

### `sapiom_deep_search` — Web Search (You.com)
Search the web and get formatted web + news results. Different provider/index than Linkup — use both for broader coverage.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Search query |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_deep_search
Parameters: { "query": "recent AI research papers 2025" }
```

**Returns:** Formatted list of web and news results with titles, URLs, and snippets.

---

## SDK Access (Direct HTTP)

**Gateways:**
- Linkup: `https://linkup.services.sapiom.ai`
- You.com: `https://you-com.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
```

### Linkup Search
```js
const res = await safeFetch("https://linkup.services.sapiom.ai/v1/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ q: "quantum computing", depth: "standard", outputType: "sourcedAnswer" }),
});
const { answer, sources } = await res.json();
```

### You.com Search
```js
const res = await safeFetch("https://you-com.services.sapiom.ai/v1/search?query=AI+research", {
  method: "GET",
});
const results = await res.json();
```

---

## Gotchas

- **Two providers, different strengths** — `sapiom_search` (Linkup) gives a synthesised answer; `sapiom_deep_search` (You.com) gives raw results
- **Use both for coverage** — different indexes may surface different content
- **`depth=deep` is slower** — takes up to 20s vs ~5s for standard; use only when thoroughness matters
- **For site-specific search** — use `sapiom_site_search` (in scraping) instead
