# Resource access without query rewriting: implementation plan (overview)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each lane file in this folder is executed by one agent; this overview is required reading for every lane.

**Goal:** Replace query-rewriting authorization (`@spinajs/authz-orm` middleware and the residual SQL compilers) with check-before-access for single objects, one explicit list helper over a closure table, materialized team membership, deny roles, wildcard subjects and a universal client access API.

**Architecture:** The engine, models, `@Access` and `AuthzAdmin` stay. Models gain an optional `listPlan` that describes a list filter as opaque terms; `@spinajs/authz-orm` turns those terms into one fixed `EXISTS` shape through registered `PlanTermSql` compilers, and keeps `authz_resource_ancestor` right with a write-only query middleware. Team membership is a closure table maintained by `AuthzAdmin`. Clients use `POST /user/access/checks`, per-row `$access`, change push and `X-Access-Epoch`.

**Tech Stack:** TypeScript 5/7 (node16 modules, ESM + CJS builds), `@spinajs/di`, `@spinajs/orm` (SQLite, PostgreSQL, MySQL, MSSQL drivers), mocha 10 + ts-mocha + chai 4 + sinon + fast-check, socket.io (http-socket).

**Design (source of truth):** `docs/plans/2026-10-14-authz-resource-access-design.md` (cited as *design §n*). Where this plan and the design differ, this plan's "Decisions made while planning" (below) wins; it records each deviation.

---

## Global Constraints

