# Ambient log context

`setLogContextProvider()` installs one function that returns fields to add to every log entry, such as the current request id. `createLogMessageObject()` calls it for each entry and merges the result at the lowest precedence. Use it to tag logs with request, job or tenant data without passing it to every log call.

## How it works

1. **Install.** `setLogContextProvider(fn)` replaces the module-level provider. The default returns `{}`.
2. **Call.** For each entry, `createLogMessageObject()` calls the provider. A throw, `null` or `undefined` counts as `{}`.
3. **Merge.** The fields are spread first, so the core fields (`error`, `level`, `logger`, `message`), logger variables and per-call fields override any field of the same name.
4. **Template scope.** The fields reach the target layout (`${requestId}`), but not the `${...}` message template of a structured call; see [Log entries](03-log-entries.md#rendertemplate-rules).

## API

| Export | Signature | Meaning |
| --- | --- | --- |
| `setLogContextProvider` | `(fn: () => Record<string, unknown>) => void` | Replaces the provider for the whole process or page. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Log context provider | Not in DI; one module-level function, process-wide | `() => ({})` | `@spinajs/log` (Node): `LogBotstrapper.bootstrap()` installs `() => scalarContext(LogContext.active())`, reading the `AsyncLocalStorage` store the HTTP module runs each action in. `@spinajs/log` (browser entry): the same, installed on import, with a synchronous store. | Call `setLogContextProvider()` again. The last call wins. There is no getter, so a new provider cannot wrap the previous one. |

### Custom provider

Install your own provider when no `@spinajs/log` context store is available: a browser app without the HTTP module, a worker, or a CLI that runs jobs.

- Return only scalar values (strings, numbers, booleans). Targets render objects as JSON, and `@spinajs/log`'s own provider drops non-scalars for the same reason.
- Keep it cheap: it runs on every entry that passes the level gate.
- Install it **after** `@spinajs/log` bootstraps or is imported, or that package overwrites it. To add fields while keeping the `@spinajs/log` store, put them in `LogContext` (see [`@spinajs/log`](../log/README.md)) instead of replacing the provider.

```ts sample
import { createLogMessageObject, LogLevel, setLogContextProvider } from '@spinajs/log-common';

// The CLI runs one job at a time; every log line of a job carries its id and tenant.
const currentJob: { jobId?: string; tenant?: string } = {};

setLogContextProvider(() => ({ ...currentJob }));

async function runJob(jobId: string, tenant: string, work: () => Promise<void>): Promise<void> {
  currentJob.jobId = jobId;
  currentJob.tenant = tenant;
  try {
    await work();
  } finally {
    delete currentJob.jobId;
    delete currentJob.tenant;
  }
}

void runJob('job-17', 'acme', async () => {
  const entry = createLogMessageObject('Invoices exported', '', LogLevel.Info, 'jobs', {});
  console.log(entry.Variables.jobId, entry.Variables.tenant); // job-17 acme
});
```

## Important behaviour

- The provider is global. In Node, a module-level object as in the sample above is shared by every concurrent async flow; use `AsyncLocalStorage` (what `@spinajs/log` does) when work runs concurrently.
- A provider that throws never breaks logging: its fields are skipped for that entry.
- Provider fields go through the [serializers](05-serializers.md) like every other field.
- The package itself never imports `node:async_hooks`; the seam exists so the async store stays in `@spinajs/log`.

## Best practices

- Name context fields so they do not clash with logger variables you set with `addVariable()`; the logger variable wins silently.
- Reference context fields in the layout with a conditional block, eg. `${?requestId} [${requestId}]${/requestId}`, so lines outside a request stay clean.

## Related

- [Log entries](03-log-entries.md): the merge order.
- [Perf instrumentation](09-perf-instrumentation.md#perf-scope-backend-custom-implementation): the matching seam for per-request perf rollups.
- [`@spinajs/log`](../log/README.md): `LogContext` and `scalarContext()`.
