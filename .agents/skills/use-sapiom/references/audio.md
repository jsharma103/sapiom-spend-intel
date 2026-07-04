# Audio

Text-to-speech, sound effects, and voice listing. Powered by ElevenLabs.

## MCP Tools

### `sapiom_text_to_speech` — Convert Text to Speech
Convert text to speech. Returns a URL to the generated MP3 audio file.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Text to convert (max 5000 chars) |
| `voiceId` | string | no | ElevenLabs voice ID (default: Rachel `21m00Tcm4TlvDq8ikWAM`) |
| `modelId` | string | no | Model (default: `eleven_multilingual_v2`) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_text_to_speech
Parameters: { "text": "Welcome to our podcast! Today we're discussing AI agents.", "voiceId": "21m00Tcm4TlvDq8ikWAM" }
```

**Returns:** Audio URL (expires after a set period) + expiry timestamp.

### `sapiom_sound_effects` — Generate Sound Effects
Generate sound effects from a text description. Returns a URL to the MP3.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Description of the sound (e.g. "thunderstorm with rain") |
| `durationSeconds` | number | no | Duration 0.5–22 seconds (auto if not set) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_sound_effects
Parameters: { "text": "soft forest ambience with birds chirping", "durationSeconds": 10 }
```

### `sapiom_list_voices` — List Available Voices (Free)
List all available ElevenLabs voices with IDs, names, and categories. Free endpoint.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_list_voices
Parameters: {}
```

---

## SDK Access (Direct HTTP)

**Gateway:** `https://elevenlabs.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const ELEVENLABS = "https://elevenlabs.services.sapiom.ai";
```

### Text-to-Speech
```js
const res = await safeFetch(`${ELEVENLABS}/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Hello world", model_id: "eleven_multilingual_v2" }),
});
const { url, expiresAt } = await res.json();
```

### Sound Effects
```js
const res = await safeFetch(`${ELEVENLABS}/v1/sound-generation`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "thunderstorm with rain", duration_seconds: 5 }),
});
const { url } = await res.json();
```

### List Voices
```js
const res = await safeFetch(`${ELEVENLABS}/v2/voices`, { method: "GET" });
const { voices } = await res.json();
```

---

## Gotchas

- **Max 5000 chars per TTS call** — split longer text into ~400-word chunks
- **Voice IDs are alphanumeric** — use `sapiom_list_voices` to find valid IDs
- **Audio URLs expire** — download or use the URL promptly
- **Multilingual model** — `eleven_multilingual_v2` handles non-English text well
- **STT is not available** — speech-to-text is currently disabled