- All code, comments, docs, identifiers and commit messages in English.
- Comments only where a competent reader would ask "why?": no restating code, no history, no multi-paragraph essays (user rule).
- Match the surrounding code: decorators (`@Injectable`, `@Singleton`, `@PerChildInstance`), `Object.freeze` on returned values, `AuthzConfigError` for misconfiguration, `AuthzAdminFailure(code, message)` for refused admin commands.
- Tests: mocha + chai `expect`, files `test/<area>/<name>.test.ts`, helpers without `.test`. Run one package: `cd packages/<pkg> && npm test` (runs `pretest` compile first). One file: `cd packages/<pkg> && npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 30000 test/<path>.test.ts` (mocha 10 adds the `.mocharc.json` spec to files given on the command line, so without `--no-config` the whole suite runs, in `packages/authz` including the slow API snapshot check) (for `packages/authz` add `--config .mocharc.host.json` / `.mocharc.admin.json` for `test/host/**` / `test/admin/**`; compile first with `npm run compile` because host/admin tests import the built `lib`).
- Dependencies of a package build before it: after changing a package that others import, run `npm run compile` in it before running the dependants' tests.
- Frozen API snapshots (`scripts/api-snapshot.json`): any change to `packages/authz/src/contracts/index.ts`, `packages/authz/src/conditions/contracts.ts`, `packages/authz-rbac/src/contracts.ts`, `packages/authz-abac/src/contracts.ts`, `packages/authz-orm/src/api.ts`, `packages/authz-http/src/api.ts`, `packages/authz-queue/src/api.ts`, `packages/authz-fs/src/api.ts`, `packages/authz-testing/src/rebac.ts` needs: `npm run build` (root), `node scripts/api-snapshot.mjs --update`, and an RFC file `docs/plans/authz-v3-rfc/RA<lane>-<n>.md` in the same commit. Module augmentation of a snapshotted package must be listed in `augmentationAllowlist` of `scripts/api-snapshot.json`.
- A new package: copy the scaffold of `packages/authz-abac` (`.eslintignore`, `.eslintrc.cjs`, `.gitignore`, `.mocharc.json`, `.npmignore`, `.prettierrc`, `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `typedoc.json`), add it to root `tsconfig.build.json`, `tsconfig.build.cjs.json` and root `package.json` `dependencies` as `"@spinajs/<x>": "file:packages/<x>"`. Versions: `@spinajs/authz*` `3.0.0-alpha.0`, other `@spinajs/*` `2.0.549`.
- 3.0 is unreleased: migrations are edited in place (design §4.5). No backward-compatibility shims.
- Base branch for execution: `feat/authz-v3` (the commit that adds this plan; it includes the `authz/memory-throttle` merge `fa26d07df`). Work on `authz/resource-access`, one worktree per parallel lane (`superpowers:using-git-worktrees`), merged back lane by lane. The old code is on `archive/authz-orm-query-scoping`.
- Commit after every task with a conventional message: `feat(<pkg>): …`, `refactor(<pkg>): …`, `test(<pkg>): …`, `chore(<pkg>): …`, `docs(<area>): …`.

---

## Decisions made while planning (deviations from the design)

1. **Plans are model-provided and opaque** (refines design §6.2). `AuthorizationModel.listPlan?()` returns terms `{ op, args }`; the engine combines them; `@spinajs/authz-orm` renders each term with the `PlanTermSql` compiler registered for its `op`. authz-rbac registers `rbac.assignment` (it owns `authz_assignment` and `authz_subject_membership`); authz-orm ships `relation.owner` and `relation.self`. So authz-orm never hard-codes RBAC tables, and another model can add list support with its own compiler.
2. **Team keys are resolved before the query.** RBAC reads the principal's sets from `authz_subject_membership` in one indexed query when it builds the plan and passes them in the term's `subjects`. When more than `authz.rbac.maxPlanSubjects` (default 500) keys result, the term carries `membership: true` and the compiler emits the sub-query form of design §6.2 instead. This keeps MSSQL under its 2100-parameter limit.
3. **Single-object batches use a new `AuthzService.checkAll`** (many resources), backed by optional `ResourceAdapter.loadMany` / `ancestorsMany`. The existing `checkMany` (one resource, many permissions) is unchanged.
4. **Push is split into contracts in core, transports in the HTTP packages.** Core defines `ChangeAudience` (who a change affects) and `AccessPushTransport`; a core `AccessChangeRouter` subscribes to the `ChangeBus`, asks the audience, and fans out to every registered transport. authz-rbac implements `ChangeAudience`; authz-http implements SSE (written by hand: `@spinajs/http` has no SSE); http-socket implements the socket transport (room `principal:<principalKey>` joined on connect).
5. **`X-Access-Epoch` needs no session field.** Every flow it must react to (login, role switch, MFA elevation, impersonation start and end) already rotates the session id, which changes `principal.authn.sessionHandle`. The epoch is `sha256(principalKey + sessionHandle + ceilingHash(ceiling))`, first 16 hex characters, set by a `ServerMiddleware` with `Order = 11` (after `PrincipalMiddleware`, order 10). No change to the frozen `ISession` contract.
6. **ORM change:** `QueryMiddleware` gains optional `afterQueryExecution(query, result)` and optional `transactional(query): boolean`. When any middleware answers `true` and `query.Driver.CurrentTransaction` is undefined, the builder runs `before…`, the statement and `after…` inside `driver.transaction()`. This resolves design §12 open question 1.
7. **fs ids from clients** (design §10.7, ckit file manager) are deferred: the ckit file manager has not moved to ckit-access yet. No lane builds it.
8. **List plans see actor and env** (L2 contract issue 1): `ListPlanRequest` carries `actor` and `env`, and `accessPlan` takes an optional `env`, so ABAC principal/actor/env policies stay list-filterable as design §3 promises.
9. **Two intersecting resource ceilings** (agent and delegate both scoped) give `none` with reason `ceiling` (fail closed); `within` stays one OR-list.
10. **Membership maintenance runs in the write handlers** (assignment, link, forget), inside the admin batch transaction, not in `DbAuthzAdminBackend` (L6). New admin codes `set_cycle`, `set_too_deep`.
11. **Runtime guard scope** (design §8): selects constrained to exactly one primary-key value (`@FromModel`, `findOrFail(id)`) are single-object loads and are not flagged; the route's `@Access` check-before covers them. Only multi-row selects need `.accessible()`, `.unscoped()` or SYSTEM.
12. **The end-to-end suite lives in `packages/authz-testing/test/e2e`**, not in authz-orm, to avoid a test-only dependency cycle authz-orm ↔ authz-rbac.
13. **Push is per node.** Each node's router pushes to its own SSE streams and sockets. With several nodes, `authz.bus.service: 'QueueChangeBus'` is required so every node sees every change; with the in-process bus only clients on the writing node are told (documented in L9's README work).
14. **`/user/access/checks` pre-validates entries** (permission registered, type known) and answers `false` for invalid ones before calling `checkAll`, instead of retrying entry by entry after a throw.
15. **RBAC grants with a relation held at a scoped assignment are plannable**: `rbac.assignment` role entries may carry `relation: 'owner' | 'self'`, and the compiler ANDs the assignment branch with the relation column from `SqlRowContext.relation()` (L8 issue 3).
16. **Change pushes from RBAC carry no `objects`** (rbac cannot see the ancestor table), so clients refetch everything on an RBAC change. Accepted limitation.
17. **ABAC refuses more for lists than design §7 says**: also policies that read `scope.*` other than `$global`, and scoped policies (no plan term exists for them). Fail closed; documented in L10.
18. **ORM gains `driver.afterCommit(cb)`** (L1): a callback on the current transaction, run after the outermost commit, dropped on rollback; outside a transaction it runs at once. L3 publishes `AuthzChange` with it instead of patching `OrmDriver.prototype.transaction`.
19. **ORM raw select columns keep their bindings** (L1 bug fix in orm-sql `SqlColumnRawStatement`), so `.withAccess()` binds values instead of inlining them; no orm-sql dependency in authz-orm.
20. **Delete clean-up with the memory admin backend** runs after the ORM commit inside `AuthzAdminBackend.transaction()` (best effort, logged on failure); with `DbAuthzAdminBackend` it runs in the ORM statement's transaction. DB stores bump `authz_version` themselves; the memory backend bumps through its transaction.
21. **authz-orm checks at domain boot** that every `@AccessResource` model with `@Parent` lives on the authz stores' connection (`AuthzConfigError`), since boot rule 12 cannot see model connections.
22. **`SqlRowContext.ancestorTable` arrives quoted**; compilers use it as is. `reparent(model, ids, newParentId)` is an authz-orm export (frozen in its `api.ts`), not an `authz()` method.
23. **Combination for list permissions:** a `list: true` permission must be routed with `deny-overrides` in every domain; boot rule 12 refuses `permit-overrides` and `first-applicable` for it (the plan combination is defined for deny-overrides only).

---

## Lanes and dependencies

```
Wave 1 (start now, parallel)          Wave 2 (after G0 merged, parallel)              Wave 3
┌────────────────────────┐            ┌──────────────────────────────┐
│ L0  contracts + RFC     │──G0──────▶│ L2  engine (core)            │──┐
└────────────────────────┘     │      │ L3  authz-orm core (A1)      │──┼──▶ L5 ──▶ L9 integration
┌────────────────────────┐     │      │ L4  authz-orm lists (A2)     │──┤          + docs
│ L1  ORM middleware hooks│─────┼─────▶│   (L3 needs L1 merged for    │  │
└────────────────────────┘     │      │    task "maintenance")       │  │
┌────────────────────────┐     │      │ L6  rbac storage (B1)        │──┤
│ L7  rbac removal (D1)   │─────┼─────▶│ L8  rbac model (B2)          │──┤
└────────────────────────┘     │      │ L10 abac list plans (C)      │──┤
┌────────────────────────┐     │      │ L11 http client API (H)      │──┤
│ L12 eslint plugin (X)   │     │      │ L13 socket transport (K)     │──┘
└────────────────────────┘     │      └──────────────────────────────┘
                               │      L5 consumers (F) starts when L3 task 1–3 merged
```

| Lane | File | Package(s) | Tasks | Starts | Blocks |
|---|---|---|---|---|---|
| L0 contracts | `L00-contracts.md` | authz (contracts), authz-rbac (contracts.ts) | 5 | now | everything in wave 2 |
| L1 ORM hooks | `L01-orm-hooks.md` | orm, orm-sql | 4 | now | L3 task 5 (maintenance), L4 task 4 (`withAccess` bindings) |
| L7 rbac removal | `L07-rbac-removal.md` | authz-rbac, authz-testing | 5 | now | L6, L8 (merge first to avoid conflicts) |
| L12 eslint plugin | `L12-eslint-plugin.md` | new eslint-plugin-authz | 3 | now | — |
| L2 engine | `L02-engine.md` | authz | 9 | G0 | L9, L11 (checkAll, router) |
| L3 authz-orm core | `L03-authz-orm-core.md` | authz-orm | 10 | G0 (+L1 and L2 task 6 for task 5) | L4, L5 |
| L4 authz-orm lists | `L04-authz-orm-lists.md` | authz-orm | 7 | G0 + L3 task 1 (+L1 for task 4, L2 for task 5) | L9 |
| L6 rbac storage | `L06-rbac-storage.md` | authz-rbac, authz-http-admin (tests) | 7 | G0 + L7 merged | L8 tasks that read membership |
| L8 rbac model | `L08-rbac-model.md` | authz-rbac | 13 | G0 + L7 merged (+L6 for membership tasks) | L9 |
| L10 abac | `L10-abac.md` | authz-abac, authz | 5 | G0 | L9 |
| L11 http | `L11-http-client-api.md` | authz-http | 5 | G0 (+L2 tasks 3, 8) | L9 |
| L13 socket | `L13-socket-transport.md` | http-socket | 3 | G0 (+L2 task 8) | L9 |
| L5 consumers | `L05-consumers.md` | authz-queue, configuration-http, users, users-http, http-socket (tests), queue-http-progress, authz-testing, authz-convert | 13 | L3 tasks 1–3 merged | L9 |
| L9 integration + docs | `L09-integration-docs.md` | authz-testing (e2e), authz-orm, docs | 12 | all others | release |
| L14 teams | `L14-teams.md` | new teams | 11 | all resource-access lanes merged | L15 |
| L15 teams-http | `L15-teams-http.md` | new teams-http | 8 | L14 | — |

Shared-file serialization: `packages/authz/src/contracts/*` is written only by L0. `packages/authz-rbac/src/contracts.ts` only by L0. Root `tsconfig.build*.json` and root `package.json` only by L12 (new package) and L3 (dependency changes); coordinate through rebase. `scripts/api-snapshot.json` (`augmentationAllowlist`) only by L4 and L12.

Each lane file ends with "Contract issues found": a record of what its writer raised. Every item there is resolved by a decision above or accepted as a limitation; the decisions win where they differ. Merging L7 alone breaks list tests in users, configuration-http and authz-queue until L3 and L5 land: merge L7, L3 (tasks 1–3) and L5 together.

Total: 120 tasks (101 in L0–L13, 19 in the teams lanes L14–L15; design `docs/plans/2026-10-14-teams-design.md`).

---

## Frozen contracts (L0 delivers exactly these; every lane codes against them)

### `packages/authz/src/contracts/permission.ts` (add one field)

```ts
export interface PermissionDef {
  // …existing fields unchanged…
  /** Usable with list helpers (`.accessible()`); boot rule 12 checks every model can plan it. */
  readonly list?: boolean;
}
```

Also: `packages/authz/src/engine/registry.ts` `PermissionInput` gains `list?: boolean`; merge rule for duplicates: `list` OR-ed (same as `fields`). AJV schema `packages/authz/src/host/config/schema.ts` `permissions.additionalProperties.properties` gains `list: { type: 'boolean' }`.

### `packages/authz/src/contracts/plan.ts` (new, exported from `contracts/index.ts`)

```ts
import type { Principal } from './principal.js';
import type { ResourceRef, ResourceType } from './principal.js';
import type { PermissionDef } from './permission.js';
import type { DenyReason } from './decision.js';

