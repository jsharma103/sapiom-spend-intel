# Verify

Send and check SMS verification codes. Powered by Prelude.

## MCP Tools

### `sapiom_verify_send` — Send Verification Code
Send a 6-digit verification code to a US phone number via SMS.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `phoneNumber` | string | yes | US phone number in E.164 format: `+1XXXXXXXXXX` |

**Example:**
```
Tool: sapiom_verify_send
Parameters: { "phoneNumber": "+15551234567" }
```

**Returns:** Confirmation + `verificationId` (needed for checking).

### `sapiom_verify_check` — Check Verification Code
Check a 6-digit code against a pending verification request.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `verificationId` | string | yes | ID from `sapiom_verify_send` response |
| `code` | string | yes | 6-digit code entered by user |

**Example:**
```
Tool: sapiom_verify_check
Parameters: { "verificationId": "req_abc123", "code": "123456" }
```

**Returns:** `"Verification successful."` or failure status.

---

## SDK Access (Direct HTTP)

**Gateway:** `https://prelude.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const PRELUDE = "https://prelude.services.sapiom.ai";
```

### Send Code
```js
const res = await safeFetch(`${PRELUDE}/verifications`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    target: { type: "phone_number", value: "+15551234567" },
  }),
});
const { verificationRequestId } = (await res.json()).data;
```

### Check Code
```js
const res = await safeFetch(`${PRELUDE}/verifications/check`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ verificationRequestId, code: "123456" }),
});
const { status } = (await res.json()).data;
// status === "approved" means success
```

---

## Gotchas

- **US phone numbers only** — must be `+1` followed by 10 digits
- **Code is 6 digits** — exactly 6 numeric digits
- **Codes expire** — verify promptly after sending
- **SDK format differs from MCP** — SDK uses `target.type` + `target.value`; MCP just takes `phoneNumber`
