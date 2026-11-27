# Writing a model

A model is a class that extends `AuthorizationModel` and votes on checks. RBAC and ABAC ship as models; write your own for a rule that neither expresses well, such as "suspended accounts may do nothing". The engine calls the model, combines its vote with the others and keeps its answer correct and safe to cache, as long as the model follows the rules on this page.

## How it works

1. **Register and list.** The app registers the model as `AuthorizationModel` and names it in a `models` list before the domain boots ([Registration](#registration)).
2. **Init.** At boot the host calls `init(ctx)` once per model instance, in the first domain that lists it. The model registers its permissions, native filters and relations there. `ctx.container` is that domain's container: the model resolves what it needs (condition functions, `Configuration`, connections) there, not in root DI.
3. **Route.** For each registered `(permission, type)` the host asks `applies(permission, type)`; the model joins the route only when it answers `true` and `capabilities.resourceTypes` allows the type. It is called again when `version()` changes.
4. **Evaluate.** For a check, the engine calls `evaluate(req, ctx)` with the request and an `EvaluationContext`, within `authz.engine.modelTimeoutMs`. The model returns a `Vote`, or a promise of one.
5. **Lists.** For a `list: true` permission, the engine calls `listSupport(permission, type)` at boot (rule 12) and `listPlan(req, ctx)` for each access plan.
6. **Summaries.** `summary()` and `covers()` call `summarize(principal, at, ctx)`.
7. **Changes.** `invalidate(tags)` receives the tags of every published change; a new `version()` value recompiles the routes and drops the domain's L2.
8. **Dispose.** The host calls `dispose()` once the last domain that lists the model is disposed, and only if its `init` ran.

## The contract

| Member | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique within a domain; `authz.combine` lists models by it, and `ctx.config()` reads `authz.<name>.*`. |
| `capabilities` | yes | What the model promises; see below. |
| `init(ctx)` | yes | Boot-time registrations. |
| `applies(permission, type)` | yes | Static routing: may this model have an opinion on the pair? |
| `evaluate(req, ctx)` | yes | The vote. |
| `preload(principal, ctx)` | no | Load the principal's data before checks. Needed for `sync: 'after-preload'`. |
| `summarize(principal, at, ctx)` | no | The roles and permissions the principal holds at `at`. Without it `covers()` is always false in a domain that routes the model. |
| `listSupport(permission, type)` | no | `true`, or `{ reason }` when the model cannot plan the list. Absent: it cannot. |
| `listPlan(req, ctx)` | no | The model's list plan; called only when `listSupport` answered `true`. |
| `listPlanCacheable(permission, type)` | no | `true` when every list plan of the pair may be kept beyond its request ([Plans a cache may keep](#plans-a-cache-may-keep)). Absent: none may. |
| `invalidate(tags)` | no | Drop the model's own caches for these change tags. |
| `version()` | no | A string that changes when the model's data changes (a config hash). Part of every cache key. |
| `dispose()` | no | Release resources. |

### Capabilities

`capabilities` is a promise; the engine and the boot checks rely on it.

| Field | Type | Meaning |
| --- | --- | --- |
| `effects` | `('permit' \| 'deny')[]` | The vote kinds the model casts. |
| `residuals` | `FilterOp[]` | Every non-structural filter op a vote may hold (`cmp`, `relation`, `under`, `native:*`). An op left out fails boot or is refused at run time. |
| `sync` | `'always' \| 'after-preload' \| 'never'` | Whether `filterNow` may call the model synchronously; `after-preload` needs `preload` to have run for the principal. |
| `fields` | `boolean` | Votes carry `fields`. |
| `needsSubject` | `boolean` | Some answers need the row and cannot be residualised. |
| `principalTypes` | `PrincipalType[]` | Only these principal types are evaluated; the engine skips the model for others. |
| `resourceTypes` | `ResourceType[] \| '*'` | Only these types are routed to the model. Absent or `'*'`: all. |

### The vote

| Field | Meaning |
| --- | --- |
| `model` | The model's name. |
| `permitWhen` | When the model permits: `TRUE`, `FALSE` or a residual filter. |
| `denyWhen` | When the model denies. |
| `denies` | One `{ when, reason }` per deny source. The reason with the lowest `priority`, then `sortKey`, is reported. |
| `reason` | Reported when the vote does not permit and no `denies` entry holds. |
| `roles` | Effective roles, merged into `decision.roles`. |
| `fields` | `{ read?, write?, hide? }` field globs of the permit. |
| `validUntil` | Caps the life of a cached decision: set it for every expiring grant. |
| `cacheable` | `false` when the vote depends on anything the cache key does not hold. |
| `trace` | Steps shown by `explain()`. |

Build filters with the exported helpers: `TRUE`, `FALSE`, `and(...)`, `or(...)`, `not(f)`, `simplify(f)`. Ops: `true`, `false`, `and`, `or`, `not`, `cmp` (a field comparison), `relation` (settled by a `RelationResolver`), `under` (the row lies under one of these scopes) and `native:<name>`.

### The evaluation context

| Member | Use |
| --- | --- |
| `domain`, `now`, `permissions` | The domain, the check's instant, the registry. |
| `ancestors(ref)`, `attributes(ref)` | Ancestors and scope attributes of any node, memoised per request. |
| `conditions` | The domain's `ConditionCompiler` ([Conditions](07-conditions.md)). |
| `relation(type, name)` | The `RelationResolver` of a relation. |
| `check(req)` | A nested check; its tags flow into the outer decision's cache entry. |
| `cache` | A per-request, per-model, per-principal `Map` for memos; a value rests on the nested checks its decision made. |
| `trace(step)` | Adds a step to an `explain()` trace. |

## Registration

- **Register:** under the base class, `@Injectable(AuthorizationModel)` on the class or `DI.register(MyModel).as(AuthorizationModel)` in root; `container.register(...).as(AuthorizationModel)` on a child domain's container for a model only that domain and its children see, never a decorator (DI-2). Register a factory when each domain needs its own instance: it is called with the domain's container on every resolve, so each domain that lists it gets one. The factory must have a name: a named arrow (`const SuspensionFactory = (c: IContainer) => ...`) or `Object.defineProperty(factory, 'name', { value: 'SuspensionFactory' })`.
- **Activate:** list the class name, or the factory's function name, in `authz.models` or `authz.domains.<name>.models` before the domain's first `service()` ([Models by name](05-domains.md#models-by-name)). A registered model that no level lists is inactive.
- Routing: when `authz.combine` lists models, add the model's `name` property there (`'suspension'`, not `'SuspensionModel'`); otherwise the default entry routes every model of the domain.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthorizationModel` | `AuthorizationModel`, the registrations a `models` list names | none in the core | `RbacModel` ([authz-rbac](../authz-rbac/README.md)), `AbacModel` ([authz-abac](../authz-abac/README.md)) | Register your class; see above. A model in a child domain with the name of an ancestor's model replaces it there. |
| `Combinator` | `Combinator`, every registration of the container chain | the three built-ins | your own | See [Custom combining algorithm](#custom-combining-algorithm). |
| `NativeFilter` | `NativeFilter`, every registration, or `ctx.registerNativeFilter()` in `init` | none | your own | A filter op `native:<name>` the core cannot express; `matches(args, subject, ref, ctx)` decides it on a row. Adapters that render lists must list the op in `compiles`. |

### `AuthorizationModel`: custom implementation

A model that denies everything to suspended user accounts. It also plans lists and gives an empty summary, so `list: true` permissions and `covers()` keep working with it routed.

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { AuthorizationModel, FALSE, TRUE } from '@spinajs/authz';
import type { DecisionRequest, ListPlanRequest, ListSupport, ModelCapabilities, ModelListPlan, ModelSummary, PermissionDef, Principal, ResourceType, Vote } from '@spinajs/authz';

const SUSPENDED = { code: 'account_suspended', priority: 100 };

// principal.attributes is part of the decision cache key, so votes built from it are cacheable.
const isSuspended = (p: Principal): boolean => p.attributes.suspended === true;

@Singleton()
@Injectable(AuthorizationModel)
export class SuspensionModel extends AuthorizationModel {
  readonly name = 'suspension';
  readonly capabilities: ModelCapabilities = { effects: ['deny'], residuals: [], sync: 'always', fields: false, needsSubject: false, principalTypes: ['user'] };

  init(): void {}

  applies(_permission: PermissionDef, _type: ResourceType): boolean {
    return true;
  }

  evaluate(req: DecisionRequest): Vote {
    const suspended = isSuspended(req.principal);
    return {
      model: this.name,
      permitWhen: FALSE,
      denyWhen: suspended ? TRUE : FALSE,
      denies: suspended ? [{ when: TRUE, reason: SUSPENDED }] : [],
      cacheable: true,
    };
  }

  listSupport(): ListSupport {
    return true;
  }

  async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
    return isSuspended(req.principal) ? { kind: 'deny-all', reason: SUSPENDED } : { kind: 'abstain' };
  }

  async summarize(): Promise<ModelSummary> {
    return { model: this.name, permissions: [] };
  }
}
```

Activate it with `authz.models: ['SuspensionModel']`. With `authz.combine.default.models` set, add `'suspension'` to it.

### List plans

`listPlan(req, ctx)` answers before the query, without reading rows. `req` holds the principal, the actor, the `PermissionDef`, the type, the request `env` and `fresh`.

| Answer | Meaning |
| --- | --- |
| `{ kind: 'abstain' }` | The model has no opinion on this list. |
| `{ kind: 'all', deny?, validUntil? }` | Every row is permitted, minus the `deny` terms. |
| `{ kind: 'deny-all', reason }` | No row; the plan becomes `none` with this reason. |
| `{ kind: 'terms', permit, deny, validUntil? }` | Rows matching a `permit` term and no `deny` term. A `PlanTerm` is `{ op, args }`; the list adapter compiles it by `op`. |

Plans combine under `deny-overrides`: any `deny-all` wins; no `all` and no permit term gives `none` with `no_access` (H16). A failure, a timeout or a malformed plan becomes `deny-all` with `model_error`. A model that grants a `list: true` permission only by reading the row must not claim `listSupport`: rule 12 then refuses the permission at boot, so a list and a check of each of its rows always agree.

### Custom combining algorithm

A `Combinator` merges the votes of one route. `combine(votes)` must be synchronous and return `{ allow, deciding? }`.

```ts sample
import { DI } from '@spinajs/di';
import { Combinator, FALSE, and, normalizeVote, not, simplify } from '@spinajs/authz';
import type { ResourceFilter, Vote } from '@spinajs/authz';

/** Allows only when every routed model permits and none denies; for payouts. */
export class Unanimous extends Combinator {
  readonly name = 'unanimous';

  combine(votes: readonly Vote[]): { allow: ResourceFilter } {
    if (votes.length === 0) return { allow: FALSE };
    return { allow: simplify(and(...votes.map(normalizeVote).map((v) => and(v.permitWhen, not(v.denyWhen))))) };
  }
}

DI.register(Unanimous).as(Combinator);
```

Route it with `authz: { combine: { types: { payout: { algorithm: 'unanimous', models: ['rbac', 'abac'] } } } }`. A custom algorithm cannot route a `list: true` permission (plans combine with `deny-overrides` only), and `covers()` is false for any permission it routes.

## Important behaviour

- **Throw on missing or failed data; never vote "no".** A thrown or timed-out vote is indeterminate (`model_error`): it fails closed and is never cached. A "no" vote looks like a clean answer and gets cached.
- **Memoise the promise of a load in `ctx.cache`, or memoise nothing.** A placeholder written before the load settles is read by a concurrent check as a clean answer.
- **A memoised `ctx.check()` answer keeps what it rested on.** Each `ctx.cache` value carries the tags and the earliest `validUntil` of the nested checks its decision made, preload included. A decision that reads the value rests on them as if it had made the check, and the value is gone once that `validUntil` has passed: the next read misses and the check runs again. A value whose decision made no nested check is kept as it was. Every member that returns values counts as a read, `size` and iteration included, so iterate the memo only when the decision rests on all of it. A value carries `cacheable: false` and unknown tags of those nested checks too: a decision that reads it is then not cached, or not in the L2. The bound belongs to the `ctx.cache` entry, not to what is inside it. A `ctx.check()` answer put into a value an earlier decision stored (a `Map`, an object or an array under one key), or kept anywhere outside `ctx.cache` (a field of the model, a closure), is not seen: a decision that reads it is cached as if it rested on nothing, and stays allowed after the nested grant ends or is revoked. Store each nested answer under a key of its own: ``ctx.cache.set(`check:${grantee.id}`, ctx.check(...))``, never `answers.set(grantee.id, ...)`. Each context gets its own view of the memo, so two decisions of a request share the entries, not the `Map` object. Read the memo through its methods; `structuredClone` and `util.inspect` see the view's own, empty storage.
- **Key every cache on everything the answer depends on**: principal state, permission, resource, scope, version. A missing part leaks one answer into another request.
- **Never derive a cacheable vote from `principal.identity` or `env`**; the cache key holds neither. Set `cacheable: false` on such a vote.
- **Report reasons with priorities.** One `denies[]` entry per deny source, each with `reason.priority` (lower wins) and, for ties, `sortKey`.
- **Declare honest capabilities.** A residual op left out of `residuals` is refused; a `sync: 'always'` model that does IO breaks `filterNow`.
- **`init` registers, nothing else.** A model that calls `ctx.registerPermissions()` after `init` returned gets `AuthzConfigError`.

## Plans a cache may keep

`accessPlan` makes a plan for one request. A cache that keeps the rows a plan filtered, per principal, may do so only
when the plan carries `cache` (`AccessPlanCache`). The engine sets it when every model that planned says so, the call
passed no `env`, the permission is not `consistency: 'fresh'`, no model failed, and every nested `ctx.check()` the
plans rested on could be cached:

```ts
class MyModel extends AuthorizationModel {
  // true only when every plan of permission on type rests on stored state whose changes this model publishes on the
  // ChangeBus, and on time only through validUntil: never on env, actor or session facts
  listPlanCacheable(permission: PermissionDef, type: ResourceType): boolean {
    return true;
  }
}
```

`plan.cache` holds a key (the domain, the principal's whole state, the permission, the type, the models' `version()`
values and the store generation a consistency token named), the tags of a type-level
decision of the principal (`*`, `model:<name>` of the planning models, `subject:` of the principal, its companions and
its delegation chain, `scope:*`, plus the tags of nested checks and loaded scope nodes) and a TTL:
`authz.cache.ttlSeconds`, capped by `validUntil` and by the `validUntil` of every nested check the plans rested on. A
model without the method keeps nothing, and a method that throws
counts as no. `@spinajs/authz-abac` does not implement it, because its plans are decided with the request's env. A
cache outside authz turns these tags into its own through the `AuthzCacheTags` port (`render(domain, tags)`, undefined
when the domain's changes do not reach that cache); `@spinajs/authz` registers no implementation, so without one
nothing is cached.

- **Answer `true` only for state you announce.** A plan kept for a principal is dropped only by a change that bumps one
  of its tags, or by its TTL. A plan that rests on anything else (the env, the time of day, a table no change names)
  would keep showing rows after access was revoked.
- **Any scope change drops every kept plan of the domain.** A plan's tags always hold `scope:*`, and a change that names
  a `scope:<type:id>` drops `scope:*` too, as it drops every type-level decision: correct, but coarse.
- **A `none` plan is kept without the expiry of the deny that made it**: the principal sees no rows until the TTL ends,
  even when the deny expired earlier.

## Best practices

- Read your own config section through `ctx.config(path, default)` in `init`: it reads `authz.<name>.<path>`.
- Return `validUntil` for every grant that expires, so cached decisions die with it.
- Test with `runModelConformance()` and the behaviour fixtures of [`@spinajs/authz-testing`](../authz-testing/README.md).

## Related

- [How a check works](01-check-flow.md): where `evaluate` sits in the flow.
- [Conditions](07-conditions.md): compile conditions inside a model.
- [Resource adapters and resolvers](09-adapters-and-resolvers.md): relations and scope attributes a model reads.
- [`@spinajs/authz-testing`](../authz-testing/README.md): conformance suites for models.
