# Overview

Spina Studio is a guarded HTTP API, mounted inside your app, over what one process knows about itself: its recent traces and log lines, the DI graph, routes and the authz model. It also serves the Studio UI, a browser app over that API (see [The UI](#the-ui)). Use it on a developer machine or a staging server.

It is **not** an APM. Nothing is persisted: every buffer lives in process memory and is lost on restart. Several instances of an app each show only their own data.

## Enabling it

1. Import `@spinajs/studio` once, for example in the app entry. The import registers `StudioControllerSource`, which hands the Studio controllers to `@spinajs/http`.
2. Set `studio.enabled: true`. Studio is off by default; while it is off no Studio route is registered at all.
3. In production (`configuration.isProduction: true`) Studio refuses to mount and logs an error, unless `studio.allowProduction: true` is set as well.

```ts sample
const config = {
  studio: {
    enabled: true,
    // served under http.controllers.route.prefix, when one is set
    path: '/_studio',
  },
};

export default config;
```

Every key is listed in [Configuration](02-configuration.md).

## Permissions

Every Studio route is checked through the slot `studio.auth.policies.<endpoint>`. The default slot value `'AccessPolicy'` checks the permissions in `studio.auth.permissions.<endpoint>` in the authz domain `studio.auth.domain`.

| Permission | Grants |
| --- | --- |
| `studio:read` | Every read endpoint: capabilities, traces, logs, slow queries, the DI graph, routes, the authz model, the UI. |
| `studio:explain` | Authz explain from Studio. `authz:explain` is checked as well. |

The configuration fragment of `@spinajs/studio` declares both permissions and two RBAC roles, which `@spinajs/authz-rbac` reads when the app loads it:

| Role | Extends | Grants |
| --- | --- | --- |
| `studio` | | `studio:read` |
| `studio.explain` | `studio` | `studio:explain` |

`studio.auth.skipInDevelopment: true` skips the `'AccessPolicy'` checks while the configured env names development and `configuration.isProduction` is not `true`.

## Explain in production

`POST /api/authz/explain` answers why any principal the caller names is allowed or denied a permission: its effective roles on the resource, the conditions left on the decision and every model's vote. In production that is more than an operator usually needs, so the route has a flag of its own, next to `studio.allowProduction`:

| `configuration.isProduction` | `studio.allowExplainInProduction` | Explain |
| --- | --- | --- |
| `false` | any | Registered; the `explain` feature of `GET /api/capabilities` is `true`. |
| `true`, with `studio.allowProduction` | not `true` | Not registered: the route answers `404`, `explain` is `false`, every other Studio route works. |
| `true`, with `studio.allowProduction` | `true` | Registered; `explain` is `true`. |

Registered, the route still needs `studio:explain` and `authz:explain`; `studio.auth.skipInDevelopment` skips only the first. The explain route of `@spinajs/authz-http` (`GET /authz/explain`) is never registered in production.

## The UI

Studio serves the prebuilt Studio UI, the package `@spinajs/studio-ui`, under `studio.path`: open `/_studio/` in a browser. Every UI path is guarded by the slot `studio.auth.policies.ui`, which checks `studio:read` by default, like the API.

The UI is not a dependency of `@spinajs/studio`. Either:

- install `@spinajs/studio-ui` from the coderush GitLab registry. Map the `@spinajs` scope to the coderush group endpoint in `.npmrc`, then install it as usual:

  ```
  @spinajs:registry=https://<gitlab host>/api/v4/groups/<coderush group id>/-/packages/npm/
  ```

- or set `studio.ui.path` to an unpacked `dist/`: a directory holding the UI's `index.html` and its files.

Without the UI the API keeps working, and every UI path answers `404` with the install hint. A disabled Studio, or one refused in production, serves no UI file either: it registers no route at all.

## Traces

Studio buffers the spans of the last traces in a `TraceStore`. A `StudioSpanProcessor` feeds it; Studio attaches that processor to the `@spinajs/tracing` span processor hub when it mounts.

1. `StudioControllerSource.getControllers()` resolves `TraceStore` before it hands out the controllers.
2. `TraceStore.resolve()` reads the `studio.*` configuration and calls `tracingState().hub.add(new StudioSpanProcessor(...))`.
3. When a span starts, the store notes its trace and whether it belongs to a Studio request; when it ends, the processor converts it (`toStudioSpan()`) and hands it to the store.
4. The store groups spans by trace id and keeps per-trace counters: span count, error count, end time and the first `spina.principal.id`.

What is kept, and what is cut:

- At most `studio.buffers.traces` traces, `studio.buffers.spansPerTrace` spans per trace and about `studio.buffers.traceBytes` bytes of span data. Past a limit the first buffered trace goes.
- A trace past `spansPerTrace`, or one whose spans arrive after it was evicted, is marked `truncated`.
- Attributes named in `studio.redactAttributes` are stored as `[redacted]`.
- Every attribute value, span name and status message longer than 2 KiB (`MAX_ATTRIBUTE_BYTES`) is cut and ends with `…`.
- SQL bindings (`db.query.parameter.*`) are dropped unless `studio.captureBindings: true`.
- Nanosecond times and durations are decimal strings.

### Studio switches span recording on

While nothing is attached to the `@spinajs/tracing` hub, the app runs id-only: spans carry ids, nothing is recorded, and outbound `traceparent` headers end in `-00` (not sampled).

Studio attaches its processor when it mounts. From then on spans are recorded for the whole app, and outbound `traceparent` headers end in `-01`. Downstream services that honour the flag start recording too.

`tracing.sampler` still decides per trace:

- `tracing.sampler.type: 'never'`: nothing is recorded, the traces page stays empty, and the `traces` feature is `false`.
- A ratio sampler, or a caller that sends `-00` under the default parent-based sampler: that trace is not recorded.

### Studio is not an audit trail

A trace can be missing: the sampler dropped it, a caller asked for it not to be sampled, the buffer evicted it, or the process restarted. Requests to Studio itself are never recorded. Use the authz decision log and audit for anything that must be complete.

### An app-owned OpenTelemetry SDK

When the app registers its own OpenTelemetry tracer provider before `@spinajs/tracing` starts, tracing reports the owner `external` and has no hub to attach to. Add `studioSpanProcessor()` to that SDK instead. Recording then follows that SDK's sampler.

```ts sample
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { studioSpanProcessor } from '@spinajs/studio';

const provider = new BasicTracerProvider({
  spanProcessors: [studioSpanProcessor()],
});
trace.setGlobalTracerProvider(provider);
```

The processor looks up the resolved `TraceStore` on every span. Spans that end before Studio mounted are dropped.

## Logs

Studio buffers log lines only when the app routes them to the logger target `StudioLogTarget`. Add it to `logger.targets` and route a rule to it:

```ts sample
const config = {
  logger: {
    targets: [
      { name: 'Console', type: 'ConsoleTarget' },
      { name: 'Studio', type: 'StudioLogTarget' },
    ],
    rules: [
      { name: '*', level: 'info', target: 'Console' },
      { name: '*', level: 'debug', target: 'Studio' },
    ],
  },
};

export default config;
```

The `logs` feature of `GET /api/capabilities` is `true` while a target of type `StudioLogTarget` is configured.

What the target keeps:

- every line that carries a trace id (`traceId`, or the older `trace_id`), and every warning and above without one;
- never a line written inside a Studio request. A Studio request the sampler did not record is not recognised: its lines with a trace id, and its warnings, are kept. Any caller can cause this by sending an unsampled `traceparent` (ending in `-00`).

Each line keeps its level, logger, message, trace and span ids, and its scalar fields (strings, numbers, booleans); objects are dropped. Fields named in `studio.redactAttributes` are stored as `[redacted]`; redaction goes by field name only. The default list names span attributes only, so it matches no log field, and the message is kept as rendered: a value interpolated into it is not redacted. A logged error becomes the field `error`, `"<name>: <message>"`.

Memory bound: at most `studio.buffers.logs` lines (default 5000). The message and every string field are cut at 2 KiB, and a line keeps at most 8 KiB (`MAX_LOG_LINE_BYTES`) of field data; the fields past it are dropped.

`GET /api/traces/:traceId` answers the lines of that trace with its spans, and `GET /api/logs` lists the buffer. See [API](03-api.md).

## Related

- [API](03-api.md): every Studio route.
- [Configuration](02-configuration.md): every `studio.*` key.
- [`@spinajs/authz-http`](../authz-http/README.md): `AccessPolicy`, which the `'AccessPolicy'` slot uses.
