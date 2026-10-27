# Domains

A domain is a child DI container with its own `AuthzService`, models, permissions and engine settings. Use one when a part of the app needs different models or rules than the rest, such as a read-only archive (B29). Most apps only use the root domain, `root` (`ROOT_DOMAIN`).

## How it works

1. `DefaultAuthzDomains` (the `AuthzDomains` singleton) holds the domain records. `root` is the root container itself.
2. `domains.create(name, parent?)` makes a child container of the parent domain's container and records it. The parent is the argument, else `authz.domains.<name>.parent`, else `root`; when both are given they must agree. The root boot creates every domain `authz.domains.<name>.use` lists models for, and its missing ancestors, the same way.
3. The domain's models come from its `use` list ([Models by name](#models-by-name)). Without one, the app registers them (and adapters, resolvers, contributors) on the returned container.
4. `await domains.service(name)` resolves the domain's `AuthzService`, which boots: it waits for the parent's service, copies the parent's permission registrations, merges the models of every level and reads the domain's config ([Host, boot and configuration](04-host-boot-and-configuration.md#how-it-works)).
5. `authz(name)` then returns that service synchronously.
6. Disposing the domain's container forgets the domain and every descendant, and disposes their services.

## Configuration

`authz.domains.<name>.*` applies to one domain and its children:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.domains.<name>.parent` | `string` | `'root'` | a domain name | The parent domain. |
| `authz.domains.<name>.use` | `string[]` | none | registered model names | The models this domain adds to the inherited ones. Unset: what the domain's container registers under `AuthorizationModel`. Set: the root boot creates the domain. |
| `authz.domains.<name>.combine` | `object` | the nearest ancestor's | as `authz.combine` | Replaces the parent's routing whole, never key by key. |
| `authz.domains.<name>.disable` | `string[]` | `[]` | model names | Drops models an ancestor level registered. A name no ancestor registers logs a warning. |
| `authz.domains.<name>.permissions` | `object` | none | as `authz.permissions` | Adds permissions on top of the parent's. |
| `authz.domains.<name>.engine` | `object` | the parent's | as `authz.engine` | Overrides key by key. |
| `authz.domains.<name>.fields` | `object` | the parent's | as `authz.fields` | Overrides key by key. |
| `authz.domains.<name>.cache` | `object` | the parent's | as `authz.cache` | Overrides key by key. |
| `authz.domains.<name>.audit` | `object` | the parent's | as `authz.audit` | Overrides key by key. |

`authz.use` lists the models root activates; unset, every registration under `AuthorizationModel` in root is active. `authz.bus` and `authz.principals` come from the root only. A domain name matches `DOMAIN_NAME_PATTERN` (`^[A-Za-z0-9_.-]{1,64}$`) and is never `root`.

```ts
export default {
  authz: {
    domains: {
      archive: {
        parent: 'root',
        use: ['read-only'],
        combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'read-only'] } },
        permissions: { 'document:restore': {} },
        cache: { ttlSeconds: 300 },
      },
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzDomains` | `AuthzDomains`, `@Singleton` in the root container | `DefaultAuthzDomains` | none | Not meant to be replaced; `AuthzService.resolve()` requires `DefaultAuthzDomains`. |

`AuthzDomains` methods:

| Method | Returns | Meaning |
| --- | --- | --- |
| `create(name, parent?)` | `IContainer` | A new domain container. Throws for `root`, a bad or taken name, or an unknown parent. |
| `container(name)` | `IContainer` | The container of a live domain. |
| `service(name)` | `Promise<AuthzService>` | Boots (once) and returns the domain's service. |
| `names()` | `string[]` | Live domain names, `root` first. |
| `describe(container)` | `DomainIdentity \| undefined` | The domain a container is (`{ name, parent? }`); `undefined` for a container that is not a domain. |
| `lineage(name)` | `string[]` | The domains from `root` down to `name`. Throws `AuthzConfigError` for a domain that does not exist. |

Once a domain's service has booted, the host's `DefaultAuthzDomains` also gives what that service booted with. Before the boot, and for an unknown domain, each throws `AuthzConfigError`:

| Method | Returns | Meaning |
| --- | --- | --- |
| `config(name)` | `DomainConfig` | The domain's config merged over its lineage, frozen. |
| `audit(name)` | `DecisionAudit \| undefined` | The audit sink the service picked (`authz.audit.service`, else the last registration). |
| `bus(name)` | `ChangeBus \| undefined` | The change bus the service picked (`authz.bus.service`, else the last registration). |
| `clock(name)` | `AuthzClock` | The domain's own `AuthzClock` registration, else `SystemClock`. |

Adapters use these instead of reading config or resolving services themselves, so they act with what the domain's service uses. `pickNamed(container, token, name, key, where)` picks a registration by class name, as the host does for `authz.audit.service` and `authz.bus.service`: without a name it returns the last registration, or `undefined`; an unknown name throws `AuthzConfigError` naming `key`.

## Per-request domains

A route is checked in the domain its `@Access` names (`domain`, else the class's, else `root`). A multi-tenant app that keeps one domain per tenant picks the domain per request with an `AuthzDomainResolver` from `@spinajs/authz-http` (B48):

```ts
import { Injectable } from '@spinajs/di';
import { AuthzDomainResolver } from '@spinajs/authz-http';
import type { Request } from '@spinajs/http';

@Injectable(AuthzDomainResolver)
export class TenantDomainResolver extends AuthzDomainResolver {
  resolve(req: Request, fallback: string): string {
    const tenant = req.headers['x-tenant'];
    return typeof tenant === 'string' ? `tenant-${tenant}` : fallback;
  }
}
```

- `fallback` is what the route, the controller or the config names today: the `@Access` `domain`, `authz.http.access.domain` for `/user/access` and the explain route, `authz.http.admin.domain` for the admin routes.
- The default `StaticDomainResolver` returns the fallback, so an app without a resolver behaves as before. The last registered resolver wins.
- `@Access`, the explain route, `/user/access` and `/user/access/checks`, and the admin routes of `@spinajs/authz-http-admin` all ask the resolver. It runs once per request and fallback, so the policies and the action of a request agree.
- A name that is not the fallback and that no live domain bears answers 403 `{ error: 'forbidden', reason: { code: 'unknown_domain' } }`; the admin routes answer `{ error: { code: 'unknown_domain', message } }`. The action does not run. A resolver that returns anything but a non-empty string fails the request with `AuthzConfigError` (500).
- `req.storage.AuthzDecision.domain` and the field filters follow the resolved domain.
- The resolver chooses among domains the app created. It does not authorize the choice: a request that names another tenant's domain is still checked by that domain's models, so derive the name from something the caller cannot forge, such as the principal, and not from a header alone.

## Models by name

A model is registered in DI under its `name`: `@Injectable('read-only')` on a class, or `DI.register(factory).as('tenant-policy')` for a factory. Config then lists the names per level:

```ts
authz: {
  use: ['abac', 'rbac'],                               // root
  domains: {
    archive: { use: ['read-only'] },                   // created at root boot
  },
}
```

1. A level that sets `use` activates exactly the listed names, each resolved in that level's container. What the container registers under `AuthorizationModel` stays available but inactive.
2. A child takes its ancestors' active models from their boot, so an ancestor's factory never runs twice. `disable` and replacement by name work as before: listing an inherited name gives the child its own instance in its place.
3. A class keeps its DI lifetime (`@Singleton` shares one instance, and so one `init`). A factory runs once per domain that lists it, which suits a model with per-domain state; it can read `ctx.domain` in `init`.
4. The boot fails with `AuthzConfigError` naming the key for a name nothing is registered under, a name registered twice, a value that is not a model, or a model whose `name` differs from the name it is registered under.

`@spinajs/authz-rbac` registers `'rbac'` and `@spinajs/authz-abac` registers `'abac'` when imported.

## Important behaviour

- **Register before the first `service(name)`.** A booted domain does not see later registrations.
- **Register a model under its name, activate it with `use`.** A level that sets `use` activates only what it lists, so a decorator in root does not leak into other domains. A level without `use` keeps the old rule: `@Injectable(AuthorizationModel)` registers in the root container, and the model joins every domain (DI-2).
- **A model instance initialises once.** `init` runs in the first domain that lists it; other domains replay its permissions, native filters and relations. A child sees every registration of its parent.
- **Changes reach descendants.** A change published for domain `X` invalidates `X` and every domain below it. A change without a domain invalidates every domain.
- **Create domains after `Configuration` is resolved.** `create()` reads `authz.domains.<name>.parent` synchronously.
- **Each domain has its own L2 cache.** Register a custom `DecisionCache` as a factory so each domain gets a fresh one ([Caching](06-caching-and-change-propagation.md)).

## Examples

### A read-only archive domain

Documents in the archive keep the root's RBAC grants, but only `read` actions pass there.

With `authz.domains.archive.use: ['read-only']` in the config above, the root boot creates the domain and its first `authz('archive')` check finds the model:

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { AuthorizationModel, FALSE, TRUE, authz } from '@spinajs/authz';
import type { DecisionRequest, ModelCapabilities, PermissionDef, ResourceType, Vote } from '@spinajs/authz';

@Singleton()
@Injectable('read-only')
export class ReadOnlyModel extends AuthorizationModel {
  readonly name = 'read-only';
  readonly capabilities: ModelCapabilities = { effects: ['deny'], residuals: [], sync: 'always', fields: false, needsSubject: false };

  init(): void {}

  applies(permission: PermissionDef, _type: ResourceType): boolean {
    return permission.action !== 'read';
  }

  evaluate(_req: DecisionRequest): Vote {
    return { model: this.name, permitWhen: FALSE, denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'archive_read_only' } }], cacheable: true };
  }
}

export async function canEditArchived(documentId: string): Promise<boolean> {
  const archive = authz('archive');
  return archive.can(archive.current(), 'document:update', { type: 'document', id: documentId });
}
```

`authz('archive')` needs the domain booted: resolve `await (await DI.resolve(AuthzDomains)).service('archive')` once at start, or let the first `@Access({ domain: 'archive' })` route boot it. The `combine` in the configuration section above routes `read-only` next to `rbac` in the `archive` domain. Without it the domain inherits the root's `combine`; when that lists its models, the new model is not routed and boot only warns.

## Related

- [Host, boot and configuration](04-host-boot-and-configuration.md): what a domain boot does.
- [Writing a model](08-writing-a-model.md): the model contract.
- [Protecting routes](../authz-http/01-protecting-routes.md): `@Access` and its `domain` option.
- [`@spinajs/authz-fs`](../authz-fs/README.md): `authz.fs.<name>.domain` names the domain whose service checks a file system.
