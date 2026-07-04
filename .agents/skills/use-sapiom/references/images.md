# Images

Generate images from text prompts. Powered by Fal.ai (FLUX models).

## MCP Tools

### `sapiom_generate_image` — Generate Image
Generate images from a text prompt using Fal.ai models. Default model is FLUX Schnell (fast).

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | yes | Text description of the image |
| `modelId` | string | no | Fal.ai model (default: `fal-ai/flux/schnell`) |
| `imageSize` | string | no | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` |
| `numImages` | number | no | Number of images 1–4 (default: 1) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_generate_image
Parameters: {
  "prompt": "A serene mountain lake at sunset with golden reflections",
  "imageSize": "landscape_16_9"
}
```

**Returns:** One or more image URLs.

**Available models:**
| Model | Speed | Quality |
|-------|-------|---------|
| `fal-ai/flux/schnell` | Fast | Good (default) |
| `fal-ai/flux/dev` | Medium | Better |
| `fal-ai/flux-pro` | Slower | Best |

---

## SDK Access (Direct HTTP)

**Gateway:** `https://fal.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const FAL = "https://fal.services.sapiom.ai";
```

### Generate Image
```js
const res = await safeFetch(`${FAL}/v1/run/fal-ai/flux/schnell`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "A futuristic city skyline at night",
    image_size: "landscape_16_9",
    num_images: 1,
  }),
});
const { images } = await res.json();
// images[0].url contains the image URL
```

---

## Gotchas

- **Model ID format** — use `fal-ai/flux/schnell` not `flux-schnell`; the model ID becomes the URL path
- **Image URLs may expire** — download or display promptly
- **`numImages` max is 4** — for more images, make multiple calls
- **Prompt quality matters** — be specific and descriptive for better results
