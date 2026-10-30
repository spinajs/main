# Policies

A policy decides whether a route may run for the current request. Attach it with `@Policy` to a controller or a route; the route runs only when its policies hold, otherwise the policy's exception becomes the answer (usually 401 or 403). Combine policies with AND inside one `@Policy([...])`, with OR across stacked `@Policy` decorators, and the controller scope with the route scope by AND.

## How it works

**At startup**, for each route, `resolveRoutePolicies()`:

1. Takes the controller's groups and the route's groups separately. Each `@Policy()` call is one group.
2. Resolves each policy with `container.resolve(type, options)`, passing the decorator's extra arguments as constructor options.
3. For a string entry, reads the configuration value at that key and expects the **name** of a class registered as `BasePolicy`. A missing value or an unregistered name throws `RouteRegistrationException`.

**Per request**, the policy gate (`createPolicyGate()`), the first handler of the route:

1. Keeps only the policies whose `isEnabled(route, controller)` returns `true`. A group left empty is dropped, not treated as passing.
2. Drops a scope (controller or route) that has no group left.
3. No scope left: the route runs.
4. Calls `execute(req, route, controller)` on every remaining policy in parallel and waits for all of them.
5. The route runs when **every** scope has **at least one** group whose **every** policy resolved.
6. Otherwise it forwards one rejection of the first failing scope to the [error handler](11-error-handling.md): the first one that is not an `AuthenticationFailed`, else the first in declaration order. A refusal (403) from one group so wins over a missing credential (401) from another, whatever the decorator order.

```text
@Policy(A)            controller scope:  A OR (B AND C)
@Policy([B, C])
class X {
  @Policy(D)          route scope:       D OR E
  @Policy(E)
  route() {}
}                     route runs when:   (A OR (B AND C)) AND (D OR E)
```

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Policy(policy, ...options)` | class or method | `policy`: a `BasePolicy` class, a configuration key, or an array of them (one AND group); `options`: constructor arguments for every policy in the group | Adds one group to the controller scope (class) or the route scope (method). |

Order of stacked `@Policy` decorators changes only which failure is reported.

### `@Public(reason)`: a route that is open on purpose

`@Public('why')` on a class or a method says the route is meant to be reachable by everyone, and why. It is metadata
only: it adds no policy and changes nothing at request time. `spinajs doctor` reads it, so a deliberately open route
(a login, a health check, a webhook) is not reported by HTTP002 as a route with no `@Access`, `@Policy` or
`@AllowAnonymous`. A package that must not depend on `@spinajs/authz-http` declares such a route with it.

```ts
@BasePath('auth')
class LoginController extends BaseController {
  @Post('login')
  @Public('anyone may try to sign in; the credentials are the guard')
  public async login(@Body() body: LoginBody) {}
}
```

- The reason is required: an empty or blank string throws when the decorator is applied.
- The manifest records it as `public` (the reason) on the controller or the route, and `spinajs generate:openapi` gives
  such an operation `security: []`, as it does for `@AllowAnonymous`.
- `@Public` next to `@Access` or `@Policy` on the same route, or on its class, contradicts the guard: the guard still
  runs, doctor warns (HTTP006) and the OpenAPI operation keeps its security. A class-level `@Public` with a guard on one
  of its routes is not reported; the route's guard wins.

## Configuration

A string in `@Policy` is a configuration key whose value names a policy class:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| any key you choose, eg. `metrics.auth.policy` | `string` | none | the class name of a `BasePolicy` registered with `@Injectable(BasePolicy)` | The policy the route uses; switch it per environment without code changes. |

```ts
export default {
  metrics: {
    auth: {
      // 'AllowAllPolicy' in development
      policy: 'ScrapeTokenPolicy',
    },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `BasePolicy` (abstract) | By class in `@Policy(Class)`: `container.resolve(Class, options)`, the class's own lifetime (singleton by default). By name for configuration keys: must be registered under `BasePolicy` with `@Injectable(BasePolicy)` | none | policies in `@spinajs/authn-http` and `@spinajs/authz-http` | Extend `BasePolicy`, implement `isEnabled()` and `execute()`. To swap a policy everywhere, `DI.register(Mine).as(TheirPolicy)` before `Controllers` resolves. To swap a configured one, change the configuration value. |
| Policy gate | `createPolicyGate(policies, route, controller, log)`, exported | built into `BaseController.resolve()` | | Not replaceable per route; express the logic as policies. |

Members:

| Member | Meaning |
| --- | --- |
| `isEnabled(route, controller): boolean` | Whether the policy takes part for this route. Called per request. Return `false` to step aside, not to deny. |
| `execute(req, route, controller): Promise<void>` | Resolve to allow; reject (throw) to deny. The rejection is the answer. |

### `BasePolicy`: custom implementation

An API-key policy, configurable per route through `@Policy` options, registered under `BasePolicy` so a configuration key can name it too:

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Get, IController, IRoute, Ok, Policy } from '@spinajs/http';
import * as express from 'express';

const API_KEYS: Record<string, string[]> = {
  'k-reporting-1': ['reports:read'],
  'k-admin-1': ['reports:read', 'reports:write'],
};

// NewInstance: each @Policy(ApiKeyPolicy, scope) gets its own instance with its own scope.
@Injectable(BasePolicy)
@NewInstance()
export class ApiKeyPolicy extends BasePolicy {
  constructor(protected Scope: string = 'reports:read') {
    super();
  }

  public isEnabled(_route: IRoute, _controller: IController): boolean {
    return true;
  }

  public async execute(req: express.Request, _route: IRoute, _controller: IController): Promise<void> {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string') {
      throw new AuthenticationFailed('x-api-key header missing');
    }
    if (!(API_KEYS[key] ?? []).includes(this.Scope)) {
      throw new Forbidden(`api key lacks scope ${this.Scope}`);
    }
  }
}

