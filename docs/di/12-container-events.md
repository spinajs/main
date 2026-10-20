# Container events

Every container is an `EventEmitter` and announces registrations, first resolutions and disposal. Subscribe to react when a service appears, eg. to configure an instance once it is built or to log what the app wires up.

## How it works

1. `Binder` methods emit `di.registered.<Name>` with the registered implementation or value, once for the implementation's name and once for the key's name.
2. A resolve emits `di.resolved.<Name>` with `(container, instance)`:
   - for a singleton-like lifetime, once, when the instance is created and cached, from the container that caches it (the owner);
   - for `@NewInstance()`, on every resolve, from the resolving container.

   It is emitted for the concrete class name and, when different, for the requested key's name.
3. `dispose()` emits `di.dispose` with no arguments after the cache is cleared.
4. `DI.on`, `DI.once`, `DI.off` and the other `DI.*` listener functions work on the root container only. Listen on a child with `child.on(...)`.

## Events

| Event | Arguments | Emitted by |
| --- | --- | --- |
| `di.registered.<ImplementationName>` | the implementation | `as()`, `asSelf()`, `asMapValue()` |
| `di.registered.<KeyName>` | the implementation or value | `as()`, `asValue()`, `asMapValue()` |
| `di.resolved.<ClassName>` | `container`, `instance` | First creation of a cached instance; every `@NewInstance()` resolve |
| `di.resolved.<KeyName>` | `container`, `instance` | Same, when the key differs from the class name |
| `di.dispose` | none | `container.dispose()` |

Factory results and values emit no `di.resolved.*` event.

## `EventEmitter`

The container ships its own platform-free `EventEmitter`, so it runs in browsers without Node's `events` module. It has the Node surface used across the framework: `on`, `addListener`, `once`, `prependListener`, `prependOnceListener`, `off`, `removeListener`, `removeAllListeners`, `emit`, `listeners`, `rawListeners`, `listenerCount`, `eventNames`, `setMaxListeners`, `getMaxListeners`.

| Difference from Node | Effect |
| --- | --- |
| No special `'error'` event | Emitting `'error'` with no listener does not throw |
| Leak warning | More than `getMaxListeners()` (default 10) listeners for one event logs a `console.warn`; `setMaxListeners(0)` turns it off |

`EventEmitter` is exported, so other packages extend it for their own platform-free emitters.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Resolve hook | Event `di.resolved.<Name>` on the owning container | none | none | `DI.on('di.resolved.Mailer', (container, mailer) => ...)` to configure or wrap an instance once, after it is built |
| Registration hook | Event `di.registered.<Name>` | none | none | `DI.on('di.registered.HealthCheck', (impl) => ...)` to track plugins as their modules load |

### Configure a service once it is built

```ts sample
import { DI, IContainer, Injectable } from '@spinajs/di';

abstract class HttpClient {
  public Headers: Record<string, string> = {};
}

@Injectable(HttpClient)
class FetchClient extends HttpClient {}

DI.on('di.resolved.HttpClient', (...args: unknown[]) => {
  const [, client] = args as [IContainer, HttpClient];
  client.Headers['user-agent'] = 'billing-service/1.4';
});

console.log(DI.resolve(HttpClient).Headers, FetchClient.name);
// { 'user-agent': 'billing-service/1.4' }
```

## Important behaviour

- `di.resolved.*` fires once per cached instance. A listener added after the singleton was built never sees it; check `DI.get(Key)` as well.
- A singleton registered in the root and resolved through a child emits on the **root**, not on the child.
- Listeners run synchronously inside `register()` and `resolve()`. A throwing listener aborts that call.
- An `AsyncService` emits after its `resolve()` finished.
- `DI.clear()` does not remove listeners; `DI.removeAllListeners()` does.

## Best practices

- Subscribe in a bootstrapper or at the top of the entry file, before anything resolves the service.
- Use `once` for one-time setup; `on` keeps firing for `@NewInstance()` classes.
- Raise `setMaxListeners` deliberately when many modules listen to one event, instead of ignoring the warning.

## Examples

### Log every plugin as it registers

```ts sample
import { DI, Injectable } from '@spinajs/di';

abstract class ExportFormat {
  public abstract readonly Extension: string;
}

const loaded: string[] = [];
DI.on('di.registered.ExportFormat', (...args: unknown[]) => {
  loaded.push((args[0] as { name: string }).name);
});

@Injectable(ExportFormat)
class CsvFormat extends ExportFormat {
  public readonly Extension = 'csv';
}

@Injectable(ExportFormat)
class XlsxFormat extends ExportFormat {
  public readonly Extension = 'xlsx';
}

console.log(loaded, CsvFormat.name, XlsxFormat.name);
// [ 'CsvFormat', 'XlsxFormat' ]
```

## Related

- [Registering services](01-registering-services.md): the calls that emit `di.registered.*`.
- [Lifetimes](04-lifetimes.md): which lifetimes emit `di.resolved.*` once or on every resolve.
- [Service lifecycle](10-service-lifecycle.md): `dispose()` and `di.dispose`.
