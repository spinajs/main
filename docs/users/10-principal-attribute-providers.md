# Principal attribute providers

A `PrincipalAttributeProvider` derives attributes from the user record and puts them on every `user:<Uuid>` principal [`UserPrincipalFactory`](09-principal-factory.md) builds. ABAC conditions then read them as `principal.attributes.<key>`. Use one for facts the application owns: a user's pool, tenant, department, plan.

## How it works

1. You register a class with `@Injectable(PrincipalAttributeProvider)` (or `DI.register(...).as(PrincipalAttributeProvider)`).
2. When DI builds the `UserPrincipalFactory` singleton, `@Autoinject(PrincipalAttributeProvider)` captures every registered provider, in registration order.
3. For each user principal, the factory starts the attributes from what the strategy asserted (`extra.attributes`), then calls each provider's `attributes(user, principal)`:
   - `user` is the record, `Metadata` populated when the factory loaded it;
   - `principal` is the principal built so far, with the attributes merged before this provider.
4. It merges each answer over the attributes so far: a provider's keys win over the strategy's and over earlier providers'.
5. The final attributes are frozen.

Providers are not called for `agent:<id>` principals; an agent carries only the attributes in `extra`.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Attribute providers | `PrincipalAttributeProvider` (abstract), a list captured by `UserPrincipalFactory` when it is built; each provider keeps its own lifetime | none | any number | `@Injectable(PrincipalAttributeProvider)` on your class, imported before the factory is first resolved (before boot). Remove one with `DI.unregister(Provider)`. |

### Custom provider: department and plan for ABAC

```ts sample
import { Injectable } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { PrincipalAttributeProvider } from '@spinajs/users';
import type { User } from '@spinajs/users';

@Injectable(PrincipalAttributeProvider)
export class DepartmentAttributeProvider extends PrincipalAttributeProvider {
  public async attributes(user: User, _principal: Principal): Promise<Readonly<Record<string, unknown>>> {
    return {
      department: user.Metadata?.['hr:department'] ?? null,
      plan: user.Metadata?.['billing:plan'] ?? 'free',
    };
  }
}
```

An ABAC condition can now compare `principal.attributes.department` with a resource field.

## Important behaviour

- Providers are captured **once**, when the factory singleton is built. Register them before boot; a provider registered later is ignored until the container is rebuilt.
- A provider that throws fails the principal build, and with it the login or the job. Return a default instead of throwing for missing data.
- A provider runs on every principal build: every sign-in, every session resolve that rebuilds the principal, every job run as its initiator. Keep it cheap.
- A provider that needs authz resolves `AuthzService` per call; injecting it would boot the authz domain while that domain is building this factory.
- Provider keys override what an OIDC or other strategy asserted. Name your keys so they do not collide with strategy claims you rely on.

## Best practices

- Read from the `user` argument first; it is already loaded with metadata. Query other tables only when you must.
- Return only scalars or small plain objects; ABAC compares them and the principal may be serialized into a session.
- Use one provider per concern (tenant, billing, HR) so each can be removed with `DI.unregister`.

## Patterns and antipatterns

```ts
// Don't: injected AuthzService boots the domain that is still building the factory
@Injectable(PrincipalAttributeProvider)
class PoolProvider extends PrincipalAttributeProvider {
  @Autoinject(AuthzService) protected Authz: AuthzService;
  public async attributes(user: User) { return { pool: await this.Authz.runAs(SYSTEM, 'pool', () => poolOf(user)) }; }
}

// Do: resolve it per call
@Injectable(PrincipalAttributeProvider)
class PoolProvider extends PrincipalAttributeProvider {
  public async attributes(user: User) {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    return { pool: await authz.runAs(SYSTEM, 'pool', () => poolOf(user)) };
  }
}
```

## Examples

### Tenant id from a membership table

```ts sample
import { DI, Injectable } from '@spinajs/di';
import { AuthzService, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { PrincipalAttributeProvider } from '@spinajs/users';
import type { User } from '@spinajs/users';

@Connection('default')
@Model('tenant_members')
export class TenantMember extends ModelBase<TenantMember> {
  @Primary()
  public Id: number;

  public UserUuid: string;

  public TenantId: string;
}

@Injectable(PrincipalAttributeProvider)
export class TenantAttributeProvider extends PrincipalAttributeProvider {
  public async attributes(user: User, _principal: Principal): Promise<Readonly<Record<string, unknown>>> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    // As SYSTEM: the membership table may itself be access-controlled.
    const member = await authz.runAs(SYSTEM, 'tenant-attribute', () => TenantMember.where('UserUuid', user.Uuid).first());
    return { tenant: member?.TenantId ?? null };
  }
}
```

## Related

- [Principal factory](09-principal-factory.md): where the providers run.
- [`@spinajs/authz`](../authz/README.md): ABAC conditions that read `principal.attributes`.
- [Multiple implementations](../di/06-multiple-implementations.md): how lists of services are registered and removed.
