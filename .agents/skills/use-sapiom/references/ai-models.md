# AI Models

Send prompts to LLMs and list available models. Powered by OpenRouter.

## MCP Tools

### `sapiom_chat` — Chat with LLM
Send a prompt to any LLM via OpenRouter and receive a text response. OpenAI-compatible API.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | yes | User message to send |
| `model` | string | no | Model ID (default: `openai/gpt-4o-mini`) |
| `systemPrompt` | string | no | System prompt for context/behavior |
| `maxTokens` | number | no | Max response tokens (default: 4096) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_chat
Parameters: {
  "prompt": "Summarize this article in 3 bullet points: ...",
  "model": "anthropic/claude-3.5-sonnet",
  "systemPrompt": "You are a concise summarizer.",
  "maxTokens": 500
}
```

**Popular models:** `openai/gpt-4o-mini`, `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `google/gemini-pro`

### `sapiom_list_models` — List Available Models
List all available models with pricing info. Optionally filter by category.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `category` | string | no | Filter by category (e.g. `chat`, `completion`, `embedding`) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_list_models
Parameters: {}
```

---

## SDK Access (Direct HTTP)

**Gateway:** `https://openrouter.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const OPENROUTER = "https://openrouter.services.sapiom.ai";
```

### Chat Completion
```js
const res = await safeFetch(`${OPENROUTER}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "openai/gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is the capital of France?" },
    ],
    max_tokens: 100,
  }),
});
const { choices } = await res.json();
const answer = choices[0].message.content;
```

### List Models
```js
const res = await safeFetch(`${OPENROUTER}/v1/models`, { method: "GET" });
const { data: models } = await res.json();
```

---

## Gotchas

- **OpenAI-compatible API** — same request/response format as OpenAI chat completions
- **Model pricing varies** — use `sapiom_list_models` to check pricing before using expensive models
- **Default model is `gpt-4o-mini`** — cheap and fast; specify a different model for better quality
- **Max 5000 chars per prompt** — for longer content, split into chunks
