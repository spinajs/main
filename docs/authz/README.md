# `@spinajs/authz`

The authorization core of SpinaJS. It answers one question: may this principal do this action on this resource? It holds the contracts, the decision engine, the condition language, the host that runs one `AuthzService` per domain, and `AuthzAdmin`, the one write path for authorization data. It replaces the 2.x `rbac` authorization code (`accesscontrol`, `@Permission`, `RbacPolicy`).

It knows no model: RBAC and ABAC are plug-ins, and the app registers them. It does **not** authenticate (the principal comes from `@spinajs/authn`), does **not** read HTTP requests, and does **not** rewrite queries; adapters do that.

- Moving a 2.x app: [the migration guide](./migration-guide.md). What is still open in `3.0.0-rc.1` is in [its section 11](./migration-guide.md#11-open-items-in-300-rc1).
- Authentication (who is calling) is a separate family: [docs/authn](../authn/README.md).
- A file-by-file map of the tables, stores and check pipeline of the whole family: [storage-and-check-flow.md](./storage-and-check-flow.md).

## Install

```sh
npm install @spinajs/authz
```

Importing the package registers the host (`AuthzService`, `AuthzDomains`), the defaults (`InProcessChangeBus`, `LogDecisionAudit`, `LruDecisionCache`, `SystemClock`), the condition compiler and its built-in functions, `DefaultAuthzAdmin` with `MemoryAuthzAdminBackend`, and the `authz.*` config schema.

## Features

| Feature | What it does |
| --- | --- |
| [How a check works](01-check-flow.md) | Concepts, the check pipeline end to end, combining algorithms and deny reasons. |
| [Declaring permissions](02-permissions.md) | Naming, declaring and registering a permission so it can be granted and checked. |
| [Checking permissions](03-checking-permissions.md) | `authz()`, every `AuthzService` method, conditional allows, batch checks, access plans, `summary`, `covers` and the errors. |
| [Host, boot and configuration](04-host-boot-and-configuration.md) | What a domain boot does, the boot checks, wiring the models and every `authz.*` key. |
| [Domains](05-domains.md) | Child domains with their own models, permissions and settings; what a booted domain exposes. |
| [Caching and change propagation](06-caching-and-change-propagation.md) | L1 and L2 decision caches, invalidation over the `ChangeBus`, `authz.changed` pushes. |
| [Conditions](07-conditions.md) | The JSON condition language, its compiler and custom condition functions. |
| [Writing a model](08-writing-a-model.md) | The `AuthorizationModel` contract, list plans, native filters and custom combinators. |
| [Resource adapters and resolvers](09-adapters-and-resolvers.md) | `ResourceAdapter`, `ScopeResolver`, `RelationResolver`, scope attributes and contributors. |
| [AuthzAdmin](10-authz-admin.md) | The command bus for authorization writes: commands, permissions, guard, backend, events, handler helpers. |
| [Audit](11-audit.md) | `DecisionAudit`: denials, `runAs`, `SYSTEM`, `explain` and admin entries. |
| [Column relations](12-column-relations.md) | `@Relation` columns that hold a principal, for single checks and `.accessible()` lists. |
| [Holders](13-holders.md) | Who holds a permission on a resource: the `holders` admin query, `inspect()` and `ancestors()`. |

## Quick start

Declare the permission and grant it (here through an RBAC role), resolve the service at boot, then check before acting:

```ts
// config/authz.ts
export default {
  authz: {
    permissions: { 'invoice:approve': {} },
    rbac: { roles: { accountant: { grants: ['invoice:approve'] } } },
  },
};
```

```ts sample
import { DI } from '@spinajs/di';
import { AuthzService, authz } from '@spinajs/authz';

// At app start, after the RBAC model is registered (see authz-rbac).
export async function bootAuthz(): Promise<void> {
  await DI.resolve(AuthzService);
}

// Anywhere in a request or a job.
export async function approveInvoice(invoiceId: string): Promise<void> {
  const me = authz().current();
  await authz().assert(me, 'invoice:approve', { type: 'invoice', id: invoiceId });
  // ... approve the invoice
}
```

`assert` throws `AccessDenied` (403) with the decision when the caller may not approve.

## Related packages

- [`@spinajs/authn`](../authn/README.md): authentication. It defines the `Principal` (who is calling, its ceiling, delegation and `authn` facts) that every check takes; `@spinajs/authz` re-exports the principal types, `SYSTEM` and `UNATTENDED`. How authn hands the principal to authz: [Principal and authz](../authn/07-principal-and-authz.md).
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the RBAC model (roles, grants, assignments, ladders, rules, share links), its stores, `DefaultAdminGuard` and `DbAuthzAdminBackend`.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the ABAC model (permit and deny policies over [conditions](07-conditions.md)) and its policy stores.
- [`@spinajs/authz-orm`](../authz-orm/README.md): the ORM adapter: `@AccessResource` models, the ancestor table, `.accessible()` lists, `$access`, `DbDecisionAudit` and `DbScopeAttributeStore`.
- [`@spinajs/authz-http`](../authz-http/README.md): `@Access` route guards, principal sources, field filtering, `/user/access` and access-change events.
- [`@spinajs/authz-http-admin`](../authz-http-admin/README.md): HTTP routes over [AuthzAdmin](10-authz-admin.md).
- [`@spinajs/authz-queue`](../authz-queue/README.md): who started a job, `@Job({ runAs })`, and `QueueChangeBus` for several nodes.
- [`@spinajs/authz-fs`](../authz-fs/README.md): file checks (`AuthzFsMiddleware`) and the per-path file ACL (`fs_acl`).
- [`@spinajs/authz-testing`](../authz-testing/README.md): fakes, harnesses, conformance suites and the behaviour fixtures B01-B47.
- [`@spinajs/authz-convert`](../authz-convert/README.md): the `spinajs-authz-convert` tool that turns 2.x configs into `authz.*`.
- [`@spinajs/eslint-plugin-authz`](../eslint-plugin-authz/README.md): flags list queries without `.accessible()` at edit time.