/** Allows requests from the internal network only. */
export class InternalNetworkPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: express.Request): Promise<void> {
    const ip = (req as any).storage?.realIp as string | undefined;
    if (!ip || !(ip.startsWith('10.') || ip === '127.0.0.1')) {
      throw new Forbidden('internal network only');
    }
  }
}

@BasePath('reports')
@Policy(ApiKeyPolicy) // every route: an API key with reports:read ...
export class ReportsApiController extends BaseController {
  @Get('daily')
  public daily() {
    return new Ok({ rows: [] });
  }

  // ... AND (a reports:write key OR a call from the internal network)
  @Get('rebuild')
  @Policy(ApiKeyPolicy, 'reports:write')
  @Policy(InternalNetworkPolicy)
  public rebuild() {
    return new Ok({ queued: true });
  }
}
```

A singleton policy receives the options of its first resolve only. `ApiKeyPolicy` is resolved with two option sets, so it is `@NewInstance()`: one instance per route and group, built at startup.

## Important behaviour

- A controller-wide policy can only narrow a route: the controller scope and the route scope are combined with AND, so a route policy can never stand in for the controller's.
- Policies are resolved once per route at startup. `execute()` runs per request on the same instance: keep request data out of fields.
- `isEnabled()` runs per request. A group whose policies all return `false` is dropped; when every group of a scope is dropped, the scope does not restrict the route.
- All enabled policies run, even when one has already failed; side effects in `execute()` happen for every request.
- A route with no enabled policy runs with no check at all. Guard sensitive controllers with a controller-wide policy.
- A configuration key that does not resolve to a registered `BasePolicy` stops the startup; a silently dropped policy would leave the route open.
- `execute()` that throws a plain `Error` answers 500. Throw `AuthenticationFailed` (401) or `Forbidden` (403).

## Best practices

- Pass an array to `@Policy([A, B])` when a route needs several conditions; stack separate `@Policy` decorators only for alternative access paths.
- Use `isEnabled()` to skip a policy that does not apply (a route marked public), never to deny.
- Name policies in configuration (`@Policy('metrics.auth.policy')`) when operators choose the access model per deployment.

## Patterns and antipatterns

```ts
// Don't: two decorators mean OR; a session alone or a feature switch alone opens the route.
@Policy(SessionPolicy)
@Policy(BetaFeaturePolicy)
@Get('beta')
public beta() { /* ... */ }

// Do: one group means AND.
@Policy([SessionPolicy, BetaFeaturePolicy])
@Get('beta')
public beta() { /* ... */ }
```

## Examples

### Choose the metrics guard per environment

```ts sample
import { Injectable } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { BaseController, BasePath, BasePolicy, Get, Ok, Policy } from '@spinajs/http';
import * as express from 'express';

@Injectable(BasePolicy)
export class ScrapeTokenPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(req: express.Request): Promise<void> {
    if (req.headers.authorization !== `Bearer ${process.env.SCRAPE_TOKEN}`) {
      throw new Forbidden('scrape token required');
    }
  }
}

@Injectable(BasePolicy)
export class AllowAllPolicy extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

@BasePath('metrics')
export class MetricsController extends BaseController {
  /** config: metrics.auth.policy = 'ScrapeTokenPolicy' in production, 'AllowAllPolicy' locally */
  @Get('/')
  @Policy('metrics.auth.policy')
  public metrics() {
    return new Ok({ uptime: process.uptime() });
  }
}
```

## Related

- [Route middlewares](14-route-middlewares.md): run after the policy gate.
- [Error handling](11-error-handling.md): how a policy's exception becomes the answer.
- [Client IP and trusted proxies](17-client-ip-and-trust-proxy.md): `req.storage.realIp` for network policies.
- `@spinajs/authn-http`, `@spinajs/authz-http`: session, role and permission policies.
