# Service lifecycle

Base classes give a service hooks the container calls: `resolve()` after injection to initialize, `dispose()` on shutdown to release resources. `Bootstrapper` is the hook for code that must run once at startup, before the app resolves its services.

## How it works

1. **Construct.** `Container.getNewInstance()` calls the constructor with the `@Inject` arguments and the resolve options.
2. **Inject.** `@Autoinject` properties are assigned.
3. **Initialize.**
   - A `SyncService` gets `resolve()` called synchronously; the instance is returned at once.
   - An `AsyncService` gets `resolve()` called and awaited; the container returns a `Promise` that settles with the instance, or rejects with the error `resolve()` threw.
4. **Cache.** A singleton-like instance is cached only after `resolve()` finishes, and concurrent resolves of it share one promise, so `resolve()` runs once per instance.
5. **Dispose.** `container.dispose()` disposes every child container first, then calls `dispose()` on each cached value that is a `Service`, in cache order. With `{ plainOwners: true }` (passed on to the children) it first calls `dispose()` once on each cached value that is not a `Service` but has one, eg. a model; the container itself is skipped. Errors are collected and reported with one `console.warn`; `dispose()` itself does not reject. Then the cache is cleared and `di.dispose` is emitted.

## API

| Class | Members | Meaning |
| --- | --- | --- |
| `Service` | `Resolved: boolean` (getter), `dispose(): Promise<void>` | Base of both; `dispose()` does nothing by default |
| `SyncService` (abstract) | `resolve(): void` | Sets `Resolved` to `true`. Override for synchronous setup |
| `AsyncService` | `resolve(): Promise<void>` | Sets `Resolved` to `true`. Override for async setup: connections, file reads, remote config |
| `Bootstrapper` (abstract) | `bootstrap(): Promise<void> \| void` | Startup hook. The container does **not** run it; the app entry does |
| `DI.dispose(options?)` / `container.dispose(options?)` | `Promise<void>` | Dispose children and cached services, clear the cache; `{ plainOwners: true }` also disposes cached non-`Service` instances |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `Bootstrapper` | `Bootstrapper`, a list resolved with `Array.ofType(Bootstrapper)`; each is a singleton | none in this package; most packages ship one (eg. `LogBotstrapper` in `@spinajs/log`) | Your class | `@Injectable(Bootstrapper) class MyBootstrapper extends Bootstrapper`; remove one with `DI.unregister(Theirs)` before the entry resolves the list |
| `SyncService` / `AsyncService` subclasses | Whatever key you register them under | none | none | Extend the base class and override `resolve()` and `dispose()`; call `super.resolve()` |

### Who runs bootstrappers

The entry point resolves the list and calls each one in order before it resolves the configuration and the app, eg. `@spinajs/cli`:

```ts
const bootstrappers = DI.resolve(Array.ofType(Bootstrapper));
for (const b of bootstrappers) {
  await b.bootstrap();
}
await DI.resolve(Configuration);
```

Bootstrappers typically register configuration schemas, process handlers or DI overrides. A bootstrapper's module must be imported before the list is resolved, or it is not in the list.

### A custom bootstrapper and an async service

```ts sample
import { AsyncService, Bootstrapper, DI, Injectable } from '@spinajs/di';

abstract class Mailer {
  public abstract send(to: string): string;
}

class SmtpMailer extends Mailer {
  public send(to: string) {
    return `smtp -> ${to}`;
  }
}

// Runs once at startup and wires the mailer the deployment needs.
@Injectable(Bootstrapper)
class MailBootstrapper extends Bootstrapper {
  public bootstrap() {
    DI.register(SmtpMailer).as(Mailer);
  }
}

class SearchIndex extends AsyncService {
  public Documents = 0;

  public async resolve() {
    this.Documents = await Promise.resolve(1200); // load the index from disk
    await super.resolve();
  }

  public async dispose() {
    this.Documents = 0; // close file handles
  }
}

async function start() {
  for (const b of DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  const index = await DI.resolve(SearchIndex);
  console.log(index.Resolved, index.Documents, DI.resolve(Mailer).send('ann@example.com'), MailBootstrapper.name);

  await DI.dispose();
}

void start();
```

## Important behaviour

- An override of `resolve()` that does not call `super.resolve()` leaves `Resolved` at `false`.
- `@Autoinject` properties are available in `resolve()` but not in the constructor.
- A `SyncService.resolve()` that throws fails the `resolve()` call synchronously; an `AsyncService.resolve()` that rejects rejects the returned promise and nothing is cached.
- Dispose order is cache insertion order, not reverse dependency order. A service can be disposed before another service that still uses it; make `dispose()` safe to run in any order.
- A singleton reached through `Array.ofType(T)` is cached under `T` and under its own name; `dispose()` still calls its `dispose()` once.
- `@NewInstance()` services and factory results are never cached, so `dispose()` never reaches them.
- After `DI.dispose()` the root registry is intact; the next resolve builds fresh instances.

## Best practices

- Do I/O in `AsyncService.resolve()`, not in the constructor: errors reach the caller as a rejected resolve, and concurrent callers share one initialization.
- Guard `dispose()` with a flag so any order is harmless.
- Keep `bootstrap()` short and side-effect focused (register schemas, overrides, handlers); resolve heavy services after all bootstrappers ran.

## Patterns and antipatterns

```ts
// Don't: async work in the constructor; failures are unhandled and callers cannot await it
class Index {
  constructor() {
    void this.load();
  }
}

// Do
class Index extends AsyncService {
  public async resolve() {
    await this.load();
    await super.resolve();
  }
}
```

## Examples

### Close a connection pool on shutdown, once

```ts sample
import { AsyncService, DI } from '@spinajs/di';

class ConnectionPool extends AsyncService {
  protected closed = false;
  public Open = 0;

  public async resolve() {
    this.Open = 10;
    await super.resolve();
  }

  public async dispose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.Open = 0;
  }
}

async function main() {
  const pool = await DI.resolve(ConnectionPool);
  process.once('SIGTERM', () => void DI.dispose());
  console.log(pool.Open);
}

void main();
```

## Related

- [Resolving services](02-resolving-services.md): when `resolve()` makes the result a `Promise`.
- [Lifetimes](04-lifetimes.md): which instances are cached and so disposed.
- [Child containers](05-child-containers.md): disposing one scope.
- [Container events](12-container-events.md): `di.dispose`.
