# Writing a model

A model is a class that extends `AuthorizationModel` and votes on checks. RBAC and ABAC ship as models; write your own for a rule that neither expresses well, such as "suspended accounts may do nothing". The engine calls the model, combines its vote with the others and keeps its answer correct and safe to cache, as long as the model follows the rules on this page.

## How it works

1. **Register.** The app registers the model as `AuthorizationModel` before the domain boots ([Registration](#registration)).
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
| `cache` | A per-request, per-model, per-principal `Map` for memos. |
| `trace(step)` | Adds a step to an `explain()` trace. |

## Registration

- Root domain: `@Singleton()` and `@Injectable(AuthorizationModel)` on the class, or `DI.register(MyModel).as(AuthorizationModel)`.
- Child domain: `container.register(MyModel).as(AuthorizationModel)` on the domain's container, never a decorator (DI-2), before the domain's first `service()` ([Domains](05-domains.md)).
- Routing: when `authz.combine` lists models, add the new name there; otherwise the default entry routes every model of the domain.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `AuthorizationModel` | `AuthorizationModel`, every registration of the container chain | none in the core | `RbacModel` ([authz-rbac](../authz-rbac/README.md)), `AbacModel` ([authz-abac](../authz-abac/README.md)) | Register your class; see above. A model in a child domain with the name of an ancestor's model replaces it there. |
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

With `authz.combine.default.models` set, add `'suspension'` to it.

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
- **Key every cache on everything the answer depends on**: principal state, permission, resource, scope, version. A missing part leaks one answer into another request.
- **Never derive a cacheable vote from `principal.identity` or `env`**; the cache key holds neither. Set `cacheable: false` on such a vote.
- **Report reasons with priorities.** One `denies[]` entry per deny source, each with `reason.priority` (lower wins) and, for ties, `sortKey`.
- **Declare honest capabilities.** A residual op left out of `residuals` is refused; a `sync: 'always'` model that does IO breaks `filterNow`.
- **`init` registers, nothing else.** A model that calls `ctx.registerPermissions()` after `init` returned gets `AuthzConfigError`.

## Best practices

- Read your own config section through `ctx.config(path, default)` in `init`: it reads `authz.<name>.<path>`.
- Return `validUntil` for every grant that expires, so cached decisions die with it.
- Test with `runModelConformance()` and the behaviour fixtures of [`@spinajs/authz-testing`](../authz-testing/README.md).

## Related

- [How a check works](01-check-flow.md): where `evaluate` sits in the flow.
- [Conditions](07-conditions.md): compile conditions inside a model.
- [Resource adapters and resolvers](09-adapters-and-resolvers.md): relations and scope attributes a model reads.
- [`@spinajs/authz-testing`](../authz-testing/README.md): conformance suites for models.
