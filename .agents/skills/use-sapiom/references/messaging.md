# Messaging

Publish messages, create schedules, and manage queues. Powered by QStash (Upstash).

## MCP Tools

### Messages (5 tools)

Publish messages to URL endpoints with guaranteed delivery, retries, and delays.

#### `sapiom_message_publish` — Publish Message
Send a message to a URL endpoint. Supports delays, retries, and callbacks.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Destination endpoint URL |
| `body` | string/object | no | Message body |
| `headers` | object | no | Custom headers |
| `delay` | string | no | Delay before delivery (e.g. `30s`, `5m`) |
| `retries` | number | no | Number of retry attempts |
| `callbackUrl` | string | no | URL called after delivery |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_message_publish
Parameters: {
  "url": "https://my-api.com/webhook",
  "body": { "event": "user_signup", "userId": "123" },
  "retries": 3
}
```

#### `sapiom_message_enqueue` — Enqueue to Queue
Send a message to a named queue for ordered, rate-limited processing.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `queueName` | string | yes | Queue name (auto-created if new) |
| `url` | string | yes | Destination endpoint URL |
| `body` | string/object | no | Message body |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_message_enqueue
Parameters: { "queueName": "email-queue", "url": "https://my-api.com/send-email", "body": { "to": "user@example.com" } }
```

#### `sapiom_message_batch` — Batch Messages
Send multiple messages in one call. Each message can target a different URL.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | array | yes | Array of message objects (same shape as publish) |
| `agentName` | string | no | Agent name for spend tracking |

#### `sapiom_message_get` — Get Message Status
Check delivery status of a message by ID.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Message ID |

#### `sapiom_message_cancel` — Cancel Message
Cancel a pending/scheduled message.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Message ID |

### Schedules (6 tools)

Recurring message delivery on a cron schedule.

#### `sapiom_schedule_create` — Create Schedule
Create a recurring schedule that publishes messages on a cron pattern.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | yes | Destination endpoint URL |
| `cron` | string | yes | Cron expression (e.g. `0 * * * *` for hourly) |
| `body` | string/object | no | Message body |
| `headers` | object | no | Custom headers |
| `retries` | number | no | Retry attempts per delivery |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_schedule_create
Parameters: {
  "url": "https://my-api.com/health-check",
  "cron": "*/5 * * * *",
  "body": { "type": "health_check" }
}
```

#### `sapiom_schedule_list` — List Schedules
List all schedules with their cron patterns and status.

#### `sapiom_schedule_get` — Get Schedule Details
Get a schedule by ID.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Schedule ID |

#### `sapiom_schedule_delete` — Delete Schedule
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Schedule ID |

#### `sapiom_schedule_pause` — Pause Schedule
Temporarily stop a schedule from firing.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Schedule ID |

#### `sapiom_schedule_resume` — Resume Schedule
Resume a paused schedule.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Schedule ID |

### Queues (5 tools)

Named queues for ordered, rate-limited message processing.

#### `sapiom_queue_list` — List Queues
List all queues with message counts and status.

#### `sapiom_queue_get` — Get Queue Details
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Queue name |

#### `sapiom_queue_delete` — Delete Queue
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Queue name |

#### `sapiom_queue_pause` — Pause Queue
Stop processing messages (messages still accepted but not delivered).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Queue name |

#### `sapiom_queue_resume` — Resume Queue
Resume message processing.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Queue name |

---

## SDK Access (Direct HTTP)

**Gateway:** `https://qstash.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const QSTASH = "https://qstash.services.sapiom.ai";
```

### Publish a Message
```js
const res = await safeFetch(`${QSTASH}/v2/publish/https://my-api.com/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Upstash-Retries": "3",
    "Upstash-Delay": "30s",
  },
  body: JSON.stringify({ event: "user_signup" }),
});
```

### Create a Schedule
```js
const res = await safeFetch(`${QSTASH}/v2/schedules`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Upstash-Cron": "0 * * * *",
  },
  body: JSON.stringify({ destination: "https://my-api.com/check", body: {} }),
});
```

---

## Gotchas

- **Messages need a destination URL** — QStash delivers via HTTP POST to your endpoint
- **Queues are auto-created** — `sapiom_message_enqueue` creates the queue if it doesn't exist
- **Cron is UTC** — all schedule cron expressions run in UTC timezone
- **Paused queues still accept messages** — they queue up but don't deliver until resumed
- **Batch limit** — check QStash docs for max messages per batch call