/** One condition on a row, rendered by the PlanTermSql compiler registered for `op`. */
export interface PlanTerm {
  readonly op: string;
  readonly args: unknown;
}

/** What one model says about a list of `type` for a permission. */
export type ModelListPlan =
  | { readonly kind: 'abstain' }
  | { readonly kind: 'all'; readonly deny?: readonly PlanTerm[]; readonly validUntil?: Date }
  | { readonly kind: 'deny-all'; readonly reason: DenyReason }
  | { readonly kind: 'terms'; readonly permit: readonly PlanTerm[]; readonly deny: readonly PlanTerm[]; readonly validUntil?: Date };

/** The combined plan the engine returns. `permit: 'all'` means no permit filter. */
export type AccessPlan =
  | { readonly kind: 'none'; readonly reason: DenyReason }
  | {
      readonly kind: 'filter';
      readonly permit: 'all' | readonly PlanTerm[];
      readonly deny: readonly PlanTerm[];
      /** Ceiling resources: the row must be one of them or descend from one. */
      readonly within?: readonly ResourceRef[];
      readonly validUntil?: Date;
    };

/** Why a model cannot plan a permission on a type, or true. */
export type ListSupport = true | { readonly reason: string };

export interface ListPlanRequest {
  readonly principal: Principal;
  /** The acting principal under `inherit` delegation, as `DecisionRequest.actor`. */
  readonly actor?: Principal;
  readonly permission: PermissionDef;
  readonly type: ResourceType;
  /** Request env, built like check() builds it (`now` always present). */
  readonly env?: Readonly<Record<string, unknown>>;
}

