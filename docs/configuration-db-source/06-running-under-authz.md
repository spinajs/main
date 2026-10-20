# Running under authz

When an app guards the `configuration` table with `@spinajs/authz`, the package's own queries (inserting exposed options, syncing metadata, polling watched values) have no request principal. `requireSystemPrincipal()` makes them run as `SYSTEM`, with the reason `config-poll`.

Without that call, the queries run directly, with whatever principal is current.

## How it works

1. An app calls `requireSystemPrincipal(domain = 'root')`. [`@spinajs/configuration-http`](../configuration-http/README.md) does this in its bootstrapper, together with `registerAccessResource(DbConfig, 'configuration')`.
2. Every query of `DbConfigSourceBotstrapper` goes through the internal `asSystem(fn, bootstrapper.authzDomain)`.
3. For a domain not opted in, `asSystem()` calls `fn()` directly and never touches `AuthzService`.
4. For an opted-in domain, `asSystem()` waits for that domain's `AuthzService`:
   - If `authz(domain)` already returns a service, it is used at once.
   - Otherwise it waits for `di.resolved.AuthzService`. For `root`, the http server normally boots the service after it registered its controllers.
   - For `root` only: after 15 s without that event, it logs `AuthzService not booted ... (no http server?)` and resolves `AuthzService` itself.
5. It runs `fn` inside `service.runAs(SYSTEM, 'config-poll', fn)`. The caller's principal is restored afterwards.

`ConfiguratioDbSource` does **not** go through `asSystem()`: it reads the table with a raw driver query, before any authz service exists.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `requireSystemPrincipal(domain)` | function argument, `string` | `'root'` | an authz domain name | Opts the domain in. Calls add up; there is no opt-out except `resetSystemPrincipal()`. |
| `DbConfigSourceBotstrapper.authzDomain` | `string` | `'root'` | an authz domain name | Domain whose `AuthzService` runs the bootstrapper's queries. Must be the domain holding the `configuration` model. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Opt-in | `requireSystemPrincipal(domain)` / `resetSystemPrincipal()`, module-level set | empty set (no guarding) | none | Call `requireSystemPrincipal()` in your own bootstrapper when you guard `DbConfig` yourself. `resetSystemPrincipal()` clears every opt-in; use it in tests. |
| Domain | `authzDomain` property of the `DbConfigSourceBotstrapper` singleton | `'root'` | any domain | Subclass the bootstrapper, see [Customizing the bootstrapper](09-customizing-the-bootstrapper.md). |

## Important behaviour

- **Writes start late in a guarded app.** Inserts and polls wait until the domain's `AuthzService` is resolved. With an http server this is when the server boots it.
- **Apps without an http server wait 15 s.** A worker or CLI that guards `DbConfig` logs a warning and boots `AuthzService` itself after 15 s.
- **A slow http app loses checks.** If an http app takes longer than 15 s to boot authz, the package boots it first. Controllers registered after that miss the boot-time check of their `@Access` permissions.
- **Non-root domains never time out.** For a domain other than `root` there is no fallback timer: the queries wait until that domain's service is resolved.
- **Opting in is global per domain.** `requireSystemPrincipal()` keeps state in the module; every bootstrapper using that domain is affected.

## Best practices

- Call `requireSystemPrincipal()` from a `Bootstrapper`, so it is in place before `Orm` resolves and the first insert runs.
- In a worker without an http server, resolve `AuthzService` yourself during startup to skip the 15 s wait.
- Pair it with `registerAccessResource(DbConfig, 'configuration')` from `@spinajs/authz-orm`: guarding without the opt-in makes the package's own queries fail the access check.

## Patterns and antipatterns

```ts
// Don't: guard the model but leave the package's own queries under the request principal
registerAccessResource(DbConfig, 'configuration');

// Do: opt in, so inserts, metadata sync and polls run as SYSTEM
registerAccessResource(DbConfig, 'configuration');
requireSystemPrincipal();
```

## Examples

### Guard the configuration table in a worker process

```ts sample
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { AuthzService } from '@spinajs/authz';
import { registerAccessResource } from '@spinajs/authz-orm';
import { DbConfig, requireSystemPrincipal } from '@spinajs/configuration-db-source';

@Injectable(Bootstrapper)
export class WorkerConfigurationGuard extends Bootstrapper {
  public bootstrap(): void {
    registerAccessResource(DbConfig, 'configuration');
    requireSystemPrincipal();
  }
}

// no http server boots authz in a worker: boot it at startup instead of waiting 15 s
export async function startWorker(): Promise<void> {
  await DI.resolve(AuthzService);
}
```

## Related

- [`@spinajs/authz`](../authz/README.md): `SYSTEM`, `runAs()` and authz domains.
- [`@spinajs/configuration-http`](../configuration-http/README.md): opts in for you.
- [Customizing the bootstrapper](09-customizing-the-bootstrapper.md): change `authzDomain`.
