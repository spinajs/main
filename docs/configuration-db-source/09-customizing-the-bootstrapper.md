# Customizing the bootstrapper

`DbConfigSourceBotstrapper` writes exposed options and runs the watch poll. Subclass it to run its queries in another authz domain, or to act after each poll; resolve the bound instance to trigger a poll on demand.

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
| `whenSwept()` | public method | settles once the sweep of exposed options, started by a `di.resolved.Orm` or `orm.migrated` signal, has written its rows or failed; at once when no signal came since `bootstrap()` | Await it in a test before reading the rows of exposed options. |
| `refreshWatched()` | public method | one poll of the rows whose `Watch` column is set | Call it to apply database changes now; override and call `super` to act after each poll. |
| `Converter` | protected `DbConfigValueConverter`, `@Autoinject` | the DI singleton | Read in a subclass; replace it through DI, see [Custom value converter](08-custom-value-converter.md). |

The insert, metadata sync and timer methods are `private`: a subclass cannot change them.

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
- **`bootstrap()` must run once.** Each call adds another pair of DI listeners.
- **The base class is not the bound instance once it is replaced.** After `DI.unregister(DbConfigSourceBotstrapper)`, `DI.resolve(DbConfigSourceBotstrapper)` builds a separate instance; `refreshWatched()` and `whenSwept()` on it do not reach the bootstrapper that runs the timer, and its queries run in the authz domain `root`, not the subclass's. Resolve the subclass, or register it `.as(DbConfigSourceBotstrapper)`.
- **`refreshWatched()` before `Orm` resolves does nothing useful.** The `DbConfig` model is not ready until then: the poll logs `Failed to refresh watched config values from db` and changes nothing.
- **`refreshWatched()` never throws.** Database errors are logged and the method returns.

## Best practices

- Set `authzDomain` as a property initializer, so it is in place before `bootstrap()` runs any query.
- Call `refreshWatched()` right after your code changes a watched row; the next timer tick then finds nothing to do.
- Keep subclass work in `refreshWatched()` short: the next tick is scheduled only after it settles.

## Patterns and antipatterns

```ts
// Don't: a fresh instance runs no timer
const poller = new DbConfigSourceBotstrapper();
await poller.refreshWatched();

// Don't, once a subclass replaced the base class without the .as(DbConfigSourceBotstrapper) registration: this builds another fresh instance
DI.unregister(DbConfigSourceBotstrapper);
const stale = await DI.resolve(DbConfigSourceBotstrapper);

// Do: resolve the class that is registered, the singleton the bootstrap phase ran
const bound = await DI.resolve(NotifyingDbConfigBootstrapper); // or DbConfigSourceBotstrapper when no subclass replaced it
await bound.refreshWatched();
```

## Examples

### Rebuild the mail transport after a poll

The SMTP host is a watched option. The transport keeps an open connection, so it has to be rebuilt when the host changes. The subclass emits a DI event after every poll; the mailer compares the host and rebuilds.

```ts sample
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { DbConfigSourceBotstrapper } from '@spinajs/configuration-db-source';

@Injectable(Bootstrapper)
export class NotifyingDbConfigBootstrapper extends DbConfigSourceBotstrapper {
  public async refreshWatched(): Promise<void> {
    await super.refreshWatched();
    DI.emit('configuration.db.refreshed');
  }
}

DI.unregister(DbConfigSourceBotstrapper);
DI.register(NotifyingDbConfigBootstrapper).as(DbConfigSourceBotstrapper);

export class Mailer {
  @Config('mailer.smtpHost', {
    defaultValue: 'localhost',
    expose: true,
    exposeOptions: { type: 'string', group: 'mailer', label: 'SMTP host', watch: true },
  })
  protected SmtpHost: string;

  private connectedHost = '';

  public start(): void {
    this.connect();
    DI.on('configuration.db.refreshed', () => {
      if (this.SmtpHost !== this.connectedHost) {
        this.connect();
      }
    });
  }

  private connect(): void {
    this.connectedHost = this.SmtpHost;
    // open the SMTP connection to this.connectedHost here
  }
}
```

## Related

- [Exposing options](02-exposing-options.md): what `bootstrap()` subscribes to.
- [Watching options](03-watching-options.md): the poll `refreshWatched()` runs.
- [Running under authz](06-running-under-authz.md): what `authzDomain` controls.
