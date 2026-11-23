# Configuration

Every Studio key lives under `studio.*`. The schema `spinajs/studio.configuration.schema.json` validates them at boot, and the configuration fragment of `@spinajs/studio` ships the defaults below.

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `studio.enabled` | `boolean` | `false` | | Mounts Studio. While `false` no Studio route is registered. |
| `studio.allowProduction` | `boolean` | `false` | | Lets Studio mount when `configuration.isProduction` is `true`. Without it Studio refuses and logs an error. |
| `studio.path` | `string` | `'/_studio'` | non-empty | Base path of every Studio route, under `http.controllers.route.prefix` when one is set. |
| `studio.ui.path` | `string` | unset | non-empty | Path of the Studio UI. |
| `studio.buffers.traces` | `integer` | `1000` | `>= 1` | Traces kept in the trace buffer. |
| `studio.buffers.spansPerTrace` | `integer` | `2000` | `>= 1` | Spans kept per trace; later spans are dropped and the trace is marked `truncated`. |
| `studio.buffers.traceBytes` | `integer` | `67108864` (64 MiB) | `>= 1` | Approximate bytes of span data in the trace buffer. |
| `studio.buffers.logs` | `integer` | `5000` | `>= 1` | Log lines kept in the log buffer. |
| `studio.buffers.slowQueries` | `integer` | `200` | `>= 1` | Slow queries kept in the slow-query buffer. |
| `studio.captureBindings` | `boolean` | `false` | | Keeps SQL bindings (`db.query.parameter.*` span attributes). Off, they are dropped before a span is buffered. |
| `studio.redactAttributes` | `string[]` | `['http.request.header.authorization', 'http.request.header.cookie']` | attribute names | Span and event attributes, and log fields, stored as `[redacted]`. |
| `studio.auth.domain` | `string` | `'root'` | an authz domain | The domain the `'AccessPolicy'` slots check in. |
| `studio.auth.skipInDevelopment` | `boolean` | `false` | | Skips the `'AccessPolicy'` checks while the configured env names development and `configuration.isProduction` is not `true`. |
| `studio.auth.policies.<endpoint>` | `string` | `'AccessPolicy'` | `'AccessPolicy'` or a registered `BasePolicy` name | The guard of one endpoint. `'AccessPolicy'` checks `studio.auth.permissions.<endpoint>`. |
| `studio.auth.permissions.<endpoint>` | `string \| string[]` | `'studio:read'`; `'studio:explain'` for `explain` | permissions | What an `'AccessPolicy'` endpoint requires; any one permission of a list admits. |

The endpoints are `capabilities`, `traces`, `logs`, `queries`, `di`, `routes`, `authz`, `explain` and `ui`.

## Memory bound of the trace buffer

The trace buffer holds at most:

- `studio.buffers.traces` traces,
- `studio.buffers.spansPerTrace` spans in each,
- `studio.buffers.traceBytes` bytes of span data in total.

The size of a span is estimated by `approximateBytes()`: two bytes per UTF-16 unit of its name, status message, attribute keys and values and events, plus a fixed overhead. Past the byte budget the first buffered traces go. The trace being written stays, so one trace can exceed the budget by at most `spansPerTrace` spans.

## Example

A staging server that shows SQL bindings and masks a tenant header:

```ts sample
const config = {
  studio: {
    enabled: true,
    captureBindings: true,
    redactAttributes: ['http.request.header.authorization', 'http.request.header.cookie', 'http.request.header.x-tenant-key'],
    buffers: {
      traces: 500,
      traceBytes: 32 * 1024 * 1024,
    },
  },
};

export default config;
```

## Related

- [Overview](01-overview.md): enabling Studio, permissions and how spans are recorded.
