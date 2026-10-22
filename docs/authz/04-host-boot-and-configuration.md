# Host, boot and configuration

The host is the DI side of the package: `DefaultAuthzService` boots one engine per domain, reads the `authz.*` config, collects models, adapters and resolvers from the container, and refuses a setup that cannot work. Every boot error is an `AuthzConfigError` that names the domain and the offending key, model or permission.

## How it works

`DefaultAuthzService.resolve()` runs once per domain container, when the service is first resolved:

1. **Domain.** It resolves `AuthzDomains` and finds the domain of its container. A child domain first waits for its parent's service to boot.
2. **Config.** It resolves `Configuration`. The configuration module validates `authz.*` against `AUTHZ_CONFIGURATION_SCHEMA` (AJV, defaults filled in). Boot reads no `rbac.*` key.
3. **Domain config.** `readDomainConfig()` merges the domain's keys over its ancestors' and over `AUTHZ_DEFAULTS` ([Domains](05-domains.md#configuration)).
4. **Audit and bus.** It picks the `DecisionAudit` and `ChangeBus` classes named by `authz.audit.service` and `authz.bus.service`, else the last registration (`pickNamed()`, [Domains](05-domains.md#services-and-extension-points)). It subscribes to the bus before any model initialises; changes published meanwhile are applied once the boot ends.
5. **Collect.** From the container chain (`Array.chainOf`) it resolves every `AuthorizationModel`, `ResourceAdapter`, `ScopeResolver`, `RelationResolver`, `NativeFilter`, `Combinator` and `AuthzContributor`.
6. **Models.** Level by level, root first, it drops the names a level's `disable` lists and adds the level's own models; a model whose name an ancestor level used replaces it in place.
7. **Permissions.** It registers the parent's permissions, `authz.permissions` (or the domain's `permissions`), the permissions of adapters registered in its own container, then calls each model's `init(ctx)`. `init` runs once per model instance; other domains replay its registrations. The registry is then frozen ([Declaring permissions](02-permissions.md)).
8. **Contributions.** It calls `contribute(domain)` on every `AuthzContributor` and collects permission, relation and scope refs, join types, list types and scope attribute schemas.
9. **Boot checks.** `validateBoot()` runs the rules below and throws one `AuthzConfigError` that lists every problem.
10. **Engine.** It resolves the optional `ScopeAttributeStore`, `ConditionCompiler` and `AuthzAdmin`, the `AuthzClock`, and a fresh `DecisionCache` when `authz.cache.maxEntries` is above 0, then builds the `Authorizer`.
11. **Push.** The root domain starts the `AccessChangeRouter` on its bus ([Caching and change propagation](06-caching-and-change-propagation.md#pushing-changes-to-clients)).

A failed boot releases the models it claimed and throws. `dispose()` unsubscribes from the bus and disposes each model whose `init` ran once the last domain that lists it is gone.

## Boot checks

`validateBoot()` implements design §6.5. Rules 9 and 11 are checked by the models themselves.

| Rule | Refuses |
| --- | --- |
| 1 | A combine entry that lists a model no container of the domain registers. |
| 2 | Two models with the same name. |
| 3 | Two adapters that claim the same resource type; an adapter without a types array. |
| 4 | A residual op in a routed model's `capabilities.residuals` that is unknown, that a list-scoped adapter of the type does not list in `compiles`, or a `native:*` op with no registered `NativeFilter`. |
| 5 | A `first-applicable` route with a model whose `effects` are empty. |
| 6 | A join type (from a contributor) routed to a model with `sync: 'never'`. |
| 7 | An `implies` or a contributor's `permissionRefs` entry that names an unregistered permission, or checks it on a type outside its types. |
| 8 | A contributor's `relationRefs` entry with no `RelationResolver` (registered, from a model's `init` or from an adapter's `relations()`); a malformed resolver. |
| 10 | A contributor's `scopeRefs` type that no adapter or scope resolver serves. |
| 12 | A `list: true` permission that is not routed with `deny-overrides`, whose type no list-scoped resource serves, or that a routed model cannot plan (`listSupport()`). |

## Registering the shipped models

No package registers the RBAC or ABAC model for you. The app wires them in the domain's container before the domain's `AuthzService` first resolves, after `Configuration`:

- RBAC: `registerRbac(DI.RootContainer, configuration)` from `@spinajs/authz-rbac` registers the stores, `RbacModel`, its contributor, `RbacService` and an `RbacLinkResolver` as the `LinkResolver` ([Wiring the model](../authz-rbac/README.md#wiring-the-model)). authz-http resolves the `LinkResolver` from the root container, so share links open only when RBAC is registered there.
- ABAC: an `AbacModel` registered as `AuthorizationModel`, with its `AbacContributor` ([`@spinajs/authz-abac`](../authz-abac/README.md)).
- Your own: `@Injectable(AuthorizationModel)` in the root domain, or `container.register(...).as(AuthorizationModel)` on a child domain's container ([Writing a model](08-writing-a-model.md#registration)).

A model registered after its domain booted is never seen by that domain.

## Configuration

Config lives under `authz.*` (H3). The schema validates the keys below; other sections belong to other packages and stay untouched: `authz.rbac` (authz-rbac), `authz.abac` (authz-abac), `authz.http` (authz-http and authz-http-admin), `authz.orm` (authz-orm), `authz.fs` (authz-fs).

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.permissions.<name>` | `object` | none | see [Declaring permissions](02-permissions.md#configuration) | Permissions of the root domain. |
| `authz.combine` | `object` | `{ default: { algorithm: 'deny-overrides' } }` | see [How a check works](01-check-flow.md#configuration) | Algorithm and models per resource type. |
| `authz.domains.<name>` | `object` | none | name `[A-Za-z0-9_.-]{1,64}`, not `root` | Per-domain overrides ([Domains](05-domains.md#configuration)). |
| `authz.engine.explain` | `boolean` | `false` | | Trace every check at debug level. |
| `authz.engine.modelTimeoutMs` | `integer` | `2000` | `>= 1` | Time budget of one model call or adapter load. |
| `authz.engine.maxDelegation` | `integer` | `2` | `>= 0` | Longest `onBehalfOf` chain. |
| `authz.fields.neverRead` | `string[]` | `['Password']` | field globs | Fields no principal ever reads or writes. |
| `authz.fields.write.mode` | `string` | `'strip'` | `'strip'`, `'reject'` | Read by `@spinajs/authz-http` for body fields. |
| `authz.cache.maxEntries` | `integer` | `10000` | `>= 0` | L2 size; `0` turns the L2 off. |
| `authz.cache.ttlSeconds` | `number` | `60` | `>= 0` | Decision TTL; `0` stores nothing, L1 included. |
| `authz.audit.denials` | `boolean` | `true` | | Audit every denial. |
| `authz.audit.runAs` | `boolean` | `true` | | Audit every `runAs`. |
| `authz.audit.unscoped` | `boolean` | `true` | | Audit unscoped list queries (read by adapters). |
| `authz.audit.service` | `string` | the last `DecisionAudit` registration | a registered class name | The audit sink ([Audit](11-audit.md)). |
| `authz.bus.service` | `string` | the last `ChangeBus` registration | a registered class name | The change bus. Root only. |
| `authz.principals.anonymous.enabled` | `boolean` | `true` | | `false`: no anonymous principal. Read by the principal sources of `@spinajs/authz-http`. |
| `authz.principals.roleSwitch.requirePassword` | `string[] \| null` | unset | role names | Roles a session role switch asks the password for; unset or `null`: every role; `[]` turns the check off. Read by `@spinajs/users`. |
| `authz.principals.roleSwitch.initial` | `{ order: string[] } \| null` | unset | unique role names | A new session starts on the first role of `order` the user holds; unset or `null`: on every held role. Read by `@spinajs/users`' `OrderedActiveRoleHook`. |
| `authz.impersonation.permission` | `string` | `'user:impersonate'` | | Permission an impersonation needs. Read by `@spinajs/users`. |
| `authz.impersonation.protectedRoles` | `string[]` | `['admin']` | role names | Roles nobody may impersonate. Read by `@spinajs/users`. |
| `authz.scopes.attributes.<type>` | `{ schema, defaults? } \| null` | none | a JSON schema | Scope attribute schema of a resource type ([Resource adapters and resolvers](09-adapters-and-resolvers.md#scope-attributes)). |
| `authz.hooks.check` | `boolean` | `false` | | Run the `authz.check` action hook in `check`, `can` and `assert` ([Action hooks](15-action-hooks.md#the-opt-in-check-hook)). Root only. |
| `authz.admin.*` | `object` | see [AuthzAdmin](10-authz-admin.md#configuration) | | The write API. |

```ts
export default {
  authz: {
    permissions: { 'invoice:read': { list: true }, 'invoice:approve': {} },
    combine: { default: { algorithm: 'deny-overrides', models: ['rbac', 'abac'] } },
    engine: { explain: false, modelTimeoutMs: 2000, maxDelegation: 2 },
    fields: { neverRead: ['Password'], write: { mode: 'strip' } },
    cache: { maxEntries: 10000, ttlSeconds: 60 },
    audit: { denials: true, runAs: true, unscoped: true },
    bus: { service: 'QueueChangeBus' },
    principals: { anonymous: { enabled: true } },
  },
};
```

### The `authz` connection

`AUTHZ_CONNECTION` (`'authz'`) is the ORM connection alias of every authz table. The packages that own tables map it to `default` in their config; an app points it elsewhere with `db: { Aliases: { authz: '<connection name>' } }`. The stores read and write through ORM models bound to that alias, so they name no driver and no connection of their own.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthzService` | `AuthzService`, `@PerChildInstance` | `DefaultAuthzService` | none | Not meant to be replaced. |
| `AuthzConfigBootstrapper` | `Bootstrapper` | registers `AUTHZ_CONFIGURATION_SCHEMA` | none | The schema also registers at import (`registerConfigurationSchemaAtImport`). |
| `AuthzContributor` | `AuthzContributor`, every registration of the container chain | `ConfigScopeAttributeSchemas` and the contributors of other packages | your own | `@Injectable(AuthzContributor)`; see [Resource adapters and resolvers](09-adapters-and-resolvers.md#contributors). |
| `AuthzCliBase` | `@spinajs/authz/cli`, base class of CLI commands | none | the commands of `@spinajs/authz-rbac` and `@spinajs/authz-orm` | Extend it for an authz command of your own. It resolves what the command needs from the command's DI container when the command runs and runs the body as `SYSTEM`, so a failing authz boot is reported as one line with exit code 1. |

## Important behaviour

- **The root schema stays open.** Unknown keys under `authz` are kept, so sections of other packages survive validation.
- **Domain defaults come from the root only.** Inside `authz.domains.<name>` an unset key stays unset and is inherited from the parent; the schema fills no defaults there.
- **`authz.bus.service` and `authz.principals` come from the root only**; a domain cannot set them.
- **Config arrays from different files are concatenated** by `@spinajs/configuration`, so a package's config adds permissions and roles to the app's.
- **Registration order matters.** Every model, adapter, resolver, contributor and combinator must be registered before the domain's `AuthzService` first resolves.

## Related

- [Domains](05-domains.md): child domains and their config.
- [Declaring permissions](02-permissions.md): the registry boot fills.
- [`@spinajs/authz-convert`](../authz-convert/README.md): turns a 2.x `rbac.*` config into `authz.*`.
- [The migration guide](migration-guide.md): every 2.x config key and where it went in 3.0.
