# Scraping & Browser

Scrape web pages, crawl sites, extract structured data, take screenshots. Powered by Firecrawl (scraping) and Anchor Browser (screenshots).

## MCP Tools

### `sapiom_fetch` — Quick Page Fetch
Fetch clean main content from a URL as markdown. Strips nav, footer, ads. Delegates to Firecrawl with `onlyMainContent: true`.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | URL to fetch |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_fetch
Parameters: { "url": "https://example.com/blog/post" }
```

### `sapiom_screenshot` — Webpage Screenshot
Capture a screenshot of a webpage. Returns a URL to the PNG (expires after 1 hour). Uses Anchor Browser.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | URL to screenshot |
| `width` | number | no | Viewport width (default: 1280) |
| `height` | number | no | Viewport height (default: 720) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_screenshot
Parameters: { "url": "https://example.com", "width": 1280, "height": 720 }
```

### `sapiom_scrape` — Advanced Scrape
Scrape a single page with format options, selectors, and wait conditions. More control than `sapiom_fetch`.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | URL to scrape |
| `formats` | string[] | no | Output formats: `markdown`, `html`, `rawHtml`, `screenshot` |
| `onlyMainContent` | boolean | no | Extract only main content (default: true) |
| `waitFor` | number | no | Wait time in ms for JS rendering |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_scrape
Parameters: { "url": "https://example.com", "formats": ["markdown", "html"], "onlyMainContent": true }
```

### `sapiom_crawl` — Crawl a Website
Crawl an entire website starting from a URL. Returns a job ID — poll with `sapiom_crawl_status`.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Starting URL |
| `maxDiscoveryDepth` | number | no | Max link depth |
| `limit` | number | no | Max pages to crawl (max: 10000) |
| `includePaths` | string[] | no | URL patterns to include (e.g. `["/blog/*"]`) |
| `excludePaths` | string[] | no | URL patterns to exclude |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_crawl
Parameters: { "url": "https://docs.example.com", "limit": 50 }
```

### `sapiom_crawl_status` — Check Crawl Progress
Check status and retrieve results of a crawl job.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Crawl job ID from `sapiom_crawl` |
| `agentName` | string | no | Agent name for spend tracking |

### `sapiom_map` — Site URL Discovery
Discover all URLs on a website without extracting content. Fast sitemap alternative.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Website URL to map |
| `agentName` | string | no | Agent name for spend tracking |

### `sapiom_extract` — Structured Data Extraction
Extract structured data from web pages using a natural language prompt and optional JSON schema.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `urls` | string[] | yes | URLs to extract from |
| `prompt` | string | yes | What data to extract |
| `schema` | object | no | JSON schema for output structure |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_extract
Parameters: {
  "urls": ["https://example.com/pricing"],
  "prompt": "Extract all pricing tiers with names, prices, and features"
}
```

### `sapiom_extract_status` — Check Extract Progress
Check status and retrieve results of an extract job.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Extract job ID from `sapiom_extract` |
| `agentName` | string | no | Agent name for spend tracking |

### `sapiom_site_search` — Search Within a Site
Search within a specific website's content. Unlike `sapiom_search` (web-wide), this searches only within one site.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | yes | Search query |
| `url` | string | yes | Site URL to search within |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_site_search
Parameters: { "query": "authentication", "url": "https://docs.example.com" }
```

---

## SDK Access (Direct HTTP)

**Gateway:** `https://firecrawl.services.sapiom.ai` (scraping) / `https://anchor-browser.services.sapiom.ai` (screenshots)

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const FIRECRAWL = "https://firecrawl.services.sapiom.ai";
const ANCHOR = "https://anchor-browser.services.sapiom.ai";
```

### Scrape a Page
```js
const res = await safeFetch(`${FIRECRAWL}/v2/scrape`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
});
const { data } = await res.json();
// data.markdown, data.metadata.title
```

### Extract Structured Data
```js
const res = await safeFetch(`${FIRECRAWL}/v2/extract`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    urls: ["https://example.com/pricing"],
    prompt: "Extract pricing tiers",
    schema: { type: "object", properties: { tiers: { type: "array" } } },
  }),
});
```

### Screenshot
```js
const res = await safeFetch(`${ANCHOR}/v1/tools/screenshot`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com", width: 1280, height: 720 }),
});
const { url, expiresAt } = await res.json();
```

---

## Gotchas

- **`sapiom_fetch` vs `sapiom_scrape`** — `fetch` is simple (URL only, markdown out); `scrape` gives full control (formats, waitFor, selectors)
- **`formats` is an array** — `["markdown"]` not `"markdown"`
- **JS-heavy pages** — use `waitFor: 3000` to let content render before scraping
- **Crawl/extract are async** — they return a job ID; poll `_status` for results
- **Content can be large** — markdown from big pages may be very long; truncate before sending to LLM
- **`sapiom_screenshot` uses Anchor Browser**, not Firecrawl — different gateway
