# API

Every Studio route is served under `studio.path` (default `/_studio`), below `http.controllers.route.prefix` when one is set. Each route is guarded by its slot `studio.auth.policies.<endpoint>`; see [Permissions](01-overview.md#permissions).

The response types are exported from `@spinajs/studio/contracts`, which holds types only. A query or path value that fails its schema is answered `400`.

## `GET /api/capabilities`

Endpoint `capabilities`. Answers `StudioCapabilities`: the Studio version, the loaded manifest, the tracing owner and whether spans are recorded, the features this app has (`traces`, `logs`, ...) and the Studio permissions the caller holds.

## `GET /api/traces`

Endpoint `traces`. Buffered traces, newest first, as `StudioPage<TraceSummary>`.

| Parameter | Value |
| --- | --- |
| `route` | The `http.route` of the root span, matched exactly. |
| `name` | Part of the root span name. |
| `status` | `error`: traces with an error span; `ok`: traces without one. |
| `minDurationMs` | Shortest duration of the trace, in milliseconds, up to one day. |
| `principalId` | The first `spina.principal.id` recorded in the trace. |
| `from`, `to` | ISO dates; the trace started in this range. |
| `limit` | 1 to 500; default 50. |
| `cursor` | The `cursor` of the previous page. |

`cursor` is opaque: send back what the previous page returned. A page without `cursor` is the last one. An empty value counts as absent.

A summary with `complete: false` belongs to a trace whose root span has not ended yet.

## `GET /api/traces/:traceId`

Endpoint `traces`. One trace as `TraceDetail`: its summary, its spans, the buffered log lines that carry its trace id (oldest first), and `truncated`, which is `true` when spans are missing.

`traceId` is 32 lower-case hex digits; anything else is a `400`. A trace that is not in the buffer is a `404`.

The `traces` guard covers the trace's log lines: restrict `logs` and `traces` together.

## `GET /api/traces/stream`

Endpoint `traces`. A server-sent event stream: one `trace` event per finished root span, with the trace id as the event id and a `TraceSummary` as data.

```
id: 4bf92f3577b34da6a3ce929d0e0e4736
event: trace
data: {"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","rootName":"GET /orders", ...}
```

- Access is checked when the stream opens. The server closes a stream after 15 minutes (`TRACE_STREAM_MAX_MS`); `EventSource` reconnects, and the access check runs again.
- At most 16 streams (`MAX_TRACE_STREAMS`) are open at once. A further one is answered `503` with the code `studio.trace_streams`.
- A `: ping` comment is sent every 15 seconds, so proxies keep the connection open.
- A client that does not read fast enough misses events; the next event it can take is sent.
- A refused stream is answered `406` to an `EventSource`, which accepts only `text/event-stream`. The refusal itself is seen with `Accept: application/json`.

Studio's own requests are never streamed.

## `GET /api/logs`

Endpoint `logs`. Buffered log lines, newest first, as `StudioPage<StudioLogLine>`. Lines are buffered only when the app routes logs to `StudioLogTarget`; see [Logs](01-overview.md#logs).

| Parameter | Value |
| --- | --- |
| `traceId` | 32 lower-case hex digits: only lines of this trace. |
| `level` | A log level name (`trace` to `security`): this level and above. |
| `limit` | 1 to 1000; default 200. |

## DI graph

Endpoint `di`. Both routes describe the root DI container (`DI.RootContainer.describe()`), merged with the service entries of the loaded manifest. Registrations made in a child container, such as an authz domain or a child-scope app, are not in the graph.

`source` says what the answer is built from: `runtime` when no manifest is loaded, `merged` when one is.

### `GET /api/di/graph`

Answers a `StudioGraph`.

| Parameter | Value |
| --- | --- |
| `package` | Only the nodes of this package. Packages are known from the manifest, so without a manifest no node matches. |
| `focus` | A node id (`svc:Orders`) or a bare DI key (`Orders`). Only the nodes within `depth` hops of it, nearest first. An unknown focus is a `404`. |
| `depth` | 0 to 10; default 1. Only together with `focus`, otherwise a `400`. |
| `limit` | 1 to 5000; default 500. |

Nodes:

| `kind` | Id | Node |
| --- | --- | --- |
| `service` | `svc:<class>` | A class. |
| `token` | `tok:<key>` | A key other than the class's own name: an abstract class or a string token. `registered: false` marks a key that is injected but has no registration. |
| `value` | `val:<key>` | A value registration. Only its key is shown, never the value. |
| `factory` | `fac:<key>:<index>` | A factory registration, labelled with the function name. |

Edges go from the class that injects or implements to its target. `implements` links a class to a key it is registered as. `ctor`, `property` and `lazy` are injections (a property or lazy edge is labelled with the property name). `imperative` is a `DI.resolve()` call inside a method, labelled `<method>()`; only the manifest knows these.

Node attributes:

- `instantiated`: an instance sits in the root container's cache. A class that only the manifest lists is `false`.
- `unknownToManifest`: the runtime has the node and the loaded manifest does not.
- `error`: the runtime could not read the class's injections (a property nothing types). The class is listed without its runtime injection edges.
- `lifetime`, `async`, `bootstrapper`, `manifestId`, `resolving`.

`truncated` is `true` when `limit` cut nodes. Names, ids and paths longer than 2 KiB are cut.

### `GET /api/di/services/:id`

Answers a `DiServiceDetail` for one DI key. `id` is a node id or a bare key; a key that neither the runtime nor the manifest knows is a `404`. A `svc:` id names a class: the answer lists every class of that name, also when it is registered only under other keys, and never the key of the same name. A bare key answers that key, or the class of that name when no such key exists. The answer holds:

- `implementations`: each registered implementation with its lifetime, whether it is instantiated, and its injections. When the runtime could not read a class's injections (`error`), they come from its manifest entry.
- `injectedBy`: the classes that inject this key, with the kind of injection.
- `manifest`: the manifest's service entries for this key, and `sourceRef`, where the first one is registered.
- `runtime.resolving`: a resolution of this key is in flight.

The DI routes show class names, DI keys, lifetimes, package names and source file paths. They never show a registered value, a configuration value or an instance's state.

## Routes

Endpoint `routes`.

### `GET /api/routes`

Answers a `StudioRoutes`: `data` holds one `RouteInfo` per route the router serves, in router order, with Studio's own routes left out. `source` is `runtime`, or `merged` when a manifest is loaded. `total` is the number of routes.

| Parameter | Value |
| --- | --- |
| `limit` | 1 to 5000; default 5000. |
| `cursor` | The `cursor` of the previous page. |

Without `limit` and `cursor` the answer holds every route, up to 5000.

Each `RouteInfo` holds:

- `method`: the HTTP verb the route answers; a `file` route answers `GET`.
- `path`: the mounted path, the global prefix included, with its parameters as declared (`/orders/:id`).
- `controller`, `action`: the controller class and its handler method.
- `policies`, `controllerPolicies`: the `@Policy` groups of the route and of its class, as policy names, one array per group. `@Access` adds the group `['AccessPolicy']`. A policy named by a configuration key shows that key.
- `access`, `controllerAccess`: the `@Access` permissions of the route and of its class.
- `allowAnonymous`: the route or its class carries `@AllowAnonymous` or `@Public(reason)`. It is open on purpose.
- `unguarded`: nothing guards the route: no policy, no `@Access`, and it is not open on purpose. `authz.http.unguardedRoutes` reports the same routes, and also those open only through `@Public`.
- `source`: with a manifest, where the route is declared (`file`, `line`, `col`, `package`).
- `stats`: `count`, `errorRate`, `p50Ms` and `p95Ms`, from the trace buffer. Absent when the buffer holds no request of the route.
- `telemetry`: `count` (responses) and `errorRate`, when `@spinajs/telemetry` is installed with its route stats on.

`stats` is computed from the SERVER spans in the trace buffer, keyed by the HTTP method and `http.route`, the route template. Two requests to `/orders/7` and `/orders/8` count for `/orders/:id`. A request no route matched carries no `http.route` and is not counted. Neither is a `HEAD` request to a `GET` route: Express answers it, but the span records `HEAD`, and no route in the list is keyed `HEAD`. A request whose trace had already filled `studio.buffers.spansPerTrace` is counted all the same. The samples are the buffered spans and nothing else: Studio keeps no latency store of its own, so the numbers cover the requests the buffer still holds (`studio.buffers.traces` traces, `studio.buffers.traceBytes` bytes), across all routes together, sampled requests only. `errorRate` is the share of spans with an error status: a `5xx` answer or a closed connection. The percentiles are nearest-rank over those samples. Studio computes them in one pass over the buffer, and keeps the result until the buffer or the mounted routes change, with one entry per mounted route. With tracing off, or a sampler that records nothing, the buffer stays empty and never changes: no route has `stats`, and every call reuses the one empty result.

The routes route shows paths, controller and method names, policy names, permissions and source file locations. It never shows a policy's options, a `@Public` reason, a request, or a principal. Every name is cut at 2 KiB.

## Authz model

Endpoint `authz`. Studio reads the authz domains the app created; it never boots a domain. A domain is booted once something resolved its `AuthzService`, usually the first check in it.

### `GET /api/authz/domains`

Answers a `StudioPage<StudioAuthzDomain>`, in creation order, root first, with `total`, the number of domains.

| Parameter | Value |
| --- | --- |
| `limit` | 1 to 1000; default 1000. |
| `cursor` | The `cursor` of the previous page. |

Without `limit` and `cursor` the page holds every domain, up to 1000.

Each domain holds:

- `parent`: the domain it was created under; absent for root.
- `models`: the names of the domain's models. Filled only for a booted domain, empty otherwise.
- `algorithm`, `typeAlgorithms`: the combining algorithm of `authz.combine.default`, and the one per resource type.
- `permissions`: the permissions the domain's own configuration declares, with `description` and `types`.
- `error`: the domain's configuration cannot be read. The domain is listed with this message and nothing else.

### `GET /api/authz/roles`

Answers the RBAC role graph of a domain as a `StudioGraph` with `source: 'runtime'`. The graph is empty when the domain is not booted or has no RBAC model.

| Parameter | Value |
| --- | --- |
| `domain` | A domain name; default `root`. An unknown domain is a `400`. |
| `focus` | A node id (`role:editor`, `perm:order:read`). Only the nodes within `depth` hops of it, nearest first. An unknown focus is a `404`. |
| `depth` | 0 to 10; default 1. Only together with `focus`, otherwise a `400`. |
| `limit` | 1 to 5000; default 500. |

Nodes are `role` (`role:<name>`, grouped by its ladder, with `assignable` and `deny`) and `permission` (`perm:<name>`). Edges go from a role: `grants` to a permission it grants, `inherits` to a role it extends, and `ladder` to the role right below it on its ladder, labelled with the ladder name.

The domains and roles routes show domain, model, role and permission names, the inheritance between roles, permission descriptions and resource types. They never show an assignment, a principal, a grant's resource pattern, fields or relation, an RBAC rule, or a condition.

### `GET /api/authz/access-map`

Answers which permissions the mounted routes (Studio's own left out) require and which RBAC roles of a domain grant them, as a `StudioGraph` with `source: 'runtime'`.

| Parameter | Value |
| --- | --- |
| `domain` | A domain name; default `root`. An unknown domain is a `400`. |
| `limit` | 1 to 5000 nodes; default 5000. |

Nodes are `route` (`route:<METHOD> <path>`, grouped by controller, with `unguarded`, `allowAnonymous` and `action`), `permission` (`perm:<name>`) and `role` (`role:<name>`, as in the roles graph). Edges: `requires` from a route to each permission of its own `@Access` and of its class's; `grants` from a role to a required permission it grants. A role that grants no required permission is not in the map. The roles come from the domain's booted RBAC model; without one the map has no roles. The map is built one route at a time, in router order: the route, its permissions, then the roles granting a permission no earlier route required. A cut, at `limit` nodes or at 20 000 edges, therefore drops whole routes from the end and keeps the roles of the routes shown; the map is then `truncated`.

The access map shows what the routes route and the roles graph show, joined: route paths, permission and role names. It never shows an assignment or a principal.

## ReBAC

Endpoint `authz`. These routes read the ReBAC model (`@spinajs/authz-rebac`) of a booted domain: its compiled namespaces and its tuple store. Each takes `domain` (a domain name, default `root`; an unknown one is a `400`) and answers `404` when the domain is not booted or has no ReBAC model. The `rebac` feature is true when a booted domain has one.

### `GET /api/authz/namespaces`

Answers the schema as a `StudioGraph` with `source: 'runtime'`. `limit` is 1 to 5000, default 500; past it the graph is `truncated`.

Nodes are `namespace` (`ns:<type>`), `relation` and `permission` (`rel:<type>#<name>`, grouped by type). Edges: `has` from a namespace to its relations and permissions; `subject` from a relation to a namespace it admits as a direct subject; `subject-set` from a relation to a subject set it admits (`group#member`); `computed` from a permission to the relation or permission its rewrite names; `tupleset` from a permission to the relation a tuple-to-userset follows, labelled `-><computed>`.

### `GET /api/authz/tuples`

Answers a `StudioPage<StudioTuple>` in the store's order, with `total`, the number of matching tuples.

| Parameter | Value |
| --- | --- |
| `object` | `type` (the whole namespace) or `type:id`. |
| `relation` | A relation name. |
| `subject` | `type:id`, or `type:id#relation` for a subject set; matched exactly. |
| `limit` | 1 to 500; default 50. |
| `cursor` | The `cursor` of the previous page; opaque. |

### `GET /api/authz/relations/graph`

Walks the stored tuples breadth-first from `focus`, in both directions, and answers a `StudioGraph` with `source: 'runtime'`.

| Parameter | Value |
| --- | --- |
| `focus` | Required. `type:id`, or `type:id#relation` for a userset. Anything else is a `400`. |
| `depth` | 0 to 10; default 2. |
| `limit` | 1 to 5000 nodes; default 500. |

Node ids are in the focus syntax: `object` nodes (`document:42`) and `userset` nodes (`group:eng#member`), grouped by type. An edge's `kind` and `label` are the relation name, from the object holding the tuple to its subject. An object reads every relation of its namespace and the tuples that name it as a direct subject; a userset reads its one relation. Each read is one store call; the walk stops at `limit` nodes, at 20 000 edges or after 2000 store calls, and the graph is then `truncated`. The edge cap bounds the reply on dense tuples, where every store call can link up to `limit` nodes that are already in the graph.

The ReBAC routes show namespace, relation and permission names and rewrites, and each tuple's object, relation and subject: principal ids, object ids and subject sets. That is data about principals: whoever holds the `authz` endpoint's permission (`studio:read` by default) reads it. Nothing else a store keeps beside a tuple (who wrote it, when) is sent, and neither is the permission map or the check limits. Every id and name is cut at 2 KiB.

## Explain

Endpoint `explain`. Not registered in production unless `studio.allowExplainInProduction: true`; see [Explain in production](01-overview.md#explain-in-production).

### `POST /api/authz/explain`

Explains a decision under the current state: the domain's `AuthzService.explain()` runs the same engine as a real check, evaluates every model, bypasses the decision cache and attaches the trace. It may boot the domain.

The body is a `StudioExplainInput`; any other key is a `400`:

| Key | Value |
| --- | --- |
| `principal` | Required. `<type>:<id>`, at most 256 characters. |
| `permission` | Required. `<resource>:<action>`, at most 256 characters. |
| `resource` | `<type>[:<id>]`, at most 256 characters; default the permission's resource type. |
| `domain` | A domain name; default `root`. |

The answer is a `StudioExplainResult`:

- `decision`: a `StudioDecision`, the engine's `Decision` without its trace and with `validUntil` as an ISO string;
- `trace`: the trace, sent once, beside the decision;
- `denies`: the deny reasons of every vote, once each, lowest priority first (the first one decides).

Every string in the answer is cut at 2 KiB.

What a caller learns about the principal it names: whether it holds the permission on the resource, the condition left on the decision (`residual`), the fields it may read and write, its effective role per ladder on that resource, and each model's vote with its conditions and deny reasons. Not its other grants, its assignments elsewhere, or its attributes: the explained principal carries none.

The route needs both `studio:explain` (the slot `studio.auth.policies.explain`) and `authz:explain` (`authz.http.explainRoute.permission`, checked in `authz.http.access.domain`). It is rate-limited like `GET /authz/explain`, by `authz.http.rateLimit.explain`: 30 requests a minute per principal by default, counted for this route alone.

Each call records an `explain` entry through the domain's `DecisionAudit`, naming the caller, with the reason `studio explain for <type>:<id>` and the trace. The engine records its own `explain` entry naming the principal asked about, and, when `authz.audit.denials` is on and the answer is a denial, a `deny` entry naming it as well.

| Status | When |
| --- | --- |
| `400` | A missing body, an unknown key, a value outside its limits, a `principal` without an id, or an unknown domain. A value that fails the schema is not echoed; an unknown domain name, which matched the name pattern, is. |
| `401` | No authenticated caller. |
| `403` | The caller lacks `studio:explain` or `authz:explain`. |
| `404` | Production without `studio.allowExplainInProduction`. |
| `500` | A `permission` the domain does not register, or a `resource` type outside the permission's types. Authz refuses both as configuration errors, as for `GET /authz/explain`; outside production the error detail names the value. |
| `429` | The rate limit is spent. |

## Typed calls

```ts sample
import type { StudioPage, TraceDetail, TraceSummary } from '@spinajs/studio/contracts';

export async function failedTraces(base: string): Promise<TraceDetail[]> {
  const res = await fetch(`${base}/_studio/api/traces?status=error&limit=20`, { credentials: 'include' });
  const page = (await res.json()) as StudioPage<TraceSummary>;
  const details: TraceDetail[] = [];
  for (const summary of page.items) {
    const detail = await fetch(`${base}/_studio/api/traces/${summary.traceId}`, { credentials: 'include' });
    details.push((await detail.json()) as TraceDetail);
  }
  return details;
}
```

## Related

- [Overview](01-overview.md): enabling Studio, permissions, traces and logs.
- [Configuration](02-configuration.md): every `studio.*` key.
