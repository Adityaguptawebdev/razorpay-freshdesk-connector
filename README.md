# Freshdesk MCP Connector

A small, production-minded TypeScript connector that lets an **Agent Studio / MCP-compatible AI agent read Freshdesk support tickets safely**: list, get and search, with API-key authentication, strict input validation, rate-limit handling and agent-friendly errors.

> **This connector is intentionally read-only.** It cannot create, update, reply to, assign or delete tickets, or change customer information.

Built for the Razorpay Forward-Deployed Engineer (Agent Studio) assignment, **Option 3: private connector for a merchant tool (Freshdesk)**.

| Assignment requirement | Where it lives |
| --- | --- |
| API-key authentication flow | [`src/auth/credentials.ts`](src/auth/credentials.ts), [`src/config.ts`](src/config.ts) |
| list / get / search primitives | [`src/tools/`](src/tools/), [`src/client/freshdesk-client.ts`](src/client/freshdesk-client.ts) |
| Rate-limit handling | [`src/client/freshdesk-client.ts`](src/client/freshdesk-client.ts), [`src/utils/retry.ts`](src/utils/retry.ts) |
| MCP tool specification | [`src/mcp/server.ts`](src/mcp/server.ts), generated spec in [`docs/mcp-tools.json`](docs/mcp-tools.json) |
| What the agent can and cannot do | [§16](#16-what-the-agent-can-do) and [§17](#17-what-the-agent-cannot-do) |
| Tests with mocked Freshdesk responses | [`tests/`](tests/): 136 tests, no credentials or network needed |

## Contents

1. [Project overview](#1-project-overview)
2. [Problem statement](#2-problem-statement)
3. [Architecture](#3-architecture)
4. [Why this design](#4-why-this-design)
5. [Prerequisites](#5-prerequisites)
6. [Installation](#6-installation)
7. [Environment variables](#7-environment-variables)
8. [How to run](#8-how-to-run)
9. [Available MCP tools](#9-available-mcp-tools)
10. [Example tool inputs](#10-example-tool-inputs)
11. [Example outputs](#11-example-outputs)
12. [Authentication approach](#12-authentication-approach)
13. [Rate-limit handling](#13-rate-limit-handling)
14. [Error handling](#14-error-handling)
15. [Testing](#15-testing)
16. [What the agent CAN do](#16-what-the-agent-can-do)
17. [What the agent CANNOT do](#17-what-the-agent-cannot-do)
18. [Security considerations](#18-security-considerations)
19. [Limitations](#19-limitations)
20. [Future improvements](#20-future-improvements)

---

## 1. Project overview

The connector runs as an [MCP](https://modelcontextprotocol.io) server over stdio and exposes three tools:

| Tool | What it does | Freshdesk endpoint |
| --- | --- | --- |
| `list_tickets` | Paginated ticket summaries, optionally for one requester, company or predefined view | `GET /api/v2/tickets` |
| `get_ticket` | One ticket in full, optionally with requester and conversation history | `GET /api/v2/tickets/:id` |
| `search_tickets` | Structured search by status, priority, assignee, group, tag, type and date range | `GET /api/v2/search/tickets` |

Runtime dependencies: `@modelcontextprotocol/sdk` and `zod`. HTTP uses Node's native `fetch`.

## 2. Problem statement

Merchants run customer support in Freshdesk. An Agent Studio agent, for example a support copilot answering "where is my refund?" or an ops agent triaging urgent tickets, needs ticket context to be useful.

Handing an LLM the raw Freshdesk API does not work well:

- **Secrets**: the API key must never reach the model, logs or error messages.
- **Query syntax**: Freshdesk's filter language (`"(status:2 OR status:3) AND tag:'refund'"`) is easy for a model to get wrong, and free-form strings invite injection.
- **API quirks**: numeric status/priority codes, a 30-day default window on listing, 10-page search cap, HTML bodies, Link-header pagination.
- **Rate limits**: limits are per Freshdesk account and shared with the merchant's other integrations, so the agent must back off politely and must not hang.
- **Data exposure**: private agent notes and customer PII should not flow to a customer-facing agent by default.

This connector is the thin, safe layer in between: a small set of well-described, validated, read-only tools.

## 3. Architecture

```text
 Agent Studio / any MCP host (Claude Desktop, Cursor, MCP Inspector, ...)
        │  MCP (JSON-RPC over stdio)
        ▼
 src/mcp/server.ts         McpServer: registers tools, read-only annotations, result formatting
        │
 src/tools/*               Tool definitions: Zod input/output schemas, validation,
        │                  normalisation, private-note policy, structured error envelope
        ▼
 src/client/*              FreshdeskClient: auth header, host allow-list, timeouts,
        │                  retries with Retry-After/backoff, error mapping, search query builder
        │  HTTPS + Basic auth (API key)
        ▼
 https://<subdomain>.freshdesk.com/api/v2
```

What happens on one call, e.g. `search_tickets {"status":["open"],"priority":["urgent"]}`:

1. The MCP SDK validates the arguments against the tool's Zod schema (unknown keys are rejected).
2. The tool layer re-validates (it does not trust its transport), then builds the Freshdesk query `status:2 AND priority:4` from the structured filters.
3. `FreshdeskClient` sends one HTTPS GET to the configured `*.freshdesk.com` origin, retrying 429/5xx/timeouts within a bounded budget.
4. The response is validated with Zod, then normalised (codes → labels, HTML dropped, long text truncated).
5. The result goes back as `structuredContent` plus a JSON text block. Failures go back as `isError: true` with a machine-readable error code.

### Project structure

```text
.
├── src/
│   ├── index.ts                  # Entry point: load config, start MCP server on stdio
│   ├── config.ts                 # Validates environment variables (fails fast, lists every problem)
│   ├── auth/
│   │   └── credentials.ts        # API key + host allow-list, Basic auth header, redacted serialisation
│   ├── client/
│   │   ├── freshdesk-client.ts   # HTTP client: retries, Retry-After, timeouts, error mapping
│   │   └── search-query.ts       # Structured filters → Freshdesk filter query
│   ├── tools/
│   │   ├── list-tickets.ts       # list_tickets tool
│   │   ├── get-ticket.ts         # get_ticket tool
│   │   ├── search-tickets.ts     # search_tickets tool
│   │   ├── schemas.ts            # Shared input/output Zod schemas
│   │   ├── normalize.ts          # Raw Freshdesk ticket → agent-friendly shape
│   │   ├── tool.ts               # Tool contract + runTool (validation, error envelope, logging)
│   │   └── index.ts              # Tool registry
│   ├── mcp/
│   │   ├── server.ts             # MCP server, annotations, instructions, result formatting
│   │   └── spec.ts               # Generates the tools/list spec (docs/mcp-tools.json)
│   ├── types/
│   │   └── freshdesk.ts          # Freshdesk response schemas, code ↔ label maps, API limits
│   └── utils/
│       ├── errors.ts             # ConnectorError, error codes, error payload
│       ├── retry.ts              # Retry policy, Retry-After parsing, backoff with jitter
│       ├── logger.ts             # JSON-lines stderr logger with secret redaction
│       ├── redact.ts             # Secret redaction
│       └── text.ts               # Text truncation
├── tests/                        # Vitest suites + fictional fixtures + mocked fetch
├── scripts/
│   ├── demo-client.ts            # Minimal MCP client for trying the server against a real account
│   └── generate-tool-spec.ts     # Writes docs/mcp-tools.json
├── docs/
│   └── mcp-tools.json            # Exact tools/list output (input + output JSON Schemas)
├── .env.example
├── package.json
├── tsconfig.json                 # Type-checks src, tests and scripts
├── tsconfig.build.json           # Emits dist/ from src only
└── vitest.config.ts
```

## 4. Why this design

| Decision | Reason |
| --- | --- |
| **Transport-agnostic tool layer** (`src/tools`) with MCP as a thin adapter | The same tool definitions can be exposed over MCP, exported as a JSON spec for platforms that import tool specs, or wrapped in another protocol without touching business logic. |
| **Structured search filters instead of a raw query string** | Models make syntax mistakes in Freshdesk's query language, and free text could alter the query. Enums and whitelisted values make invalid queries impossible. The executed query is echoed back for transparency. |
| **Normalised output** with lowercase labels (`"open"`, `"urgent"`) that match the search inputs | The agent can chain `search_tickets` → `get_ticket` without knowing Freshdesk's numeric codes. HTML is dropped, long text is truncated, and fields that weren't requested are `null`. |
| **Policy in configuration, not in tool inputs** | Whether private notes are visible, and how long to retry, are operator decisions. The model cannot change them via arguments. |
| **Bounded retry budget** (default 20s of waiting per call) | A tool call that blocks for minutes is worse than a clear `RATE_LIMITED` error with `retry_after_seconds`. Defaults keep a call well inside the 60s request timeout common in MCP clients. |
| **Runtime validation of Freshdesk responses** | An unexpected payload becomes a clear `UPSTREAM_ERROR` rather than `undefined` leaking into the agent's reasoning. |
| **Dependency injection for `fetch`, `sleep`, `random`, clock** | Retry and rate-limit behaviour is tested exactly and instantly, with no network and no real waiting. |
| **Minimal dependencies** (MCP SDK + Zod at runtime) | Smaller attack surface, easier review and maintenance. |

Deliberately **not** built (see [§20](#20-future-improvements)): write tools, HTTP transport, caching, multi-tenant credential storage, UI.

## 5. Prerequisites

- **Node.js 20.6 or newer** (developed and tested on Node 20.20) and npm 10+.
- **For live use only:** a Freshdesk account (a trial account with fictional tickets is fine) and an agent API key. Tests need neither.

## 6. Installation

```bash
git clone https://github.com/Adityaguptawebdev/razorpay-freshdesk-connector.git freshdesk-mcp-connector
cd freshdesk-mcp-connector
npm install
npm run build
```

## 7. Environment variables

Copy the template and fill in your own values. `.env` is git-ignored; never commit it.

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FRESHDESK_DOMAIN` | Yes | – | Your Freshdesk subdomain. Accepts `acme`, `acme.freshdesk.com` or `https://acme.freshdesk.com`. Only `*.freshdesk.com` is allowed. |
| `FRESHDESK_API_KEY` | Yes | – | API key of the Freshdesk agent the connector acts as. |
| `FRESHDESK_MAX_RETRIES` | No | `3` | Retries for 429, 5xx, timeouts and network errors (0–5). |
| `FRESHDESK_MAX_RETRY_WAIT_MS` | No | `20000` | Total time one tool call may spend waiting between retries (1000–60000). |
| `FRESHDESK_REQUEST_TIMEOUT_MS` | No | `10000` | Per-attempt HTTP timeout (1000–60000). |
| `FRESHDESK_INCLUDE_PRIVATE_NOTES` | No | `false` | Expose private agent notes to the AI agent. Keep `false` for customer-facing agents. |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn` or `error`. Logs go to stderr as JSON lines. |

### Getting a Freshdesk API key

1. Sign in to Freshdesk. For testing, create a trial account and add a few tickets with **fictional** data.
2. Click your profile picture (top right) → **Profile settings**.
3. Click **View API Key** (Freshdesk may ask you to complete a captcha) and copy the key into `FRESHDESK_API_KEY`.

The connector can see exactly what that agent can see. In production, create a **dedicated agent with the narrowest role and ticket scope** that the use case needs (for example, restricted to one group), rather than using an admin's key.

Invalid configuration stops the server at startup with every problem listed, never echoing the key:

```text
freshdesk-mcp-connector failed to start.
Invalid configuration:
  - FRESHDESK_DOMAIN is required.
  - FRESHDESK_API_KEY is required.
```

## 8. How to run

```bash
npm install          # install dependencies
npm test             # run the test suite (no credentials needed)
npm run typecheck    # type-check src, tests and scripts
npm run build        # compile to dist/
npm run spec         # regenerate docs/mcp-tools.json from the live tool list
```

### Try it against your Freshdesk account

`npm run demo` starts the built server over stdio, exactly as an agent platform would, and calls it with a minimal MCP client. It reads credentials from `.env`, so run `npm run build` and create `.env` first.

```bash
npm run demo                                         # list the tools
npm run demo -- list_tickets '{"per_page":5}'
npm run demo -- search_tickets '{"status":["open","pending"],"priority":["high","urgent"]}'
npm run demo -- get_ticket '{"ticket_id":1,"include_conversations":true,"include_requester":true}'
```

### MCP Inspector (visual debugging)

```bash
npx @modelcontextprotocol/inspector node --env-file=.env dist/index.js
```

Or headless:

```bash
npx @modelcontextprotocol/inspector --cli node --env-file=.env dist/index.js --method tools/list
```

### Register with an MCP host (Claude Desktop, Cursor, Agent Studio, ...)

The host launches the server and passes credentials via `env`. Use an absolute path:

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": ["/absolute/path/to/freshdesk-mcp-connector/dist/index.js"],
      "env": {
        "FRESHDESK_DOMAIN": "your-subdomain",
        "FRESHDESK_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

`npm start` (`node dist/index.js`) is the same command; it expects the variables to already be in the environment.

## 9. Available MCP tools

All tools carry MCP annotations `readOnlyHint: true`, `destructiveHint: false` and `idempotentHint: true`, have strict input schemas (unknown arguments are rejected) and declare an `outputSchema`. The server also sends usage and safety **instructions** at initialisation. The full JSON Schemas are in [`docs/mcp-tools.json`](docs/mcp-tools.json).

### `list_tickets`

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer 1–300 | `1` | Freshdesk serves at most 300 pages. |
| `per_page` | integer 1–100 | `30` | |
| `filter` | `new_and_my_open` \| `watching` \| `spam` \| `deleted` | – | Freshdesk predefined views. |
| `requester_id` | positive integer | – | |
| `requester_email` | email | – | |
| `company_id` | positive integer | – | |
| `updated_since` | `YYYY-MM-DD` or ISO 8601 date-time | – | Required to see tickets created more than 30 days ago. |
| `order_by` | `created_at` \| `due_by` \| `updated_at` \| `status` | `created_at` | |
| `order_type` | `asc` \| `desc` | `desc` | |

Returns `{ tickets: TicketSummary[], page, per_page, has_more, next_page }`.

### `get_ticket`

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `ticket_id` | positive integer | **required** | |
| `include_conversations` | boolean | `false` | First 10 conversations, oldest first. Costs an extra Freshdesk API credit. |
| `include_requester` | boolean | `false` | Requester `id`, `name`, `email` (phone numbers are not returned). |

Returns `{ ticket: TicketDetail }`. That is the summary fields plus `description_text`, `custom_fields`, `requester`, `conversations` and `private_notes_hidden`.

### `search_tickets`

| Input | Type | Notes |
| --- | --- | --- |
| `status` | array of `open` \| `pending` \| `resolved` \| `closed` | ORed |
| `priority` | array of `low` \| `medium` \| `high` \| `urgent` | ORed |
| `agent_id` / `unassigned` | positive integer / boolean | Mutually exclusive |
| `group_id` | positive integer | |
| `tag`, `type` | string, max 64 chars, letters/numbers/space/`-`/`_`/`.` | Embedded safely in the query |
| `created_from`, `created_to`, `updated_from`, `updated_to` | `YYYY-MM-DD` (UTC, inclusive) | `from` must be ≤ `to` |
| `page` | integer 1–10, default `1` | 30 results per page (Freshdesk-fixed) |

Different filters are ANDed. At least one filter is required. Returns `{ tickets, total, page, per_page, has_more, next_page, query }`.

## 10. Example tool inputs

| What a user asks the agent | Tool call |
| --- | --- |
| "Show me the 5 most recently updated tickets" | `list_tickets {"per_page": 5, "order_by": "updated_at"}` |
| "What tickets has jordan.example@example.com raised?" | `list_tickets {"requester_email": "jordan.example@example.com"}` |
| "Anything urgent or high priority still open or pending?" | `search_tickets {"status": ["open", "pending"], "priority": ["high", "urgent"]}` |
| "Unassigned refund tickets created this month" | `search_tickets {"unassigned": true, "tag": "refund", "created_from": "2026-10-01"}` |
| "Summarise ticket 1001 and the conversation so far" | `get_ticket {"ticket_id": 1001, "include_conversations": true, "include_requester": true}` |

## 11. Example outputs

These are real outputs from the tools, produced against mocked Freshdesk responses with fictional data.

<details open>
<summary><code>search_tickets {"status":["open","pending"],"priority":["high","urgent"],"tag":"refund","created_from":"2026-09-01"}</code></summary>

```json
{
  "tickets": [
    {
      "id": 1001,
      "subject": "Refund not received for order FAKE-ORD-1001",
      "status": "open",
      "status_id": 2,
      "priority": "high",
      "source": "email",
      "type": "Refund",
      "tags": ["refund", "upi"],
      "requester_id": 5001,
      "responder_id": null,
      "group_id": 7001,
      "company_id": null,
      "is_escalated": false,
      "created_at": "2026-09-28T10:15:00Z",
      "updated_at": "2026-09-29T08:00:00Z",
      "due_by": "2026-10-01T10:15:00Z",
      "fr_due_by": "2026-09-28T18:15:00Z"
    }
  ],
  "total": 42,
  "page": 1,
  "per_page": 30,
  "has_more": true,
  "next_page": 2,
  "query": "(status:2 OR status:3) AND (priority:3 OR priority:4) AND tag:'refund' AND created_at:>'2026-09-01'"
}
```

</details>

<details>
<summary><code>list_tickets {"per_page":2}</code></summary>

```json
{
  "tickets": [
    { "id": 1001, "subject": "Refund not received for order FAKE-ORD-1001", "status": "open", "status_id": 2, "priority": "high", "source": "email", "type": "Refund", "tags": ["refund", "upi"], "requester_id": 5001, "responder_id": null, "group_id": 7001, "company_id": null, "is_escalated": false, "created_at": "2026-09-28T10:15:00Z", "updated_at": "2026-09-29T08:00:00Z", "due_by": "2026-10-01T10:15:00Z", "fr_due_by": "2026-09-28T18:15:00Z" },
    { "id": 1002, "subject": "Payment link expired before checkout", "status": "pending", "status_id": 3, "priority": "medium", "source": "portal", "type": "Question", "tags": ["payment-link"], "requester_id": 5001, "responder_id": 8001, "group_id": 7001, "company_id": null, "is_escalated": false, "created_at": "2026-09-27T09:00:00Z", "updated_at": "2026-09-28T11:30:00Z", "due_by": "2026-09-30T09:00:00Z", "fr_due_by": "2026-09-27T17:00:00Z" }
  ],
  "page": 1,
  "per_page": 2,
  "has_more": true,
  "next_page": 2
}
```

</details>

<details>
<summary><code>get_ticket {"ticket_id":1001,"include_conversations":true,"include_requester":true}</code></summary>

The underlying ticket has three conversations. The private internal note is withheld by the default policy and counted in `private_notes_hidden`.

```json
{
  "ticket": {
    "id": 1001,
    "subject": "Refund not received for order FAKE-ORD-1001",
    "status": "open",
    "status_id": 2,
    "priority": "high",
    "source": "email",
    "type": "Refund",
    "tags": ["refund", "upi"],
    "requester_id": 5001,
    "responder_id": null,
    "group_id": 7001,
    "company_id": null,
    "is_escalated": false,
    "created_at": "2026-09-28T10:15:00Z",
    "updated_at": "2026-09-29T08:00:00Z",
    "due_by": "2026-10-01T10:15:00Z",
    "fr_due_by": "2026-09-28T18:15:00Z",
    "description_text": "I was charged but the refund has not arrived.",
    "custom_fields": { "cf_order_id": "FAKE-ORD-1001" },
    "requester": { "id": 5001, "name": "Jordan Example", "email": "jordan.example@example.com" },
    "conversations": [
      {
        "id": 9001,
        "author_role": "customer",
        "private": false,
        "user_id": 5001,
        "created_at": "2026-09-28T12:00:00Z",
        "body_text": "Any update on my refund?"
      },
      {
        "id": 9003,
        "author_role": "agent",
        "private": false,
        "user_id": 8001,
        "created_at": "2026-09-28T13:05:00Z",
        "body_text": "Hi Jordan, your refund was initiated and should arrive within 5-7 business days."
      }
    ],
    "private_notes_hidden": 1
  }
}
```

</details>

<details>
<summary>Errors (<code>isError: true</code>)</summary>

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Ticket 999999 was not found. It may not exist, may have been deleted, or may not be visible to the Freshdesk agent that owns this API key.",
    "retryable": false,
    "http_status": 404
  }
}
```

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Freshdesk API rate limit exceeded (HTTP 429). Freshdesk asked to wait 45s. Waiting another 45s would exceed this connector's retry budget of 20s per call; try again later.",
    "retryable": true,
    "http_status": 429,
    "retry_after_seconds": 45,
    "attempts": 1
  }
}
```

</details>

## 12. Authentication approach

Freshdesk API v2 uses **HTTP Basic auth with the API key as the username** and any placeholder as the password. The connector sends `Authorization: Basic base64("<api-key>:X")` on every request.

- **Source:** environment variables only (`.env` locally, the MCP host's `env` block or a secrets manager in production). Nothing is hard-coded.
- **Validation at startup:** the domain must normalise to `https://<subdomain>.freshdesk.com`. Plain HTTP, ports, paths, embedded credentials and non-Freshdesk hosts are rejected. The key must look like a key (length and character checks, including rejecting the `.env.example` placeholder). Validation messages never echo the key.
- **Containment:** the key lives in a private class field (`#apiKey`) of `FreshdeskCredentials`. `JSON.stringify`, `String()` and `util.inspect` all print `[REDACTED]`. The key and its Base64 form are registered as secrets for log and error redaction.
- **Why API key and not OAuth:** Freshdesk's REST API v2 is authenticated with per-agent API keys. Scoping is therefore done by choosing *which agent's* key to use (see [§7](#getting-a-freshdesk-api-key)). For a hosted, multi-merchant deployment the key would come from a per-merchant secret store (see [§20](#20-future-improvements)).

## 13. Rate-limit handling

Freshdesk enforces per-account, per-minute limits that depend on the plan. When exceeded it returns **HTTP 429** with a **`Retry-After`** header in seconds. It also sends `X-RateLimit-Total`, `X-RateLimit-Remaining` and `X-RateLimit-Used-CurrentRequest`. The connector logs `X-RateLimit-Remaining` at `debug` level.

| Situation | Behaviour |
| --- | --- |
| 429 with `Retry-After` | Wait exactly that long (delta-seconds or HTTP-date), then retry. |
| 429 without `Retry-After`, 5xx, timeout, transient network error | Exponential backoff with equal jitter: 1s, 2s, 4s … (each 50–100% of the step). |
| Retries exhausted (default 3 retries = 4 attempts) | Return `RATE_LIMITED` (or `UPSTREAM_ERROR` / `TIMEOUT`) with `retryable: true`, `attempts` and `retry_after_seconds`. |
| Next wait would push total waiting past the budget (default 20s) | **Fail fast** with `RATE_LIMITED` and `retry_after_seconds` instead of blocking the agent. |
| 400, 401, 403, 404, unknown host, redirects, invalid JSON | Never retried. |

There is no infinite loop: the loop is bounded by both `FRESHDESK_MAX_RETRIES` and `FRESHDESK_MAX_RETRY_WAIT_MS`. Retrying is safe because every request is an idempotent GET. Each retry is logged with its reason and delay source:

```json
{"time":"2026-10-02T10:00:00.000Z","level":"warn","message":"Freshdesk request failed; retrying","path":"/api/v2/tickets","code":"RATE_LIMITED","httpStatus":429,"attempt":1,"maxRetries":3,"delayMs":2000,"delaySource":"retry-after"}
```

With defaults, a rate-limited call waits at most 20s in total. A call hitting repeated timeouts (4 × 10s attempts plus at most 7s of backoff) finishes in under 50s. Both are inside the 60s default request timeout of common MCP clients.

## 14. Error handling

Every failure returned by the tool layer uses one envelope, delivered as an MCP tool error (`isError: true`) so the model can read it and decide what to do:

```json
{ "error": { "code": "…", "message": "…", "retryable": false, "http_status": 404, "retry_after_seconds": 5, "attempts": 4, "details": [] } }
```

Optional fields appear only when relevant.

| Code | Cause | What the agent should do |
| --- | --- | --- |
| `INVALID_INPUT` | Arguments failed validation | Fix the arguments (`details` lists each field) and call again. |
| `INVALID_REQUEST` | Freshdesk rejected the request (400 / other 4xx) | Adjust the request; Freshdesk's field errors are in `details`. |
| `AUTHENTICATION_FAILED` | 401: bad API key or domain | Stop; a human must fix configuration. |
| `PERMISSION_DENIED` | 403: agent role, plan or suspended account | Stop; tell the user the connector lacks access. |
| `NOT_FOUND` | 404 from `get_ticket`: ticket missing or not visible. 404 from `list_tickets` / `search_tickets`: `FRESHDESK_DOMAIN` is not an active Freshdesk account (the message says so) | `get_ticket`: tell the user and verify the ID. List/search: stop; a human must fix configuration. |
| `RATE_LIMITED` | 429 after retries / over the wait budget | Wait `retry_after_seconds`, then retry. |
| `UPSTREAM_ERROR` | 5xx after retries, redirect, malformed response | Retry later if `retryable`, otherwise escalate. |
| `NETWORK_ERROR` / `TIMEOUT` | Freshdesk unreachable or slow | Retry later if `retryable`. |
| `INTERNAL_ERROR` | Unexpected connector bug | Escalate. Details are logged for the operator and never returned to the agent. |

Over MCP, schema violations (wrong types, out-of-range values, unknown keys, missing filters) are rejected by the MCP SDK before the tool runs. They come back as `isError: true` with the field path, e.g. `Input validation error: Invalid arguments for tool get_ticket: Too small: expected number to be >0 at ticket_id`. The structured `INVALID_INPUT` envelope is what the transport-independent tool layer (`runTool`) returns for the same Zod schemas when used without the SDK.

## 15. Testing

```bash
npm test
```

136 tests run in under a second with **no network access and no credentials**. `fetch` is replaced by a queue of mocked Freshdesk responses. `sleep`, jitter and the clock are injected, so retry timings are asserted exactly without real waiting. All fixtures are fictional (`example.com` addresses, `FAKE-ORD-*` order IDs, an obviously fake key).

| Suite | Covers |
| --- | --- |
| `freshdesk-client.test.ts` | Auth header, host, query encoding, pagination; 400/401/403/404/4xx/5xx mapping; Retry-After (seconds and HTTP-date); exponential backoff; exhausted retries; wait-budget fail-fast; timeouts; network errors; DNS failure; refused redirects; invalid and unexpected JSON; no key in errors or logs |
| `tools.test.ts` | Successful list/get/search with normalised output; input validation (bad IDs, ranges, emails, dates, unknown keys, query-injection attempts); private-note policy; truncation; 404, auth and rate-limit errors through the tool layer; internal errors hidden |
| `mcp-server.test.ts` | End-to-end over a real MCP client/server pair: tool listing, annotations, schemas, instructions, structured results, tool errors, unknown tools; `docs/mcp-tools.json` stays in sync |
| `credentials.test.ts`, `config.test.ts` | Domain allow-list and normalisation, key validation, redacted serialisation, env parsing and defaults |
| `search-query.test.ts`, `retry.test.ts`, `logger.test.ts` | Query building, Retry-After parsing, backoff maths, log redaction |

The suite catches regressions in the safety-critical paths. For example, it fails if `Retry-After` is ignored, if private notes leak, if search values can inject query syntax, if 401s are retried, or if redirects are followed.

## 16. What the agent CAN do

- List recent tickets (Freshdesk's default window is the last 30 days; older tickets via `updated_since`), sorted and paginated.
- List all tickets for one requester (by contact ID or email) or one company, or use Freshdesk's predefined views (`new_and_my_open`, `watching`, `spam`, `deleted`).
- Search tickets by status, priority, assigned agent, unassigned, group, tag, type, and created/updated date ranges.
- Read a ticket's subject, status, priority, source, type, tags, assignment, escalation flag, SLA due times, custom fields and plain-text description.
- On request, read the requester's name and email and the first 10 conversations (customer messages and agent replies).
- Understand failures through stable error codes and retry hints, and see the exact Freshdesk query it ran.

## 17. What the agent CANNOT do

- **Write anything:** no creating, updating, replying to, adding notes to, assigning, merging, closing or deleting tickets. No tool for these exists, and the HTTP client only issues `GET` requests.
- **Change customer data:** no tools for contacts, companies or agents.
- Call arbitrary URLs or endpoints, or run raw Freshdesk query strings.
- See **private agent notes**, unless the operator sets `FRESHDESK_INCLUDE_PRIVATE_NOTES=true`.
- See anything the API key's Freshdesk agent cannot see; Freshdesk permissions still apply.
- See requester phone numbers, HTML bodies, attachments, CC lists, satisfaction ratings or time entries.
- Read more than the first 10 conversations of a ticket, or page past Freshdesk's limits (300 search results; 300 list pages).
- Search by free text or by custom fields, or by custom statuses (these appear as `"other"` with their `status_id`).
- Change its own configuration (retry policy, private-note policy, Freshdesk account).

## 18. Security considerations

- **Credentials:** read only from the environment; `.env` is git-ignored and `.env.example` holds placeholders only. The key is held privately, serialises as `[REDACTED]`, and is scrubbed from logs and error payloads by a redactor that knows both the raw key and its Base64 header form.
- **No credential exposure in errors:** error messages are built from status codes and Freshdesk's JSON error fields, never from request headers. Non-JSON error pages are not echoed. Unexpected exceptions become a generic `INTERNAL_ERROR`.
- **Outbound network restricted to one host:** HTTPS only, host allow-listed to `<subdomain>.freshdesk.com`. Tool inputs never contain URLs, and IDs are validated integers. The client also asserts the final URL's origin before sending. **Redirects are refused**, so the `Authorization` header can never be replayed to another host, and every attempt has a timeout.
- **Strict input validation:** all tool inputs have Zod schemas with types, ranges, enums and maximum lengths, and unknown keys are rejected. Search values are restricted to a safe character set, so they cannot break out of their quoted literal.
- **Data minimisation:** requester details and conversations are returned only when asked for. Phone numbers, HTML and CC lists are dropped. Private notes are hidden by default (an operator policy, not a model choice). Long text is truncated.
- **Prompt injection:** ticket text is written by customers and is untrusted. Tool descriptions and server instructions tell the agent to treat it as data. Because the connector is read-only, an injected instruction cannot make it change anything in Freshdesk.
- **Logging:** structured JSON on stderr (stdout is reserved for the MCP protocol). Tool-call logs record tool name, outcome, error code and duration, not arguments, which can contain customer emails.
- **Least privilege:** use a dedicated Freshdesk agent with a narrow role and ticket scope, and rotate its key if it may have been exposed.
- **Test data:** all fixtures and examples are fictional. No real customer data, passwords or keys are in this repository.

## 19. Limitations

- **Read-only by design;** write workflows are out of scope.
- **stdio transport only:** the server runs as a local subprocess of the MCP host. A remotely hosted deployment would need the Streamable HTTP transport plus authentication on the MCP endpoint.
- **One Freshdesk account per process** (one API key). Multi-merchant hosting needs a per-tenant credential store.
- **Freshdesk API constraints apply:** listing defaults to the last 30 days; search is capped at 10 pages × 30 results with day-granularity UTC dates and no free-text search; `get_ticket` embeds at most 10 conversations.
- **Only `*.freshdesk.com` hosts** are accepted; vanity/custom domains are deliberately rejected.
- **Rate limiting is reactive, per process:** the Freshdesk limit is shared with the merchant's other integrations, and there is no proactive throttling or coordination across connector instances.
- **No caching:** every call hits Freshdesk.
- **Tested against mocks:** automated tests use mocked responses modelled on Freshdesk's public API v2 documentation. `list_tickets`, `search_tickets`, `get_ticket` (with requester and conversations), and the 401 and 404 errors were also checked by hand against a Freshdesk trial account with `npm run demo`. Rate limiting (429) and private-note hiding were not exercised live.

## 20. Future improvements

1. **Hosted deployment:** Streamable HTTP transport with OAuth 2.1 on the MCP endpoint, and per-merchant API keys in a secrets manager with rotation.
2. **Proactive rate limiting:** a token bucket informed by `X-RateLimit-Remaining`, shared across instances, plus a circuit breaker during Freshdesk incidents.
3. **More read tools:** paginated `list_conversations` (beyond 10), `get_contact`, and `list_ticket_fields` so the agent can discover custom statuses, types and fields.
4. **Custom-field filters** in `search_tickets` (`cf_*`), validated against the account's ticket fields.
5. **Short-TTL caching** for ticket fields and recently fetched tickets.
6. **Carefully gated write tools** (e.g. add a private note, set status), with human-in-the-loop confirmation, idempotency and an audit log, behind a separate opt-in configuration.
7. **Observability:** OpenTelemetry metrics and traces for latency, 429 rate and error codes per tool.
8. **Contract tests** against a Freshdesk sandbox in CI, plus recorded fixtures.
9. **Distribution:** publish as an npm package or container image with a pinned Node runtime.
