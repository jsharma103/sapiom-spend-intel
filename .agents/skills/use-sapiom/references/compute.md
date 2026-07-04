# Compute

Run code in cloud sandboxes, deploy scheduled jobs, and execute one-off code snippets. Powered by Blaxel.

## MCP Tools

### Runs (One-Off Code Execution)

#### `sapiom_run` — Run Code Snippet
Execute a code snippet in a disposable container. Supports Node.js, Python, Go, Rust.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | yes | Source code to execute |
| `language` | string | yes | `nodejs`, `python`, `go`, `rust` |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_run
Parameters: { "code": "console.log('Hello from the cloud!')", "language": "nodejs" }
```

#### `sapiom_run_list` — List Recent Runs
List recent code runs with status, language, and exit codes.

#### `sapiom_run_get` — Get Run Result
Get detailed result of a run by ID, including stdout/stderr.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Run ID (e.g. `run_abc123`) |

### Sandboxes (Persistent Environments)

#### `sapiom_sandbox_create` — Create Sandbox
Create a persistent cloud sandbox with a chosen runtime image.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `image` | string | no | Container image (default: Node.js) |
| `name` | string | no | Human-readable name |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_sandbox_create
Parameters: { "name": "my-dev-env" }
```

#### `sapiom_sandbox_list` — List Sandboxes
List all active sandboxes with status and URLs.

#### `sapiom_sandbox_get` — Get Sandbox Details
Get details for a specific sandbox by name.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |

#### `sapiom_sandbox_delete` — Delete Sandbox
Delete a sandbox and free its resources.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |

#### `sapiom_sandbox_extend` — Extend Lifetime
Extend a sandbox's expiry to prevent automatic deletion.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |

#### `sapiom_sandbox_exec` — Execute Command
Execute a shell command inside a sandbox.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `command` | string/string[] | yes | Command to execute |

**Example:**
```
Tool: sapiom_sandbox_exec
Parameters: { "name": "my-dev-env", "command": "npm install express && node server.js" }
```

#### `sapiom_sandbox_deploy` — Deploy as Service
Deploy a sandbox as a persistent, publicly accessible service.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |

### Sandbox Files

#### `sapiom_sandbox_write_file` — Write File
Write content to a file in a sandbox.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `path` | string | yes | File path in sandbox |
| `content` | string | yes | File content |

#### `sapiom_sandbox_read_file` — Read File
Read a file's content from a sandbox.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `path` | string | yes | File path |

#### `sapiom_sandbox_list_files` — List Files
List files in a sandbox directory.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `path` | string | no | Directory path (default: root) |

#### `sapiom_sandbox_delete_file` — Delete File
Delete a file from a sandbox.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `path` | string | yes | File path |

### Sandbox Processes

#### `sapiom_sandbox_process_list` — List Processes
List running processes in a sandbox.

#### `sapiom_sandbox_process_get` — Get Process
Get details for a specific process by PID.

#### `sapiom_sandbox_process_logs` — Get Logs
Get stdout/stderr output from a process.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `pid` | number | yes | Process ID |

#### `sapiom_sandbox_process_stop` — Stop Process
Gracefully stop a process (SIGTERM).

#### `sapiom_sandbox_process_kill` — Kill Process
Force-kill a process (SIGKILL).

### Sandbox Previews

#### `sapiom_sandbox_preview_create` — Create Preview URL
Create a public preview URL for a port in a sandbox. Useful for sharing web apps.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Sandbox name |
| `port` | number | yes | Port to expose |
| `label` | string | no | Human-readable label |

#### `sapiom_sandbox_preview_list` — List Previews
List active preview URLs for a sandbox.

#### `sapiom_sandbox_preview_delete` — Delete Preview
Remove a preview URL.

### Sandbox Ports

#### `sapiom_sandbox_ports` — List Open Ports
List all open ports in a sandbox with protocol and PID.

### Jobs (Scheduled/Triggered)

#### `sapiom_job_deploy` — Deploy Job
Deploy code as a scheduled or triggered job.

**Key Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | yes | Job source code |
| `language` | string | yes | `nodejs`, `python`, `go`, `rust` |
| `schedule` | string | no | Cron expression (e.g. `0 * * * *`) |
| `agentName` | string | no | Agent name for spend tracking |

**Example:**
```
Tool: sapiom_job_deploy
Parameters: {
  "code": "console.log('Running every hour')",
  "language": "nodejs",
  "schedule": "0 * * * *"
}
```

#### `sapiom_job_list` — List Jobs
List all deployed jobs.

#### `sapiom_job_get` — Get Job Details
Get a job's config, schedule, and status.

#### `sapiom_job_update` — Update Job
Update a job's code, schedule, or configuration.

#### `sapiom_job_delete` — Delete Job
Remove a deployed job.

#### `sapiom_job_trigger` — Trigger Execution
Manually trigger a job execution outside its schedule.

#### `sapiom_job_list_executions` — List Executions
List execution history for a job.

#### `sapiom_job_get_execution` — Get Execution
Get detailed execution result by ID, including stdout/stderr.

---

## SDK Access (Direct HTTP)

**Gateway:** `https://compute.services.sapiom.ai`

```js
const { createFetch } = require("@sapiom/fetch");
const safeFetch = createFetch({ apiKey: process.env.SAPIOM_API_KEY });
const COMPUTE = "https://compute.services.sapiom.ai";
```

### Run Code
```js
const res = await safeFetch(`${COMPUTE}/v1/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: "print('hello')", language: "python" }),
});
const { id, stdout, stderr, exitCode } = await res.json();
```

### Create & Use Sandbox
```js
// Create
const sandbox = await safeFetch(`${COMPUTE}/v1/sandboxes`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "my-sandbox" }),
}).then(r => r.json());

// Execute command
const exec = await safeFetch(`${COMPUTE}/v1/sandboxes/my-sandbox/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo hello" }),
}).then(r => r.json());
```

---

## Gotchas

- **Sandboxes expire** — extend with `sapiom_sandbox_extend` before they auto-delete
- **`sapiom_run` is disposable** — no persistent state; use sandboxes for multi-step work
- **Jobs need a schedule or trigger** — without a cron schedule, trigger manually with `sapiom_job_trigger`
- **File paths are absolute** — use `/home/user/` as base in sandboxes
- **Process logs may lag** — poll `sapiom_sandbox_process_logs` for streaming output