/** Row context a compiler renders against. `rowId` is SQL yielding the row id as text. */
export interface SqlRowContext {
  readonly type: ResourceType;
  readonly rowId: string;
  readonly rowColumn: (column: string) => string;
  readonly ancestorTable: string;
  /** Columns of the row's `owner`/`self` relation, when the resource declares one. */
  readonly relation: (name: 'owner' | 'self') => { readonly column: string; readonly typeColumn?: string } | undefined;
  readonly now: Date;
  readonly dialect: 'sqlite' | 'postgres' | 'mysql' | 'mssql';
}

export interface SqlFragment {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

/** Renders one PlanTerm op to a boolean SQL expression over the current row. */
export abstract class PlanTermSql {
  abstract readonly op: string;
  abstract toSql(args: unknown, row: SqlRowContext): SqlFragment;
}
```

### `packages/authz/src/contracts/model.ts` (two optional members on `AuthorizationModel`)

```ts
  /** List support for `permission` on `type`; absent means the model cannot plan lists. */
  listSupport?(permission: PermissionDef, type: ResourceType): ListSupport;
  /** The list plan; called only when listSupport answered true. */
  listPlan?(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan>;
```

### `packages/authz/src/contracts/adapter.ts` (two optional members on `ResourceAdapter`)

```ts
  /** Rows by resourceKey; missing keys mean unknown resources. */
  loadMany?(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>>;
  /** Ancestors by resourceKey, each `[self, parent, ..., GLOBAL]`; null = unknown resource. */
  ancestorsMany?(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>>;
```

### `packages/authz/src/contracts/service.ts`

```ts
  // on AuthzService:
  abstract checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]): Promise<readonly Decision[]>;
  abstract accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>): Promise<AccessPlan>;

