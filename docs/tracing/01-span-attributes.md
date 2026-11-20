# Span attribute names

`SpinaAttr` holds the `spina.*` attribute keys. SpinaJS packages set the keys marked below; the others are reserved, set by no package yet. Use these constants when your own spans carry the same facts, so one query in the tracing backend finds framework and app spans alike.

This page documents only the keys, not the spans that carry them.

## How it works

1. `SpinaAttr` is a readonly (`as const`) object exported from `@spinajs/tracing`.
2. A span sets an attribute with a `SpinaAttr` key: at start (`withSpan(name, { attributes })`) or later (`span.setAttribute(SpinaAttr.X, value)`).
3. The configured span processors export the attribute with the span.

## Attribute keys

| Constant | Attribute | Set by |
| --- | --- | --- |
| `SpinaAttr.PrincipalId` | `spina.principal.id` | `@spinajs/authn` (a successful authentication) and `@spinajs/authz` (a check): the principal key, `type:id` |
| `SpinaAttr.PrincipalActor` | `spina.principal.actor` | `@spinajs/authz`: the principal key (`type:id`) of the decision's actor, when it has one |
| `SpinaAttr.HttpAborted` | `spina.http.aborted` | `@spinajs/http`: `true` when the client aborted the request |
| `SpinaAttr.Controller` | `spina.route.controller` | `@spinajs/http` |
| `SpinaAttr.Action` | `spina.route.action` | `@spinajs/http` |
| `SpinaAttr.Policy` | `spina.policy.name` | `@spinajs/http` |
| `SpinaAttr.PolicyResult` | `spina.policy.result` | `@spinajs/http`: `'allow'` or `'deny'` |
| `SpinaAttr.AuthzDomain` | `spina.authz.domain` | `@spinajs/authz` |
| `SpinaAttr.AuthzPermission` | `spina.authz.permission` | `@spinajs/authz` |
| `SpinaAttr.AuthzResource` | `spina.authz.resource` | `@spinajs/authz` |
| `SpinaAttr.AuthzAllowed` | `spina.authz.allowed` | `@spinajs/authz` |
| `SpinaAttr.AuthzReason` | `spina.authz.reason` | `@spinajs/authz`: the code of the decision's reason, when it has one |
| `SpinaAttr.AuthzCached` | `spina.authz.cached` | `@spinajs/authz` |
| `SpinaAttr.AuthnStrategy` | `spina.authn.strategy` | `@spinajs/authn` |
| `SpinaAttr.AuthnStatus` | `spina.authn.status` | `@spinajs/authn`: the status of the strategy's result |
| `SpinaAttr.AuthnReason` | `spina.authn.reason` | `@spinajs/authn`: on a failure |
| `SpinaAttr.QueryFingerprint` | `spina.db.fingerprint` | not set by any package yet |
| `SpinaAttr.QueryConnection` | `spina.db.connection` | not set by any package yet |
| `SpinaAttr.RunId` | `spina.scheduler.run_id` | not set by any package yet |
| `SpinaAttr.Schedule` | `spina.scheduler.schedule` | not set by any package yet |
| `SpinaAttr.Step` | `spina.scheduler.step` | not set by any package yet |
| `SpinaAttr.Resumed` | `spina.scheduler.resumed` | not set by any package yet |
| `SpinaAttr.SocketCommand` | `spina.socket.command` | not set by any package yet |
| `SpinaAttr.Tenant` | `spina.tenant.id` | not set by any package yet; set it on your own spans |

## Important behaviour

- `SpinaAttr` names keys only; setting a key does not make any package read it.
- `spina.tenant.id` carries a tenant id. Code that runs across all tenants (`runAcrossTenants()` of `@spinajs/tenancy`) has no single id; leave the attribute unset there.

## Best practices

- Take the tenant from `currentTenant()` of `@spinajs/tenancy` rather than from request input, so the span shows the scope the code ran in.
- Use the constant, never the string literal: a renamed key then fails to compile instead of splitting your traces.

## Examples

### Tag a background job span with its tenant

```ts sample
import { currentTenant, runInTenant } from '@spinajs/tenancy';
import { SpinaAttr, withSpan } from '@spinajs/tracing';

export async function rebuildSearchIndex(tenantId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    await withSpan('search.rebuild', {}, async (span) => {
      const tenant = currentTenant();
      if (tenant) {
        span.setAttribute(SpinaAttr.Tenant, tenant.id);
      }
      // rebuild the index of this tenant
    });
  });
}
```

## Related

- [`@spinajs/tenancy`](../tenancy/README.md): `runInTenant`, `currentTenant`.
- [Async context and tracing](../log/12-async-context-and-tracing.md): the `Tenant` field on log lines.
