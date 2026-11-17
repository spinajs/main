# Scope guards and entry-point glue

A scope guard is a function that sees every change of tenant scope before it happens and can refuse it by throwing. `applyTenantScope` writes a scope into a request store that entry-point code owns, with the same switch refusal and guards as `runInTenant`.

## How it works

### Guards: `onTenantScopeChange(guard)`

1. `onTenantScopeChange(guard)` adds `guard` to a process-wide set and returns a function that removes it.
2. Before a change of scope, each guard runs in registration order with `(from, to)`. `undefined` stands for no scope.
3. A guard that throws stops the change: the error reaches the caller, later guards do not run, and the store is not changed. Throw `TenantSwitchDenied` by convention.
4. With no throw, the change goes ahead.

Which calls ask the guards:

| Call | Guards asked |
| --- | --- |
| `runInTenant` into the tenant already in scope | no |
| `runInTenant` from one tenant into another | no: `TenantSwitchDenied` is thrown first |
| `runInTenant` from no scope or the cross-tenant scope | yes |
| `runAcrossTenants`, from any scope | yes, also when the scope is already cross-tenant |
| `applyTenantScope` with a scope equal to the store's | no |
| `applyTenantScope` from one tenant to another | no: `TenantSwitchDenied` is thrown first |
| any other `applyTenantScope` | yes |
| `forEachTenant`, per tenant | yes, through `runInTenant` |

`from` and `to` can be equal (`runAcrossTenants` inside the cross-tenant scope with the same reason). A guard compares `kind` and the tenant id itself rather than assuming they differ.

### Entry-point glue: `applyTenantScope(store, scope)`

`applyTenantScope` changes the scope of a store in place. It is meant for code that owns the store the rest of the unit of work runs in, such as an HTTP or socket middleware. `@spinajs/tenancy-http` uses it to write the scope into `req.storage` before the policy gate.

1. The store's current `Tenant` key is read; a malformed value counts as no scope.
2. A scope equal to the current one (the same tenant id, or the cross-tenant scope with the same reason, or no scope on both sides) is no change: no guard runs, the authz cache stays, and the store gets `scope` under `Tenant`.
3. A change from one tenant to another throws `TenantSwitchDenied`, as `runInTenant` does. The store is left untouched.
4. Any other change asks the guards. A refusal leaves the store untouched.
5. The `Tenant` and `AuthzCache` keys are removed; then `scope` is written under `Tenant`, or nothing for `undefined`.

`applyTenantScope` does **not** validate `scope`. Build it with `tenantScopeOf` or `allTenantsScope`, which check and freeze it; a hand-written malformed value reads as no scope afterwards.

```mermaid
sequenceDiagram
  participant Glue as Middleware or consumer
  participant apply as applyTenantScope
  participant Guards as onTenantScopeChange guards
  participant Store as Request store
  Glue->>apply: applyTenantScope(store, tenantScopeOf(record))
  apply->>Store: read Tenant
  alt same scope
    apply->>Store: write Tenant
  else tenant to another tenant
    apply-->>Glue: throw TenantSwitchDenied
  else other change
    apply->>Guards: guard(from, to)
    apply->>Store: delete Tenant, AuthzCache; write Tenant
  end
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TenantScopeGuard` | not in DI: a process-wide set kept by the package | none registered | your guards | Register with `onTenantScopeChange(guard)`; call the returned function to remove it |

### Scope guard: custom implementation

Register a guard when a change of scope must be refused under conditions only your application knows: an open unit of work, an allowlist of cross-tenant jobs. Register it once, at startup; it applies to every container in the process.

```ts sample
import { TenantSwitchDenied, onTenantScopeChange } from '@spinajs/tenancy';
import type { TenantScopeGuard } from '@spinajs/tenancy';

const CROSS_TENANT_JOBS = new Set(['nightly billing', 'usage report']);

const onlyListedCrossTenantJobs: TenantScopeGuard = (from, to) => {
  if (to?.kind === 'all' && !CROSS_TENANT_JOBS.has(to.reason)) {
    throw new TenantSwitchDenied(`cross-tenant run "${to.reason}" is not an approved job`);
  }
};

export const removeCrossTenantGuard = onTenantScopeChange(onlyListedCrossTenantJobs);
```

## Important behaviour

- Guards are synchronous: the type is `(from, to) => void`, and a returned promise is not awaited.
- Guards are process-wide, not per DI container. Remove a guard a test registered, or it applies to the next test.
- `applyTenantScope` mutates the store it is given. `runInTenant` and `runAcrossTenants` never mutate the outer store.

## Best practices

- Throw `TenantSwitchDenied` from a guard, so callers handle one error class for every refused change.
- Use `applyTenantScope` only for a store you own and run the rest of the work in. Elsewhere, use `runInTenant`.
- Admit the tenant with [`admitTenant`](04-admission-and-access.md) before you write its scope: `applyTenantScope` does not ask the registry.

## Patterns and antipatterns

```ts
// Don't: a hand-written scope is not validated or frozen; a typo reads as no scope
store.Tenant = { kind: 'tenant', tenant: { id: message.tenant } };

// Do: admit the tenant, then write a scope built by the package
const tenant = await admitTenant(message.tenant);
applyTenantScope(store, tenantScopeOf(tenant));
```

## Examples

### Run a message handler in the tenant the message names

A consumer that builds the store each message runs in.

```ts sample
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { admitTenant, applyTenantScope, requireTenant, tenantScopeOf } from '@spinajs/tenancy';
import type { ITenantAsyncStorage } from '@spinajs/tenancy';

interface OrderPlaced {
  messageId: string;
  tenant: string;
  orderId: string;
}

export async function onOrderPlaced(message: OrderPlaced): Promise<void> {
  const tenant = await admitTenant(message.tenant);

  const store: ITenantAsyncStorage & Record<string, unknown> = { messageId: message.messageId };
  applyTenantScope(store, tenantScopeOf(tenant));

  const als = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;
  await als.run(store, async () => {
    console.log(`order ${message.orderId} placed in ${requireTenant().id}`);
  });
}
```

## Related

- [Tenant scope](01-tenant-scope.md): the scope and the store keys guards protect.
- [Tenant admission and access](04-admission-and-access.md): check a tenant before you enter it.
- [`@spinajs/tenancy-http`](../tenancy-http/README.md): the HTTP and socket middleware that call `applyTenantScope`.