  // new contracts, same file:
  export interface AccessChangedEvent {
    /** Present only when exact: no changed scope has descendants. Absent means "refetch everything". */
    readonly objects?: readonly ResourceRef[];
  }
  /** Principal keys a change affects, or '*' for every session. */
  export abstract class ChangeAudience {
    abstract audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] }>;
  }
  export abstract class AccessPushTransport {
    abstract readonly name: string;
    abstract push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void>;
  }
```

### `packages/authz/src/contracts/admin.ts`

Add `not_list_filterable`, `set_cycle` and `set_too_deep` to the error-code comment (L47-48). `code` stays `string`. (`rule_not_compilable` stays listed until L7 removes its last use; L7 deletes it from the comment.)

### `packages/authz/src/contracts/decision.ts`

`DEFAULT_DENY_PRIORITY` gains `role_denied: 150` (deny roles are stronger than ceilings and plain no-access). Update the deep-equal in `packages/authz/test/contracts/decision.test.ts`.

### `packages/authz-rbac/src/contracts.ts`

```ts
// RoleDef gains:
  readonly deny?: boolean;

/** Port: the transitive closure of subject sets (design §4.3). */
export abstract class MembershipStore {
  /** Sets every given member key belongs to, live at `at`, each with its membership expiry (none = never). */
  abstract setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]>;
  /** Member keys (principal keys and set keys) of a set, live at `at`. */
  abstract membersOf(setKey: string, at: Date): Promise<readonly string[]>;
}

