# Customizing the bootstrapper

`DbConfigSourceBotstrapper` writes exposed options and runs the watch poll. Subclass it to run its queries in another authz domain, or to act after each poll; listen to `configuration.db.changed` to act on a changed value; resolve the bound instance to trigger a poll on demand.

## How it works

1. Importing the package registers `DbConfigSourceBotstrapper` with `@Injectable(Bootstrapper)`: under `Bootstrapper` and under itself, as a singleton.
2. The app resolves `Array.ofType(Bootstrapper)` and calls `bootstrap()` on each. `DbConfigSourceBotstrapper.bootstrap()` registers the config schema and subscribes to `di.registered.__configuration_property__`, `di.resolved.Orm` and `orm.migrated`, until `di.dispose` or `unbind()`. See [Exposing options](02-exposing-options.md).
3. `DI.resolve(DbConfigSourceBotstrapper)` returns that same instance, so you can call its public members later.
4. A subclass registered with `@Injectable(Bootstrapper)` joins the list. `DI.unregister(DbConfigSourceBotstrapper)` removes the base class, so only the subclass subscribes.
5. After that unregister, nothing is registered under `DbConfigSourceBotstrapper` any more: `DI.resolve(DbConfigSourceBotstrapper)` builds a new instance that never ran `bootstrap()`, has no watch timer and writes into whatever `Configuration` DI holds. The bound instance is the subclass: resolve it by its own class, `DI.resolve(PlatformDbConfigBootstrapper)`. To keep code that resolves the base class working, also register the subclass under it: `DI.register(PlatformDbConfigBootstrapper).as(DbConfigSourceBotstrapper)`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Exposing bootstrapper | `Bootstrapper` list (`Array.ofType`), singleton; also resolvable as `DbConfigSourceBotstrapper` while the base class, or a subclass registered `.as(DbConfigSourceBotstrapper)`, is the one registered | `DbConfigSourceBotstrapper` | none | Subclass + `@Injectable(Bootstrapper)` + `DI.unregister(DbConfigSourceBotstrapper)`, before bootstrappers are resolved; add `DI.register(Subclass).as(DbConfigSourceBotstrapper)` when code resolves the base class. |

Members meant for subclasses and callers:

| Member | Kind | Default | Use |
| --- | --- | --- | --- |
| `authzDomain` | public property | `'root'` | Domain whose `AuthzService` runs the queries when [authz guarding](06-running-under-authz.md) is on. |
| `bootstrap()` | public method | subscribes to DI events | Override and call `super.bootstrap()` to add your own setup. |
| `unbind()` | public method | removes the DI subscriptions of `bootstrap()`; `di.dispose` calls it | Call it to stop syncing without disposing the container. |
| `whenSwept()` | public method | settles once the sweep of exposed options has written its rows or failed; the sweep is started by a `di.resolved.Orm` or `orm.migrated` signal, or by `bootstrap()` itself when the `Orm` is already resolved; at once when no sweep started since `bootstrap()` | Await it in a test before reading the rows of exposed options. |
| `refreshWatched()` | public method | one poll of the rows whose `Watch` column is set; a call made after the `DbConfigWatcher` was disposed polls and applies as usual, a call still running when it is disposed applies nothing; emits `configuration.db.changed` `(slug, previous, next)` on the root container for each value it changed | Call it to apply database changes now; listen to the event to act on a change, or override and call `super` to act after each poll. |
| `Converter` | protected `DbConfigValueConverter`, `@Autoinject` | the DI singleton | Read in a subclass; replace it through DI, see [Custom value converter](08-custom-value-converter.md). |

