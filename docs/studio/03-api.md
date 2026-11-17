# API

Every Studio route is served under `studio.path` (default `/_studio`), below `http.controllers.route.prefix` when one is set. Each route is guarded by its slot `studio.auth.policies.<endpoint>`; see [Permissions](01-overview.md#permissions).

The response types are exported from `@spinajs/studio/contracts`, which holds types only. A query or path value that fails its schema is answered `400`.

## `GET /api/capabilities`

Endpoint `capabilities`. Answers `StudioCapabilities`: the Studio version, the loaded manifest, the tracing owner and whether spans are recorded, the features this app has (`traces`, `logs`, ...) and the Studio permissions the caller holds.

## `GET /api/traces`

Endpoint `traces`. Buffered traces, newest first, as `StudioPage<TraceSummary>`.

| Parameter | Value |
| --- | --- |
| `route` | The `http.route` of the root span, matched exactly. |
| `name` | Part of the root span name. |
| `status` | `error`: traces with an error span; `ok`: traces without one. |
| `minDurationMs` | Shortest duration of the trace, in milliseconds, up to one day. |
| `principalId` | The first `spina.principal.id` recorded in the trace. |
| `from`, `to` | ISO dates; the trace started in this range. |
| `limit` | 1 to 500; default 50. |
| `cursor` | The `cursor` of the previous page. |

`cursor` is opaque: send back what the previous page returned. A page without `cursor` is the last one. An empty value counts as absent.

A summary with `complete: false` belongs to a trace whose root span has not ended yet.

## `GET /api/traces/:traceId`

Endpoint `traces`. One trace as `TraceDetail`: its summary, its spans, the buffered log lines that carry its trace id (oldest first), and `truncated`, which is `true` when spans are missing.

`traceId` is 32 lower-case hex digits; anything else is a `400`. A trace that is not in the buffer is a `404`.

The `traces` guard covers the trace's log lines: restrict `logs` and `traces` together.

## `GET /api/traces/stream`

Endpoint `traces`. A server-sent event stream: one `trace` event per finished root span, with the trace id as the event id and a `TraceSummary` as data.

```
id: 4bf92f3577b34da6a3ce929d0e0e4736
event: trace
data: {"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","rootName":"GET /orders", ...}
```

- Access is checked when the stream opens. The server closes a stream after 15 minutes (`TRACE_STREAM_MAX_MS`); `EventSource` reconnects, and the access check runs again.
- At most 16 streams (`MAX_TRACE_STREAMS`) are open at once. A further one is answered `503` with the code `studio.trace_streams`.
- A `: ping` comment is sent every 15 seconds, so proxies keep the connection open.
- A client that does not read fast enough misses events; the next event it can take is sent.
- A refused stream is answered `406` to an `EventSource`, which accepts only `text/event-stream`. The refusal itself is seen with `Accept: application/json`.

Studio's own requests are never streamed.

## `GET /api/logs`

Endpoint `logs`. Buffered log lines, newest first, as `StudioPage<StudioLogLine>`. Lines are buffered only when the app routes logs to `StudioLogTarget`; see [Logs](01-overview.md#logs).

| Parameter | Value |
| --- | --- |
| `traceId` | 32 lower-case hex digits: only lines of this trace. |
| `level` | A log level name (`trace` to `security`): this level and above. |
| `limit` | 1 to 1000; default 200. |

## Typed calls

```ts sample
import type { StudioPage, TraceDetail, TraceSummary } from '@spinajs/studio/contracts';

export async function failedTraces(base: string): Promise<TraceDetail[]> {
  const res = await fetch(`${base}/_studio/api/traces?status=error&limit=20`, { credentials: 'include' });
  const page = (await res.json()) as StudioPage<TraceSummary>;
  const details: TraceDetail[] = [];
  for (const summary of page.items) {
    const detail = await fetch(`${base}/_studio/api/traces/${summary.traceId}`, { credentials: 'include' });
    details.push((await detail.json()) as TraceDetail);
  }
  return details;
}
```

## Related

- [Overview](01-overview.md): enabling Studio, permissions, traces and logs.
- [Configuration](02-configuration.md): every `studio.*` key.
