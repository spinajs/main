# Custom access policies

A telemetry slot can name any registered `BasePolicy`, so an endpoint can be guarded by your own rule: a network allowlist, a feature switch, a signed header. The same slots also guard your own routes through `@TelemetryAccess()`.

## How it works

1. Your class extends `BasePolicy` from `@spinajs/http` and carries `@Injectable(BasePolicy)`. The import adds it to the `BasePolicy` list under its class name.
2. A slot names it: `telemetry.auth.policies.<endpoint> = '<ClassName>'`.
3. When the route registers, `TelemetryAccessPolicy` checks `DI.checkType(BasePolicy, '<ClassName>')`, finds the class in `DI.getRegisteredTypes(BasePolicy)` and resolves it with `DI.resolve(type)`. The result must be a `BasePolicy` instance, not a promise.
4. Per request, `TelemetryAccessPolicy.isEnabled()` and `execute()` delegate to your policy. A throw from `execute()` (e.g. `Forbidden`) stops the request with that error's status.
5. For your own routes, `@TelemetryAccess('<slot>')` attaches the same guard. The slot and, for `'AccessPolicy'`, the permission come from configuration like the built-in ones.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@TelemetryAccess(endpoint)` | controller method or class | `endpoint`: slot name under `telemetry.auth.policies` and `telemetry.auth.permissions` | Adds one policy group `@Policy(TelemetryAccessPolicy, endpoint)` |

Every `@Policy()` call, `@TelemetryAccess()` included, forms its own group, and groups combine with OR. A route with `@TelemetryAccess('x')` and `@Policy(Other)` passes when **either** passes.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `telemetry.auth.policies.<slot>` | `string` | none for your slots | `'AccessPolicy'` or a registered `BasePolicy` class name | Required for every slot a route uses |
| `telemetry.auth.permissions.<slot>` | `string \| string[]` | none for your slots | registered permissions | Required when the slot is `'AccessPolicy'` |

```ts
export default {
  telemetry: {
    auth: {
      policies: { ready: 'InternalNetworkPolicy', jobs: 'AccessPolicy' },
      permissions: { jobs: 'jobs:read' },
    },
  },
  authz: { permissions: { 'jobs:read': { description: 'Read the job queue dashboard' } } },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Named slot policy | `BasePolicy` list, `@Injectable(BasePolicy)`; resolved by class name, synchronously, when the route registers; singleton unless the class says otherwise | `PublicPolicy` (probes), `TelemetryTokenPolicy` (deprecated) | your `BasePolicy` | Register it before the HTTP server registers routes, then put its class name in the slot |
| Slot guard on your routes | `TelemetryAccessPolicy` via `@TelemetryAccess(slot)` | none | `@Policy()` from `@spinajs/http` | Configure the slot; `TelemetryAccessContributor` checks its permissions at domain boot like the built-in ones |

### `BasePolicy`: let only the cluster network reach the probes

```ts sample
import { Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

const INTERNAL_PREFIXES = ['10.', '192.168.', '127.0.0.1', '::1'];

/** Admits requests whose client IP is on the cluster network. Slot value: 'InternalNetworkPolicy'. */
@Injectable(BasePolicy)
export class InternalNetworkPolicy extends BasePolicy {
  public isEnabled(_route: IRoute, _controller: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const ip = req.storage?.realIp ?? req.ip ?? '';
    if (!INTERNAL_PREFIXES.some((prefix) => ip.startsWith(prefix))) {
      throw new Forbidden('telemetry probes are reachable from the cluster network only');
    }
  }
}

// config: telemetry.auth.policies.ready = 'InternalNetworkPolicy', telemetry.auth.policies.health = 'InternalNetworkPolicy'
```

`req.storage.realIp` is set by the client IP middleware of `@spinajs/http`; behind a proxy, configure trusted proxies there first.

### `@TelemetryAccess`: guard your own dashboard route

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { TelemetryAccess } from '@spinajs/telemetry';

declare function queueDepths(): Promise<Record<string, number>>;

// config: telemetry.auth.policies.jobs = 'AccessPolicy', telemetry.auth.permissions.jobs = 'jobs:read'
@BasePath('ops')
export class JobDashboardController extends BaseController {
  @Get('jobs')
  @TelemetryAccess('jobs')
  public async jobs() {
    return new Ok({ queues: await queueDepths() });
  }
}
```

A missing `jobs` slot fails the registration of `JobDashboardController`; a `jobs:read` nobody registered fails the root authz domain boot.

## Important behaviour

- The named policy must resolve synchronously. A policy that extends `AsyncService` resolves to a promise and fails the slot.
- The class name is the key. Two policies with the same class name share one registration.
- The slot is read once, when the route registers. Changing it needs a restart.
- A slot cannot name `TelemetryAccessPolicy` itself.
- `isEnabled()` runs per request. A named policy that returns `false` steps aside; when no other policy group of the route applies, the route runs unguarded. Return `false` only to step aside, never to deny.

## Best practices

- Throw `Forbidden` or `Unauthorized` from `@spinajs/exceptions` in `execute()`, so the answer has the right status and body.
- Keep a named policy stateless; it is one instance for all routes and requests.
- Use `'AccessPolicy'` with a permission when the caller is a principal; reserve named policies for rules that do not depend on identity.

## Patterns and antipatterns

```ts
// Don't: stack a second @Policy to "add" a condition; groups combine with OR,
// so the route opens to anyone InternalNetworkPolicy admits
@TelemetryAccess('jobs')
@Policy(InternalNetworkPolicy)

// Do: put the condition into the slot policy itself, or AND inside one group
@Policy([TelemetryAccessPolicy, InternalNetworkPolicy], 'jobs')
```

## Examples

### Admit only the load balancer by a shared header

```ts sample
import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Slot value: 'LoadBalancerPolicy'. The secret comes from the environment, never from the request. */
@Injectable(BasePolicy)
export class LoadBalancerPolicy extends BasePolicy {
  protected readonly secret = process.env.LB_PROBE_SECRET ?? '';

  public isEnabled(_route: IRoute, _controller: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    const presented = req.headers['x-lb-probe'];
    if (this.secret.length === 0 || typeof presented !== 'string' || !timingSafeEqual(digest(presented), digest(this.secret))) {
      throw new Forbidden('probe header missing or wrong');
    }
  }
}
```

## Related

- [Endpoint access](10-endpoint-access.md): the slots, `'AccessPolicy'` and the contributor.
- [`@spinajs/http` policies](../http/13-policies.md): `BasePolicy`, `@Policy()` groups and named policies.
- [`@spinajs/http` client IP](../http/17-client-ip-and-trust-proxy.md): where `req.storage.realIp` comes from.
