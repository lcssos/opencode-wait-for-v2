---
name: Wait
description: Use when a task must wait for an external condition instead of fixed sleep loops - a log line, file state, process exit, TCP port, or HTTP response. Covers wait_for modes, conditions, defaults, timeout results, and verification.
---

# Wait

`wait_for` blocks until an external condition holds and returns as soon as it
does. Use it instead of `sleep N` followed by repeated `tail`/`ps` polls. In
Code Mode call `tools.wait_for`; a host that exposes the tool directly calls
`wait_for`.

## When to use

- after starting a background process, build, test, or service
- waiting for CI, a deployment, a registry version, or a package
- before reading a file another process is still writing
- whenever a fixed `sleep N` would be a guess

Do not use it for arbitrary shell predicates; it never runs a shell.

## Call shapes

At least one of `path`, `pid`, or `condition` is required.

| Need | Shape |
|---|---|
| Log line | `wait_for({ path, pattern, timeout_ms })` |
| New log content only | `wait_for({ path, pattern, must_be_new: true })` |
| Process exit | `wait_for({ pid, timeout_ms })` |
| Process + log | `wait_for({ pid, path, pattern })` |
| File/port/HTTP | `wait_for({ condition: { type, ... } })` |

`condition` takes precedence over `path`, `pattern`, `pid`, and `must_be_new`.

## Conditions

| `type` | Required | Optional |
|---|---|---|
| `file_exists` | `path` | `stableForMs` |
| `file_absent` | `path` | |
| `file_changed` | `path` | `since`, `stableForMs` |
| `file_contains` | `path`, `pattern` | `regex`, `mustBeNew` |
| `process_exited` | `pid` | |
| `process_running` | `pid` | |
| `port_open` | `host`, `port` | |
| `port_closed` | `host`, `port` | |
| `http_status` | `url` | `status`, `headers` |
| `http_json` | `url`, `jsonPath`, `equals` | `headers` |
| `http_body_contains` | `url`, `pattern` | `regex`, `headers` |

`status` is a number or array; omit it for any 2xx. `jsonPath` accepts dots and
brackets (`status`, `jobs[0].state`). `regex` defaults to false (literal match).

## Defaults and limits

- `timeout_ms` 240000, capped at 600000.
- `poll_ms` 500, minimum 100.
- `tail_lines` 60.
- Logs: last 64 KB; with `must_be_new`, up to 256 KB of new content.
- HTTP bodies: 256 KB; each attempt times out after 2–10 s.
- Relative paths resolve against the session directory.

## Results

- Condition waits: text starts `[wait_for] condition met`, `[wait_for] timed out`,
  or `[wait_for] aborted`. Metadata carries `hit`, `reason`, `attempts`, and the
  last `observed` state when the host exposes it.
- Legacy waits: text plus metadata (`hit`, `reason`, `waited_ms`, `idle_ms`,
  `path`, `pid`); `pidAlive` distinguishes slow from stuck.
- A timeout is normal. Check `observed` or `pidAlive` before deciding to wait
  again; do not immediately repeat the same call.

## Recipes

```js
// build/test end marker
await tools.wait_for({ path: "/tmp/build.log", pattern: "BUILD (SUCCESS|FAILURE)", timeout_ms: 600000 })

// only content written after the call
await tools.wait_for({ path: "/tmp/deploy.log", pattern: "ready", must_be_new: true })

// process exit
await tools.wait_for({ pid: 12345, timeout_ms: 300000 })

// local service
await tools.wait_for({ condition: { type: "port_open", host: "127.0.0.1", port: 3000 }, timeout_ms: 30000 })

// CI status
await tools.wait_for({
  condition: { type: "http_json", url: "https://api.github.com/repos/org/repo/actions/runs/123", jsonPath: "status", equals: "completed" },
  timeout_ms: 300000,
  poll_ms: 5000,
})
```

## Gotchas

- It polls; detection can take up to `poll_ms`.
- `file_contains` is a tail search, not a full-file scan. A match older than the
  last 64 KB is missed unless `must_be_new` and the content is in the new range.
- `file_changed` compares size and mtime; a same-size same-mtime rewrite may not
  trigger it.
- `stableForMs` avoids matching a file another process is still writing.
- `port_open` only proves a TCP listener; use `http_status`/`http_json` for
  application readiness.
- `process_*` uses PID liveness; PIDs can be reused.
- `http_json` compares the complete value deeply, not a subset.
- Unauthenticated GitHub API calls are limited to 60/hour; use `poll_ms: 5000`
  or `headers`.

## Verification

An already-true condition returns quickly:

```js
const text = String(await tools.wait_for({ condition: { type: "file_exists", path: "/tmp/ready" }, timeout_ms: 1000 }))
text.startsWith("[wait_for] condition met")
```

A condition that never happens returns a timeout result, not an exception:

```js
const text = String(await tools.wait_for({ condition: { type: "file_exists", path: "/tmp/never" }, timeout_ms: 250, poll_ms: 100 }))
text.startsWith("[wait_for] timed out")
```
