# Domains

A domain is a child DI container with its own `AuthzService`, models, permissions and engine settings. Use one when a part of the app needs different models or rules than the rest, such as a file system that inherits access from its folders (B29). Most apps only use the root domain, `root`.

## How it works

1. `DefaultAuthzDomains` (the `AuthzDomains` singleton) holds the domain records. `root` is the root container itself.
2. `domains.create(name, parent?)` makes a child container of the parent domain's container and records it. The parent is the argument, else `authz.domains.<name>.parent`, else `root`; when both are given they must agree.
3. The app registers the domain's own models (and adapters, resolvers, contributors) on the returned container.
4. `await domains.service(name)` resolves the domain's `AuthzService`, which boots: it waits for the parent's service, copies the parent's permission registrations, merges the models of every level and reads the domain's config ([Host, boot and configuration](04-host-boot-and-configuration.md#how-it-works)).
5. `authz(name)` then returns that service synchronously.
6. Disposing the domain's container forgets the domain and every descendant, and disposes their services.

## Configuration

`authz.domains.<name>.*` applies to one domain and its children:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.domains.<name>.parent` | `string` | `'root'` | a domain name | The parent domain. |
| `authz.domains.<name>.combine` | `object` | the nearest ancestor's | as `authz.combine` | Replaces the parent's routing whole, never key by key. |
| `authz.domains.<name>.disable` | `string[]` | `[]` | model names | Drops models an ancestor level registered. A name no ancestor registers logs a warning. |
| `authz.domains.<name>.permissions` | `object` | none | as `authz.permissions` | Adds permissions on top of the parent's. |
| `authz.domains.<name>.engine` | `object` | the parent's | as `authz.engine` | Overrides key by key. |
| `authz.domains.<name>.fields` | `object` | the parent's | as `authz.fields` | Overrides key by key. |
| `authz.domains.<name>.cache` | `object` | the parent's | as `authz.cache` | Overrides key by key. |
| `authz.domains.<name>.audit` | `object` | the parent's | as `authz.audit` | Overrides key by key. |

`authz.bus` and `authz.principals` come from the root only. A domain name matches `[A-Za-z0-9_.-]{1,64}` and is never `root`.

```ts
export default {
  authz: {
    domains: {
      archive: {
        parent: 'root',
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

## Important behaviour

- **Register before the first `service(name)`.** A booted domain does not see later registrations.
- **Never use `@Injectable(AuthorizationModel)` for a child-domain model.** A decorator registers in the root container, so the model would join every domain (DI-2). Register it on the domain's container.
- **A model instance initialises once.** `init` runs in the first domain that lists it; other domains replay its permissions, native filters and relations. A child sees every registration of its parent.
- **Changes reach descendants.** A change published for domain `X` invalidates `X` and every domain below it. A change without a domain invalidates every domain.
- **Create domains after `Configuration` is resolved.** `create()` reads `authz.domains.<name>.parent` synchronously.
- **Each domain has its own L2 cache.** Register a custom `DecisionCache` as a factory so each domain gets a fresh one ([Caching](06-caching-and-change-propagation.md)).

## Examples

### A read-only archive domain

Documents in the archive keep the root's RBAC grants, but only `read` actions pass there.

```ts sample
import { DI } from '@spinajs/di';
import { AuthorizationModel, AuthzDomains, FALSE, TRUE, authz } from '@spinajs/authz';
import type { DecisionRequest, ModelCapabilities, PermissionDef, ResourceType, Vote } from '@spinajs/authz';

class ReadOnlyModel extends AuthorizationModel {
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

// Run once at boot, after Configuration and the root AuthzService resolved.
export async function bootArchiveDomain(): Promise<void> {
  const domains = await DI.resolve(AuthzDomains);
  const container = domains.create('archive');
  container.register(ReadOnlyModel).as(AuthorizationModel);
  await domains.service('archive');
}

export async function canEditArchived(documentId: string): Promise<boolean> {
  const archive = authz('archive');
  return archive.can(archive.current(), 'document:update', { type: 'document', id: documentId });
}
```

The config above routes `read-only` next to `rbac` in the `archive` domain. Without it the domain inherits the root's `combine`; when that lists its models, the new model is not routed and boot only warns.

## Related

- [Host, boot and configuration](04-host-boot-and-configuration.md): what a domain boot does.
- [Writing a model](08-writing-a-model.md): the model contract.
- [`@spinajs/authz-fs`](../authz-fs/README.md): creates the domain a file system names and registers its `fs-inherit` and `fs-abac` models there.