The insert, metadata sync and timer methods are `private`: a subclass cannot change them. The timer itself runs in the `DbConfigWatcher` service; to stop the watch, dispose that service, see [Watching options](03-watching-options.md#stop-the-watch-and-start-it-again).

### Exposing bootstrapper: custom implementation

A multi-tenant app keeps the `configuration` model in an authz domain named `platform`, not in `root`. The subclass moves the package's queries there and opts that domain in.

```ts sample
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { DbConfigSourceBotstrapper, requireSystemPrincipal } from '@spinajs/configuration-db-source';

@Injectable(Bootstrapper)
export class PlatformDbConfigBootstrapper extends DbConfigSourceBotstrapper {
  public authzDomain = 'platform';

  public async bootstrap(): Promise<void> {
    requireSystemPrincipal(this.authzDomain);
    await super.bootstrap();
  }
}

DI.unregister(DbConfigSourceBotstrapper);
// code that resolves DbConfigSourceBotstrapper now gets this subclass, the instance the bootstrap phase ran
DI.register(PlatformDbConfigBootstrapper).as(DbConfigSourceBotstrapper);
```

The `platform` domain's `AuthzService` must be resolved by the host: for a domain other than `root` there is no 15 s fallback, so the queries wait until it is.

## Important behaviour

- **Two bootstrappers mean double work.** Without `DI.unregister(DbConfigSourceBotstrapper)`, both instances subscribe: every exposed option is inserted twice (the second is ignored) and two watch timers poll.
- **`bootstrap()` can run again.** Each call first removes the DI listeners of the previous one, subscribes again and resets the sweep state. When the `Orm` is already resolved it sweeps at once; otherwise the next `di.resolved.Orm` or `orm.migrated` does. It does not stop a running watch timer; the sweep replaces it, and a watcher disposed by hand is replaced by a fresh one.
- **The base class is not the bound instance once it is replaced.** After `DI.unregister(DbConfigSourceBotstrapper)`, `DI.resolve(DbConfigSourceBotstrapper)` builds a separate instance; `refreshWatched()` and `whenSwept()` on it do not reach the bootstrapper that runs the timer, and its queries run in the authz domain `root`, not the subclass's. Resolve the subclass, or register it `.as(DbConfigSourceBotstrapper)`.
- **`refreshWatched()` before `Orm` resolves does nothing useful.** The `DbConfig` model is not ready until then: the poll logs `Failed to refresh watched config values from db` and changes nothing.
- **`refreshWatched()` never throws.** Database errors are logged and the method returns.

## Best practices

- Set `authzDomain` as a property initializer, so it is in place before `bootstrap()` runs any query.
- Call `refreshWatched()` right after your code changes a watched row; the next timer tick then finds nothing to do.
- Keep subclass work in `refreshWatched()` short: the next tick is scheduled only after it settles.
- Keep `configuration.db.changed` listeners short: they run inside the poll, before the next row is applied. Start async work without awaiting it and end it with a `.catch()`.
- Read `previous` and `next`; do not mutate them. An object value is the one the configuration holds, so copy it to keep it.

## Patterns and antipatterns

```ts
// Don't: a fresh instance runs no timer
const poller = new DbConfigSourceBotstrapper();
await poller.refreshWatched();

// Don't, once a subclass replaced the base class without the .as(DbConfigSourceBotstrapper) registration: this builds another fresh instance
DI.unregister(DbConfigSourceBotstrapper);
const stale = await DI.resolve(DbConfigSourceBotstrapper);

// Do: resolve the class that is registered, the singleton the bootstrap phase ran
const bound = await DI.resolve(PlatformDbConfigBootstrapper); // or DbConfigSourceBotstrapper when no subclass replaced it
await bound.refreshWatched();
```

## Examples

### Rebuild the mail transport after the SMTP host changed

The SMTP host is a watched option. The transport keeps an open connection, so it has to be rebuilt when the host changes. No subclass is needed: the poll emits `configuration.db.changed` for every value it changed, and the mailer reconnects when its slug comes by.

```ts sample
import { DI } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { CONFIGURATION_DB_CHANGED_EVENT } from '@spinajs/configuration-db-source';
import { Log, Logger } from '@spinajs/log-common';

const SMTP_HOST = 'mailer.smtpHost';

export class Mailer {
  @Config(SMTP_HOST, {
    defaultValue: 'localhost',
    expose: true,
    exposeOptions: { type: 'string', group: 'mailer', label: 'SMTP host', watch: true },
  })
  protected SmtpHost: string;

  @Logger('mailer')
  protected Log: Log;

  private connectedHost = '';

  public async start(): Promise<void> {
    await this.connect(this.SmtpHost);
    DI.on(CONFIGURATION_DB_CHANGED_EVENT, (slug: unknown, _previous: unknown, next: unknown) => {
      if (slug === SMTP_HOST && typeof next === 'string') {
        // the poll does not await listeners: an async one catches its own rejection
        this.connect(next).catch((err: unknown) => this.Log.error({ error: err }, 'Reconnecting to the SMTP host failed'));
      }
    });
  }

  private async connect(host: string): Promise<void> {
    this.connectedHost = host;
    // open the SMTP connection to this.connectedHost here
  }
}
```

The listener types its parameters as `unknown` and narrows them, so it compiles under `strict` against `DI.on`'s `(...args: unknown[]) => void`. A listener that throws is logged and does not stop the poll, but the listeners registered after it miss that change: keep the listener's own failures inside it. The poll does not await a listener either: a promise one returns is dropped, so an async listener, such as one that journals the change in a database, must catch its own rejection, or it becomes an unhandled rejection that ends a Node process by default.

## Related

- [Exposing options](02-exposing-options.md): what `bootstrap()` subscribes to.
- [Watching options](03-watching-options.md): the poll `refreshWatched()` runs.
- [Running under authz](06-running-under-authz.md): what `authzDomain` controls.
