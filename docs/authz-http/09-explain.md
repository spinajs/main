# Explain

Two debugging aids show why a check was decided the way it was: the `GET /authz/explain` route explains a check for any principal, and a 403 from `@Access` can carry the trace of the denial. Both are off in production, whatever the configuration says.

## How it works

### The explain route

1. At startup, http asks every `ControllerSource` for controllers. `ExplainControllerSource.getControllers()` returns `ExplainController` only when `authz.http.explainRoute.enabled` is exactly `true` and the app is not in production. Enabled in production, it logs a warning and registers nothing, so the route answers 404.
2. `ExplainPolicy` (the route's `@Policy`) refuses an unauthenticated caller with 401. It checks `authz.http.explainRoute.permission` (default `authz:explain`) for the caller on the permission's type-level resource, in the domain `authz.http.access.domain`, or the one the [`AuthzDomainResolver`](../authz/05-domains.md#per-request-domains) names for the request. Anything but an unconditional allow is a 403.
3. `ExplainController.explain()` reads the query:
   - `principal=<type>:<id>` (required; `%3A` and `%25` in the type are decoded as in principal keys);
   - `permission=<name>` (required, a valid permission name of up to 256 characters);
   - `resource=<type>[:<id>]` (optional; default the type-level ref of the permission);
   - `format=decision|tree` (optional; default `decision`).
   Each value is validated as its own `@Query()` argument (`EXPLAIN_QUERY_PROPERTIES`: `principal` and `resource` up to 256 characters, `format` one of `''`, `decision`, `tree`). A malformed value is a 400; a `permission` that does not match the name pattern, or a value over its cap, answers the standard validation 400, a malformed `<type>:<id>` an `InvalidArgument` naming the field. A permission that is not registered is still a 500.
4. It builds a bare principal from `principal` (`authenticated` unless the type is `anonymous` or `unattended`, `source: 'explain'`, no attributes, no ceiling) and calls `AuthzService.explain()` in that domain.
5. `format=decision` answers the `Decision` with its `trace`. `format=tree` answers `explainTree(decision)`: `{ label, allowed, children }`, one child per model vote with its trace steps, then the engine's combining step.

```text
GET /authz/explain?principal=user:alice&permission=file:read&resource=file:f1&format=tree

{ "label": "file:f1#file:read = deny (no_access)", "allowed": false, "children": [
    { "label": "rbac: abstain", "allowed": false, "children": [ ... ] },
    { "label": "deny-overrides over [rbac] in root", "allowed": false, "children": [ ... ] } ] }
```

Node labels: the root is `<resource>#<permission> = allow | conditional | deny (<code>)`; a vote is `<model>: permit | deny | abstain | conditional | error (<message>)`, with the reason code when there is one.

### Trace in a 403

When `AccessPolicy` denies a request, `AccessPolicy.trace()` adds `trace` to the 403 body only when all of these hold:

1. the app is not in production;
2. the route's domain has `engine.explain` exactly `true` (`authz.engine.explain`, or `authz.domains.<name>.engine.explain`);
3. the caller holds `authz.http.explainRoute.permission` unconditionally in that domain. A failing check (an unknown permission, say) gives no trace, never a 500.

The trace is the one `AuthzService.explain()` returns for the denied permission and resource.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.http.explainRoute.enabled` | `boolean` | `false` | `true`, `false` | `true` mounts `GET /authz/explain` outside production. Any other value (`'true'`, `1`) keeps it off. |
| `authz.http.explainRoute.permission` | `string` | `'authz:explain'` | a permission name | What a caller must hold, unconditionally, to use the route and to see traces in a 403. |
| `authz.http.access.domain` | `string` | `'root'` | a domain name | The domain the route explains in and checks its permission in; the fallback of the `AuthzDomainResolver`. |
| `authz.engine.explain` | `boolean` | `false` | | Per domain: lets a 403 carry the trace. |
| `configuration.isProduction` | `boolean` | `false` | | `true` turns both aids off. When it is not a boolean, `APP_ENV` (else `NODE_ENV`) naming production does. |

```ts
export default {
  configuration: { isProduction: false },
  authz: {
    permissions: { 'authz:explain': {} },
    engine: { explain: true },
    http: { explainRoute: { enabled: true, permission: 'authz:explain' } },
  },
};
```

Declare the explain permission in `authz.permissions` and grant it to the people who debug access.
<!-- TODO(docs-hook): verify the explain route's answer when authz.http.explainRoute.permission is not a registered permission (500 or 403) -->

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `ExplainControllerSource` | `ControllerSource` list, `@Injectable(ControllerSource)` | `ExplainControllerSource` | | See [Controller discovery](../http/03-controller-discovery.md). |
| `ExplainController` | `BaseController`, `@BasePath('authz')`, handed to http only by `ExplainControllerSource` | `ExplainController` | | Not meant to be replaced. |
| `ExplainPolicy` | plain `BasePolicy` on the explain route | `ExplainPolicy` | | Not meant to be replaced. |
| `explainTree(decision)` | exported function returning `ExplainNode` | | | Render a decision you got from `authz().explain()` in your own tools. |

## Important behaviour

- **Never in production.** `configuration.isProduction: true` wins over every switch; the route is not even registered.
- **The route explains a bare principal.** It knows only `<type>:<id>`: no attributes, no ceiling, no session facts. A decision that depends on them can differ from the real request's.
- **The route can explain anyone.** Whoever holds the explain permission sees how any principal is decided; grant it like an admin permission.
- **Only an unconditional grant counts.** A conditional grant of the explain permission is a 403 on the route and no trace in a 403.

## Best practices

- Turn on `authz.engine.explain` and the route in development and staging only, per environment config ([Environments](../configuration/02-environments.md)).
- Use `format=tree` for a quick read and the full decision when you need the residuals and steps.

## Related

- [Protecting routes](01-protecting-routes.md#status-codes-and-error-bodies): the 403 body the trace joins.
- [`@spinajs/authz`](../authz/03-checking-permissions.md): `explain()` and decision traces.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): its `authz:explain` CLI command explains a check from a terminal.