/** Subject key: `type:id` (principal) or `type:id#role` (set); wildcard `type:*`. In `id`, `%`, `#` and `*` are escaped as `%25`, `%23`, `%2A`, so keys never collide. Max 200 characters; longer keys are refused on write. */
export type SubjectKey = string;
```

### Names other lanes rely on (not snapshotted; owned by the named lane)

| Name | Owner | Shape |
|---|---|---|
| `AUTHZ_RESOURCE_ANCESTOR_TABLE = 'authz_resource_ancestor'` | L3 (`authz-orm/src/ancestors/table.ts`) | columns `resource_type, resource_id, ancestor_type, ancestor_id, depth` |
| `entryOf(model): ResourceEntry \| undefined` | L3 (`authz-orm/src/registry.ts`) | `ResourceEntry = { type: string; parents: readonly { property: string; column: string; type: string }[]; owner?: { property: string; column: string; typeColumn?: string }; self?: { column: string }; idColumn: string }` (without `typeColumn` the owner relation holds only for `user` principals; with it, the row's type column must equal `principal.type`) |
| `registerAccessResource(model, type, opts?: { parents?: { column: string; type: string }[]; owner?: string \| { column: string; typeColumn?: string }; self?: string })`; decorator `Owner(opts?: { typeColumn?: string })` | L3 | — |
| `.unscoped(reason: string)` on select/update/delete builders; config `authz.orm.domain` (default `root`) | L4 / L3 | — |
| `AccessResource(type)`, `Parent(type, opts?: { nullable?: boolean })`, `Owner()`, `Self()` decorators | L3 | — |
| `forgetScopesInTx(container, scopes: readonly ResourceRef[], tx: AuthzTx, ctx: { actor: Principal; reason: string }): Promise<{ tags: string[] }>` | L2 (`authz/src/admin/forget.ts`, exported from `authz/src/index.ts`) | runs every `ScopeForgetter` + attribute store inside an existing transaction |
| `AccessChangeRouter` | L2 (`authz/src/host/push.ts`) | `@Singleton` started by `DefaultAuthzService.boot()` of the root domain |
| `AUTHZ_CHANGED_EVENT = 'authz.changed'` | L2 (`authz/src/host/push.ts`, exported from `@spinajs/authz`) | event name both transports use |
| `subjectKeyOf(subject: AssignmentSubject): string` | L6 (`authz-rbac/src/stores/columns.ts`) | `user:42`, `team:7#member`, `user:*` |
| `AUTHZ_SUBJECT_MEMBERSHIP_TABLE = 'authz_subject_membership'` | L6 | design §4.3 |
| `rbac.assignment` PlanTerm args | L8 | `{ subjects: string[]; membership: boolean; memberKeys: string[]; roles: { role: string; scopeTypes?: string[]; tag?: string; descendantsOnly?: boolean; relation?: 'owner' \| 'self' }[]; global: boolean }` |
| `relation.owner` / `relation.self` PlanTerm args (emitted by L8, compiled by L4 from the registry's columns) | L4 | `{ principals: { type: string; id: string }[] }` |
| `ACCESS_FIELD` default `'$access'`, config `authz.orm.accessField` | L4 | — |

---

## Codebase facts every lane needs (verified 2026-10-14)

- Engine: `packages/authz/src/engine/authorizer.ts` (`class Authorizer`; `check` L412, `checkMany` L422 loops sequentially over permissions for one resource; `pipeline` generator L852-1044; `loadAncestors` L1668-1678 calls `adapter.ancestors` at L1676; `finish()` L1589 sets `allowed = residual.op !== 'false'`). Host: `packages/authz/src/host/service.ts` (`DefaultAuthzService`, boot order: parent registrations L399, config permissions L400-405, adapter permissions L407-410, model permissions L558, `registry.freeze()` L420; `validateBoot` call L448-463; ChangeBus subscribe L343-353, `onChange` L606-621).
- Definite allow is `decision.allowed && decision.residual.op === 'true'` (see `authz-fs/src/guard/shared.ts:37`). `TRUE`/`FALSE` are `{op:'true'}`/`{op:'false'}` in `contracts/filter.ts:32-33`.
- Boot rules: `packages/authz/src/engine/validate.ts`, `type Rule = 1|2|…|10|'models'|'combine'|'routes'` (L44); add with `guard(<rule>, () => checkX(..., add))` (pattern L164-166); lines formatted `[6.5/<n>] …`.
- Admin: `DefaultAuthzAdmin.run()` `packages/authz/src/admin/admin.ts:230-319` (phase A validate + `AuthzCommandValidator` chain L258; phase B `backend.transaction` L273, guard L277, `handler.apply` L278, `bumpVersion` L291); `afterCommit` L338-382 publishes `AuthzChange { domain, tags, actor, at }`. `ScopeForgetHandler` `packages/authz/src/admin/forget.ts:26-71` fans out to `ScopeForgetter`s.
- RBAC: `RbacModel` `packages/authz-rbac/src/model/model.ts:51` (`init` L95-112, `evaluate` L144); pipeline `src/model/evaluate.ts` (`readRbacInput` L469-489, `collect` L181-201, `toVote` L420-436, `DEFAULT_RBAC_EXTENSIONS` L596); subject sets one level deep in `src/model/sets/resolver.ts` (`RbacSubjectResolver` L43-88, `memberships` L70-87) and `src/model/sets/extension.ts`; ceiling roles `src/model/ceiling.ts`. Role schema `src/stores/schema.ts` (role L40-61, `closed()` L16-21); role types `src/contracts.ts` `RoleDef` L36-47; config load `src/stores/config-role-store.ts` (`ROLE_KEYS` L19, `role()` L60-76); role graph `src/model/roles.ts` (`compileRoles` L42-78, `validateRole` L168-178).
- RBAC storage: `DbAssignmentStore` `src/stores/db-assignment-store.ts` (`forSubjects` L62, `whereSubjects` L335-351, `assign` L94-117, `forgetScope` L202-217 also deletes set-subject rows of sets at the scope; the memory store and the docs say it keeps them: L6 fixes the docs to match the DB store); `AUTHZ_ASSIGNMENT_TABLE` is re-exported by `src/stores/assignment-row.ts:6` from `src/orm/rbac-orm-compiler.ts:30` (L7 moves the constant into `src/stores/assignment-row.ts`). Admin handler for sets `src/admin/assignments.ts` (`set.addMember` L124-128 = plain assignment of the set role at the set scope). `DbAuthzAdminBackend` `src/admin/db/backend.ts` refuses an open transaction (`refuseNested` L111-115); stores reach the tx via `storeTransactionDriver(tx, …)` `src/stores/context.ts:34-40`. Guard `src/admin/guard.ts` (`escalation` L131-153, `removals` L259-298, `locksOut` L349-360, `lastHolder` L369-401). CLI base `src/cli/base.ts` (`AuthzCliCommand.command(parse, run)` runs as SYSTEM), commands in `src/cli/commands/` (first export of each file is the command).
- ORM: `QueryMiddleware` `packages/orm/src/interfaces.ts:1667-1692`; builders call `afterQueryCreation` in constructors (`builders.ts` L1331, L1731, L1820, L1889) when only `builder.Model` is set (no `Table` yet); `Builder._run()` `builders.ts:94-109` awaits `beforeQueryExecution` then `this._driver.execute(this)`. `ModelMiddleware` is never called. Transactions: `OrmDriver.CurrentTransaction` (`driver.ts:70-72`, AsyncLocalStorage), `transaction(cb, options?)` (L471, savepoint when nested). Raw where: `builder.where(RawQuery.create(sql, bindings))` (emitted verbatim; qualify columns yourself). Raw select column: `builder.select(RawQuery.create('… AS x'))`. Builder augmentation pattern: `declare module '@spinajs/orm' { interface ISelectQueryBuilder<T> { … } }` + `(SelectQueryBuilder.prototype as any).x = function …` (see `packages/intl-orm/src/index.ts:18-36,135`).
- authz-orm today: `audit/` and `scope-attributes/` are self-contained (no imports from the rest); `scope-attributes` has no subpath export. Test DB helper `packages/authz-orm/test/support/db.ts` (`TestDb.open()`, `define()`, `raw()`).
- HTTP: `AccessController` `packages/authz-http/src/controllers/AccessController.ts`; test harness `packages/authz-http/test/support/app.ts` (`startApp({ controllers, config })`, `stopApp()`), `test/support/principals.ts` (`registerHeaderSource()`: header `x-user: <id>` → user principal), `test/support/domain.ts` (`createDomain(name, { permissions, extraModel })`). Headers: `ServerMiddleware` with `Order` and `before()` (`after()` does not run for controller routes; see `packages/http/src/middlewares/RequestId.ts`). `PrincipalMiddleware` order 10. No SSE support exists.
- Socket: `SocketHub` `packages/http-socket/src/hub.ts` (`to(room).emit(name, payload)`); `@SocketController`, `@OnConnect()` `src/decorators.ts`; `SocketConnection.principal`, `join(room)` `src/connection.ts`; push names must not start with `sys.`.
- Sessions: role switch `packages/authn-http/src/v3/controllers/AuthnActiveRoleController.ts:66-68` (rotate), MFA `packages/authn/src/service/default-authn-service.ts:301` (elevate rotates), impersonation `packages/authn/src/impersonation/impersonation-service.ts` (new session). `principal.authn.sessionHandle` changes on each.

---

## Execution order for one agent (if not parallel)

L0 → L1 → L7 → L12 → L2 → L3 → L4 → L6 → L8 → L10 → L11 → L13 → L5 → L9.

## Definition of done (whole plan)

- `npm run build` at the root succeeds; `node scripts/api-snapshot.mjs --check` passes.
- `npm test` passes in: orm, authz, authz-rbac, authz-abac, authz-orm, authz-http, http-socket, authz-queue, authz-fs, authz-testing, users, configuration-http, queue-http-progress, eslint-plugin-authz.
- No file in the repo imports `@spinajs/authz-orm/native`, `OrmScope`, `OrmScopePolicy`, `OrmNativeCompiler`, `ScopeColumn` or `RbacOrmCompiler` (`grep -rE --exclude='*.md' "OrmScope|OrmNativeCompiler|ScopeColumn|RbacOrmCompiler|authz-orm/native" packages/*/src packages/*/test | grep -v '^packages/authz-convert/test/analyze\.test\.ts:'` returns nothing). Markdown files (history such as `users/test/LEDGER.md`) and `authz-convert/test/analyze.test.ts`, whose negative assertion names `@OrmScope`, are excluded on purpose.
- L9's end-to-end suite passes on SQLite and PostgreSQL.
