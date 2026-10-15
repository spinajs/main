# @spinajs/scheduler-http

HTTP API and live Server-Sent Events stream for [`@spinajs/scheduler`](../scheduler). Every endpoint calls one
`SchedulerService` method and returns its result unchanged, the same method the `scheduler:*` CLI commands call.

## Install

```bash
npm install @spinajs/scheduler @spinajs/scheduler-http
```

The package configuration adds its controllers to `system.dirs.controllers` and grants every scheduler
permission to `admin` through the `admin.scheduler` sub-role.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `scheduler.http.sse.heartbeat` | `15000` | ms between `: ping` comments on open event streams; `0` disables |

## Permissions (2.x `rbac-http`)

All routes require an authorized session (`AuthorizedPolicy`) and a grant on the rbac resource `scheduler`:

| Tier | Grant | Routes |
|---|---|---|
| read | `read:any` | lists, details, error groups, live events |
| run | `update:any` | run now, cancel, retry, retry failed |
| manage | `delete:any` | pause, resume, error status, prune |

```ts
rbac: {
  grants: {
    'scheduler-operator': { scheduler: { 'read:any': ['*'], 'update:any': ['*'] } },
  },
}
```

Every mutating call records the caller as `triggeredBy` (`kind: 'user'`, or `'token'` for api-token requests).

## Endpoints

| Method | Path | Tier | Answer |
|---|---|---|---|
| GET | `/scheduler/schedules` | read | 200 `ScheduleInfo[]` |
| GET | `/scheduler/schedules/:name` | read | 200 `ScheduleDetail`, 404 |
| POST | `/scheduler/schedules/:name/runs` `{ params?, force?, wait? }` | run | 202 `{ runId }`; 200 `{ runId, run }` with `wait`; 400 `{ errors }`; 404; 409 `{ runId }` |
| POST | `/scheduler/schedules/:name/retry-failed` `{ since }` | run | 202 `{ runIds }` |
| POST | `/scheduler/schedules/:name/pause` `{ hard? }` | manage | 200 `ScheduleInfo` |
| POST | `/scheduler/schedules/:name/resume` | manage | 200 `ScheduleInfo` |
| GET | `/scheduler/schedules/:name/events` | read | SSE |
| GET | `/scheduler/runs?schedule=&status=&trigger=&from=&to=&limit=&offset=` | read | 200 `{ items, total, limit, offset }` |
| GET | `/scheduler/runs/:id` | read | 200 `RunDetail`, 404 |
| GET | `/scheduler/runs/:id/events` | read | SSE |
| POST | `/scheduler/runs/:id/cancel` | run | 202 `RunInfo`, 409 if it ended |
| POST | `/scheduler/runs/:id/retry` `{ fromStep?, params?, resume? }` | run | 202 `{ runId }`, 409 if not retryable |
| GET | `/scheduler/errors?schedule=&status=` | read | 200 `ErrorGroupInfo[]` |
| PATCH | `/scheduler/errors/:fingerprint` `{ status }` | manage | 200 `ErrorGroupInfo`, 404 |
| POST | `/scheduler/prune` | manage | 200 `PruneResult` |

Statuses for service errors follow `httpStatusForError()` of `@spinajs/scheduler`. `wait: true` holds the HTTP
request until the run ends; follow long runs through the event stream instead.

## Live updates (Server-Sent Events)

```ts
const source = new EventSource(`/scheduler/runs/${runId}/events`, { withCredentials: true });
source.addEventListener('progress', (e) => render(JSON.parse(e.data)));
source.addEventListener('status', (e) => {
  const { status } = JSON.parse(e.data);
  // isTerminalStatus() of @spinajs/scheduler; `retrying` and `emitted` are not final, so keep listening
  if (['succeeded', 'failed', 'dead', 'aborted', 'skipped', 'misfired'].includes(status)) source.close();
});
```

```bash
curl -N -H 'Accept: text/event-stream, application/json;q=0.5' -H 'Last-Event-ID: 12' \
  --cookie "ssid=$SSID" http://localhost:1337/scheduler/runs/$RUN_ID/events
```

- Events: `status`, `step-start`, `step-end`, `progress`, `message`, `log`, `error`; `data` is the event as JSON.
- Run stream: `id` is the run event `seq`. Without `Last-Event-ID` the stream starts with the run's history; a
  reconnect with `Last-Event-ID` (`EventSource` sends it on its own) replays only the missed events. Replay reads
  the scheduler's event journal, so it works on any replica. The stream ends after the terminal `status` event; it
  stays open through `retrying` (automatic retries keep the same run id) and `emitted`. An emitted run can still
  end `failed` (reason `emit-timeout`) or `aborted` (reason `cancelled`) without its queue job; both are terminal
  and close the stream. Close the `EventSource` yourself on the terminal status, or it reconnects to a stream that
  ends at once.
- Schedule stream: all runs of a schedule; `id` is the global event position, which becomes visible in commit
  order on every replica. Without `Last-Event-ID` only new events are sent; with it, every event of the schedule
  after that id is replayed first, on whichever replica the reconnect lands, with nothing lost. The stream stays open.
- Progress: stored `progress` events are capped per run. After the cap, a running run still sends its latest value
  per step as `progress` events with `"synthetic": true`; they repeat the last `id`, so a reconnect resumes at the
  last real event and still shows the current percentage.
- Heartbeat: a `: ping` comment every `scheduler.http.sse.heartbeat` ms keeps proxies from closing idle streams.
  Responses carry `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, so compression and nginx
  buffering stay out of the way.
- Errors: a client that accepts only `text/event-stream` gets `406` instead of `401/403/404`, because error
  bodies are JSON or HTML. Send `Accept: text/event-stream, application/json;q=0.5` to receive the real status.
- Open streams are closed, and their connections dropped, when the HTTP server shuts down, so `stop()` does not
  wait for its watchdog.
- The CLI follows the same stream: with `scheduler.cli.http.baseUrl` set, `scheduler:run --follow` and
  `scheduler:run:show --follow` read `/scheduler/runs/:id/events` and resume with `Last-Event-ID`.

## Moving to authz-v3 (planned)

This release targets 2.x `rbac-http`. Once authz-v3 is merged, the routes move to
`@Access('scheduler:read' | 'scheduler:run' | 'scheduler:manage')` (`SCHEDULER_PERMISSIONS` of the core) instead of
`@Policy(AuthorizedPolicy)` + `@Resource` + `@Permission`, and the grants move from `rbac.grants` to authz. Not done yet.
