# Chat proxy smoke tests

Automated regression gate for M2-01 security guarantees. Satisfies decision **D-13**.

## Run

```bash
cd api
npm test
```

The harness:

1. Starts `mock-openrouter.js` on a random local port (stdlib `http`, 127.0.0.1).
2. Spawns `chat-proxy.js` with `OPENROUTER_URL` pointed at the mock, `OPENROUTER_API_KEY=test-dummy`, `CHAT_PORT=3861`, and a throwaway `TOKEN_BUDGET_PATH=/tmp/iam-test-budget.json`.
3. Waits for the proxy port, then fires four cases via `fetch`.
4. Kills the proxy and the mock on exit (both success and failure paths).

## What the four cases prove

| Case | Request                                | Expected | Decision covered                              |
| ---- | -------------------------------------- | -------- | --------------------------------------------- |
| (a)  | allowed origin, valid payload          | HTTP 200 | D-06 (CORS allowlist), D-09 (server-side KB)  |
| (b)  | disallowed origin (`evil.example.com`) | HTTP 403 | D-06                                          |
| (c)  | body >32KB                             | HTTP 413 | D-08 (size cap)                               |
| (d)  | 12 rapid requests from one IP          | HTTP 429 | D-07 (rate limit, max 10/min)                 |

Case (a) additionally asserts that the body the mock received from the proxy contains the string `Inter Active Move` — this proves the system prompt and knowledge base are prepended server-side (D-09) rather than supplied by the client.

## Hard rule: no live upstream

The suite must never reach the live OpenRouter host. The proxy honors `OPENROUTER_URL` (see `api/chat-proxy.js`), and the harness sets it to the mock's loopback URL. If a future change hardcodes the live host or drops the env override, this suite will either hang (connecting to the internet) or report the mock received zero requests — both surface the regression.

Safeguard: grepping this directory for the live host's domain name must return nothing.
