# Lane L0: contracts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints and Frozen contracts are binding.

**Goal:** Deliver exactly the "Frozen contracts" of `00-overview.md` (permission `list`, `contracts/plan.ts`, list members on models, batch members on adapters, `AuthzService.checkAll` / `accessPlan`, push contracts, `role_denied` priority, the `not_list_filterable` admin code, and the authz-rbac `RoleDef.deny` / `MembershipStore` / `SubjectKey`), with the registry merge rule, the AJV schema, throwing stubs that keep every `AuthzService` subclass compiling, API snapshots and RFC `RA0-1`.

**Architecture:** Contract-only lane. Types and abstract classes go into the frozen contract files; the only behaviour is the registry's handling of `list` (validate, OR-merge, copy into the def) and two `DefaultAuthzService` stubs that throw `AuthzConfigError` until lane L2 replaces them. Every snapshotted change lands with its regenerated `etc/*.api.md` and the RFC.

**Tech Stack:** TypeScript (node16 ESM), mocha 10 + ts-mocha + chai 4, AJV (config schema), `scripts/api-snapshot.mjs`.

**Depends on:** nothing (wave 1). Base: `authz/resource-access` cut from `feat/authz-v3` (`f616796fc`).

**Blocks:** every wave 2 lane (gate G0 = this lane merged). L2 replaces the two stubs of Task 3.

## Global Constraints

- All code, comments, identifiers, docs and commit messages in English. Comments only where a reader would ask "why?".
- `packages/authz/src/contracts/*` and `packages/authz-rbac/src/contracts.ts` are written only by this lane.
- A change to a snapshotted file (`packages/authz/src/contracts/index.ts` closure, `packages/authz-rbac/src/contracts.ts`) commits together with `packages/<pkg>/etc/<pkg>.api.md` and the RFC `docs/plans/authz-v3-rfc/RA0-1.md` (gate G1 is reached: tag `authz-v3-g1` is an ancestor of HEAD).
- Commit after every task with a conventional message.
- **Running one test file.** Mocha 10 concatenates the `spec` of `.mocharc.json` with files given on the command line, so `npx ts-mocha -p tsconfig.json test/x.test.ts` also runs every configured spec (in `packages/authz` that includes the repository-wide API snapshot check). Every single-file command in this lane therefore uses `--no-config` and restates the loader. Shorthand used below:
  - `ONE` = `npx ts-mocha -p tsconfig.json --no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm --timeout 30000`
- `test/host/**` and `test/admin/**` of `packages/authz` import the built `@spinajs/authz`: run `npm run compile` in `packages/authz` before them. Tests type-check (ts-node ESM loader), so a missing export makes the run abort with `TSError: ⨯ Unable to compile TypeScript`.

## Files

- Create: `packages/authz/src/contracts/plan.ts`
- Create: `packages/authz/test/contracts/plan.test.ts`
- Create: `packages/authz/test/contracts/access-service.test.ts`
- Create: `docs/plans/authz-v3-rfc/RA0-1.md`
- Modify: `packages/authz/src/contracts/permission.ts:12` (add `list`)
- Modify: `packages/authz/src/contracts/index.ts:9` (export `plan.js`)
- Modify: `packages/authz/src/contracts/model.ts:1-6,59` (imports, `listSupport?`, `listPlan?`)
- Modify: `packages/authz/src/contracts/adapter.ts:13` (`loadMany?`, `ancestorsMany?`)
- Modify: `packages/authz/src/contracts/service.ts:1-8,18,66` (imports, `checkAll`, `accessPlan`, `AccessChangedEvent`, `ChangeAudience`, `AccessPushTransport`)
- Modify: `packages/authz/src/contracts/decision.ts:22,81-94` (`role_denied: 150`)
- Modify: `packages/authz/src/contracts/admin.ts:47-48` (error-code comment)
- Modify: `packages/authz/src/engine/registry.ts:8-19,62-72,206-226` (`list` validate, merge, copy)
- Modify: `packages/authz/src/host/config/domain-config.ts:5-10` (`PermissionConfig.list`)
- Modify: `packages/authz/src/host/config/schema.ts:44-55` (`list: { type: 'boolean' }`)
- Modify: `packages/authz/src/host/service.ts:1-17,190-192` (stubs `checkAll`, `accessPlan`)
- Modify: `packages/authz-rbac/src/contracts.ts:36-47,82` (`RoleDef.deny`, `MembershipStore`, `SubjectKey`)
- Modify (tests): `packages/authz/test/engine/registry.test.ts`, `packages/authz/test/host/config.test.ts`, `packages/authz/test/host/service.test.ts`, `packages/authz/test/contracts/decision.test.ts`, `packages/authz/test/contracts/model.test.ts`, `packages/authz-rbac/test/contracts.test.ts`, `packages/http-socket/test/access.test.ts`, `packages/http-socket/test/events.test.ts`, `packages/http-socket/test/scripted-authz.ts`
- Modify (generated): `packages/authz/etc/authz.api.md`, `packages/authz-rbac/etc/authz-rbac.api.md`

Every class that extends `AuthzService` (verified with `grep -rn "extends AuthzService" packages/*/src packages/*/test`): `packages/authz/src/host/service.ts:102` (`DefaultAuthzService`), `packages/authz/test/contracts/model.test.ts:118` (`FakeService`), `packages/http-socket/test/access.test.ts:28` (`AccTestAuthz`), `packages/http-socket/test/events.test.ts:80` (`EvtTestAuthz`), `packages/http-socket/test/scripted-authz.ts:14` (`ScriptedSocketAuthz`). `packages/authz-testing` has none; its fakes cast objects `as unknown as AuthzService`, which needs no change.

---

### Task 1: `list` on permissions (contract, registry, config schema, RFC)

**Files:**
- Modify: `packages/authz/src/contracts/permission.ts:12`
- Modify: `packages/authz/src/engine/registry.ts`
- Modify: `packages/authz/src/host/config/domain-config.ts:5-10`
- Modify: `packages/authz/src/host/config/schema.ts:44-55`
- Create: `docs/plans/authz-v3-rfc/RA0-1.md`
- Test: `packages/authz/test/engine/registry.test.ts`, `packages/authz/test/host/config.test.ts`, `packages/authz/test/host/service.test.ts`

**Interfaces:**
- Produces: `PermissionDef.list?: boolean` (and so `PermissionInput.list?: boolean`, since `PermissionInput` is `Omit<PermissionDef, 'source' | 'resource' | 'action' | 'types'> & …` at `registry.ts:6`); duplicates of one name OR their `list` like `fields`; a def never registered with `list` has no `list` key; `authz.permissions.<name>.list` and `authz.domains.<d>.permissions.<name>.list` are validated as boolean and reach the registry.

- [ ] **Step 1: Write the failing registry tests**

In `packages/authz/test/engine/registry.test.ts`, add this block right before `describe('require', () => {` (currently line 228):

```ts
  describe('list', () => {
    it('keeps list as given and leaves it out when not given', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'task:read', list: true }, { name: 'task:edit', list: false }, { name: 'task:delete' }], 'config');
      expect(reg.get('task:read')).to.deep.equal({ name: 'task:read', resource: 'task', action: 'read', types: ['task'], list: true, source: 'config' });
      expect(reg.get('task:edit')?.list).to.equal(false);
      expect(reg.get('task:delete')).to.not.have.property('list');
    });

    it('rejects a list that is not a boolean and registers nothing', () => {
      const reg = new PermissionRegistryImpl();
      expectConfigError(() => reg.register([{ name: 'task:read' }, { name: 'task:edit', list: 'yes' as unknown as boolean }], 'config'), /list must be a boolean/);
      expect(reg.all()).to.deep.equal([]);
    });

    it('ORs list over the registrations of one name', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'task:read', list: false }], 'adapter:orm');
      reg.register([{ name: 'task:read' }], 'model:rbac');
      expect(reg.get('task:read')?.list).to.equal(false);
      reg.register([{ name: 'task:read', list: true }], 'config');
      reg.register([{ name: 'task:read', list: false }], 'model:abac');
      expect(reg.get('task:read')?.list).to.equal(true);
      expect(reg.get('task:read')?.source).to.equal('adapter:orm,model:rbac,config,model:abac');
      expect(Object.isFrozen(reg.get('task:read'))).to.equal(true);
    });
  });

```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/authz && ONE test/engine/registry.test.ts`
Expected: the run aborts with `TSError: ⨯ Unable to compile TypeScript` and `TS2353: Object literal may only specify known properties, and 'list' does not exist in type 'PermissionInput'`.

- [ ] **Step 3: Add `list` to `PermissionDef`**

In `packages/authz/src/contracts/permission.ts`, after line 12 (`readonly fields?: boolean; // grants/policies may carry field sets`) insert:

```ts
  /** Usable with list helpers (`.accessible()`); boot rule 12 checks every model can plan it. */
  readonly list?: boolean;
```

- [ ] **Step 4: Validate, merge and copy `list` in the registry**

In `packages/authz/src/engine/registry.ts`:

1. In `interface Entry` (lines 8-19), after `fields?: boolean;` add:

```ts
  list?: boolean;
```

2. In `register()`, replace

```ts
      if (n.fields !== undefined) {
        existing.fields = existing.fields === true || n.fields;
      }
```

with

```ts
      if (n.fields !== undefined) {
        existing.fields = existing.fields === true || n.fields;
      }
      if (n.list !== undefined) {
        existing.list = existing.list === true || n.list;
      }
```

3. In `normalize()`, replace

```ts
  if (def.fields !== undefined && typeof def.fields !== 'boolean') {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: fields must be a boolean`);
  }
```

with

```ts
  if (def.fields !== undefined && typeof def.fields !== 'boolean') {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: fields must be a boolean`);
  }
  if (def.list !== undefined && typeof def.list !== 'boolean') {
    throw new AuthzConfigError(`Permission ${quote(name)} from source ${quote(source)}: list must be a boolean`);
  }
```

and replace its return

```ts
  return { name, resource, action, types, implies, fields: def.fields, description: def.description };
```

with

```ts
  return { name, resource, action, types, implies, fields: def.fields, list: def.list, description: def.description };
```

4. In `toDef()`, replace

```ts
  if (e.fields !== undefined) {
    def.fields = e.fields;
  }
```

with

```ts
  if (e.fields !== undefined) {
    def.fields = e.fields;
  }
  if (e.list !== undefined) {
    def.list = e.list;
  }
```

- [ ] **Step 5: Run the registry tests to verify they pass**

Run: `cd packages/authz && ONE test/engine/registry.test.ts`
Expected: PASS, `0 failing` (the three new `list` tests among the passing ones).

- [ ] **Step 6: Write the failing config tests**

In `packages/authz/test/host/config.test.ts`:

1. In `validConfig()` (line 27), change the `permissions` entry to

```ts
  permissions: { 'fs.read': { description: 'Read', fields: true, list: true, types: ['File'], implies: ['fs.list'] }, 'fs.list': {} },
```

2. In `it('rejects wrong types, each for its own reason', …)`, after `fails({ permissions: { a: { types: 'File' } } }, '/permissions/a/types', 'type');` add:

```ts
    fails({ permissions: { a: { list: 'yes' } } }, '/permissions/a/list', 'type');
    fails({ domains: { fs: { permissions: { a: { list: 'yes' } } } } }, '/domains/fs/permissions/a/list', 'type');
```

In `packages/authz/test/host/service.test.ts`, inside `describe('domain config', () => {` (line 587), add as its first test:

```ts
    it('passes list from the permissions config to the registry', async () => {
      setConfig('authz.permissions', { 'doc:read': { list: true }, 'doc:write': {} });
      const m = silent('lister');
      registerInRoot(AuthorizationModel, instance(m));
      await rootService();
      const registry = (m.calls[0].args[0] as ModelInitContext).permissions;
      expect(registry.get('doc:read')?.list).to.equal(true);
      expect(registry.get('doc:write')).to.not.have.property('list');
    });

```

- [ ] **Step 7: Run them to verify they fail**

Run: `cd packages/authz && npm run compile && ONE test/host/config.test.ts && ONE test/host/service.test.ts --grep "passes list"`
Expected: `config.test.ts` FAIL in `rejects wrong types, each for its own reason` (`expected true to equal false`: `list: 'yes'` is accepted today). (The `&&` stops there; after Step 9 both run.)

- [ ] **Step 8: Add `list` to the config type and the AJV schema**

In `packages/authz/src/host/config/domain-config.ts`, replace

```ts
export interface PermissionConfig {
  readonly description?: string;
  readonly fields?: boolean;
  readonly types?: readonly string[];
  readonly implies?: readonly string[];
}
```

with

```ts
export interface PermissionConfig {
  readonly description?: string;
  readonly fields?: boolean;
  readonly list?: boolean;
  readonly types?: readonly string[];
  readonly implies?: readonly string[];
}
```

In `packages/authz/src/host/config/schema.ts`, replace

```ts
    properties: {
      description: { type: 'string' },
      fields: { type: 'boolean' },
      types: stringList,
      implies: stringList,
    },
```

with

```ts
    properties: {
      description: { type: 'string' },
      fields: { type: 'boolean' },
      list: { type: 'boolean' },
      types: stringList,
      implies: stringList,
    },
```

- [ ] **Step 9: Run the config and host tests to verify they pass**

Run: `cd packages/authz && npm run compile && ONE test/host/config.test.ts && ONE test/host/service.test.ts --grep "passes list"`
Expected: both PASS, `0 failing`; the second run reports `1 passing`.

- [ ] **Step 10: Write the RFC**

Create `docs/plans/authz-v3-rfc/RA0-1.md`:

```markdown
# RA0-1: contracts for resource access without query rewriting

Status: APPROVED with the plan `docs/superpowers/plans/2026-10-14-authz-resource-access/` (design
`docs/plans/2026-10-14-authz-resource-access-design.md`). Applied by lane L0, see "As applied".

Affected (frozen; snapshots `packages/authz/etc/authz.api.md`, `packages/authz-rbac/etc/authz-rbac.api.md`):
`PermissionDef`, `AuthorizationModel`, `ResourceAdapter`, `AuthzService`, `DEFAULT_DENY_PRIORITY`
(`packages/authz/src/contracts/*`), new `packages/authz/src/contracts/plan.ts`, and `RoleDef`
(`packages/authz-rbac/src/contracts.ts`).

## Problem

The query middleware of `@spinajs/authz-orm` and the residual-to-SQL compilers are removed (design §1, §9).
Lists move to one explicit helper over a closure table, single objects are checked before access, and
clients get a batch check API with change push. The frozen contracts have no way to:

- mark a permission as usable with the list helper (design §7);
- let a model describe a list filter without the engine or the ORM knowing its tables (plan decision 1);
- check many resources in one call with batched adapter reads (design §6.1, plan decision 3);
- route an `AuthzChange` to the sessions it affects and push it (design §10.4, plan decision 4);
- rank a deny-role reason (design §4.2) or declare a deny role, team membership and subject keys in RBAC
  (design §4.2, §4.3).

## Change

1. `PermissionDef` gains `readonly list?: boolean`. Registrations of one name OR it (as `fields`); the
   authz config schema accepts `permissions.<name>.list` as a boolean.
2. New `contracts/plan.ts`, exported from the barrel: `PlanTerm`, `ModelListPlan`, `AccessPlan`,
   `ListSupport`, `ListPlanRequest` (with optional `actor` and `env`), `SqlRowContext` (with
   `relation(name)` for the row's `owner`/`self` columns), `SqlFragment` and the abstract class
   `PlanTermSql`. A model's `all` plan may carry `deny` terms (a deny role under a global permit).
3. `AuthorizationModel` gains optional `listSupport?(permission, type): ListSupport` and
   `listPlan?(req, ctx): Promise<ModelListPlan>`.
4. `ResourceAdapter` gains optional `loadMany?(refs)` and `ancestorsMany?(refs)`, keyed by `resourceKey`.
5. `AuthzService` gains abstract `checkAll(principal, requests)` and
   `accessPlan(principal, permission, type, env?)`. Same file: `AccessChangedEvent`, abstract classes
   `ChangeAudience` and `AccessPushTransport`.
6. `DEFAULT_DENY_PRIORITY` gains `role_denied: 150`: a deny role outranks ceilings (200) and plain
   `no_access` (400).
7. The admin error-code comment lists `not_list_filterable` (comment only; `code` stays `string`).
8. authz-rbac: `RoleDef` gains `readonly deny?: boolean`; new abstract class `MembershipStore`
   (`setsOf` answers each set key with its membership expiry, `membersOf`) and `type SubjectKey = string`.

## Breaking impact

- Additive for consumers, except item 5: every subclass of `AuthzService` must implement the two new
  methods. In the repo: `DefaultAuthzService` (throwing stubs until lane L2) and four test fakes (L0
  updates them). 3.0 is unreleased.
- `role_denied` is a new code; no existing reason changes rank.

## Affected lanes

- L0: everything above. L2: implements `checkAll`, `accessPlan`, rule 12 and push routing. L3/L4:
  `PlanTermSql` compilers. L6/L8: `MembershipStore`, deny roles, `listPlan` of RBAC. L10: `listPlan` of
  ABAC. L11/L13: push transports.

## As applied

- Task 1: item 1.
```

- [ ] **Step 11: Regenerate the authz API snapshot**

Run: `cd packages/authz && npm run compile && cd ../.. && node scripts/api-snapshot.mjs --update && git status --short packages/*/etc`
Expected: `wrote packages/…/etc/….api.md` for every configured package, and `git status` lists only ` M packages/authz/etc/authz.api.md`. If any other snapshot changed, the local build of that package is stale: run `npm run build` at the root and repeat this step. `git diff packages/authz/etc/authz.api.md` shows only the added `list` member with its doc comment.

- [ ] **Step 12: Commit**

```bash
git add packages/authz/src/contracts/permission.ts packages/authz/src/engine/registry.ts packages/authz/src/host/config/domain-config.ts packages/authz/src/host/config/schema.ts packages/authz/test/engine/registry.test.ts packages/authz/test/host/config.test.ts packages/authz/test/host/service.test.ts packages/authz/etc/authz.api.md docs/plans/authz-v3-rfc/RA0-1.md
git commit -m "feat(authz): PermissionDef.list, OR-merged in the registry and validated in config (RFC RA0-1)"
```

---

### Task 2: list plan contracts, adapter batch members, `role_denied`, `not_list_filterable`

**Files:**
- Create: `packages/authz/src/contracts/plan.ts`
- Modify: `packages/authz/src/contracts/index.ts:9`
- Modify: `packages/authz/src/contracts/model.ts`
- Modify: `packages/authz/src/contracts/adapter.ts:13`
- Modify: `packages/authz/src/contracts/decision.ts:22,81-94`
- Modify: `packages/authz/src/contracts/admin.ts:47-48`
- Create: `packages/authz/test/contracts/plan.test.ts`
- Modify: `packages/authz/test/contracts/decision.test.ts:112-140`
- Modify: `packages/authz/test/contracts/model.test.ts:214-218`
- Modify: `docs/plans/authz-v3-rfc/RA0-1.md`, `packages/authz/etc/authz.api.md`

**Interfaces:**
- Consumes: `PermissionDef.list` (Task 1).
- Produces (all from `@spinajs/authz`): `PlanTerm { op: string; args: unknown }`; `ModelListPlan` (`abstain` | `all` with optional `deny` terms | `deny-all` | `terms`); `AccessPlan` (`none` | `filter` with `permit: 'all' | PlanTerm[]`, `deny`, `within?`, `validUntil?`); `ListSupport = true | { reason }`; `ListPlanRequest { principal; actor?; permission: PermissionDef; type; env? }`; `SqlRowContext` (incl. `relation(name: 'owner' | 'self'): { column; typeColumn? } | undefined`); `SqlFragment`; abstract `PlanTermSql { op; toSql(args, row): SqlFragment }`; `AuthorizationModel.listSupport?(permission, type): ListSupport`; `AuthorizationModel.listPlan?(req, ctx): Promise<ModelListPlan>`; `ResourceAdapter.loadMany?(refs): Promise<ReadonlyMap<string, unknown>>`; `ResourceAdapter.ancestorsMany?(refs): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>>`; `DEFAULT_DENY_PRIORITY.role_denied === 150`.

- [ ] **Step 1: Write the failing contract tests**

Create `packages/authz/test/contracts/plan.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import * as authz from '../../src/index.js';
import { AuthorizationModel, PlanTermSql, ResourceAdapter, FALSE, GLOBAL, TRUE, UNATTENDED, resourceKey } from '../../src/index.js';
import type { AccessPlan, DecisionRequest, DenyReason, EvaluationContext, ListPlanRequest, ListSupport, ModelCapabilities, ModelInitContext, ModelListPlan, PermissionDef, PlanTerm, Principal, ResourceRef, ResourceType, SqlFragment, SqlRowContext, Vote } from '../../src/index.js';

const expect = chai.expect;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <_T extends true>(): void => {};

const caps: ModelCapabilities = { effects: ['permit'], residuals: ['true', 'false'], sync: 'always', fields: false, needsSubject: false };
const vote = (model: string): Vote => ({ model, permitWhen: TRUE, denyWhen: FALSE, cacheable: true });
const owner: PlanTerm = { op: 'relation.owner', args: { principals: [{ type: 'user', id: 'u1' }] } };
const taskRead: PermissionDef = { name: 'task:read', resource: 'task', action: 'read', types: ['task'], list: true, source: 'config' };
const taskEdit: PermissionDef = { name: 'task:edit', resource: 'task', action: 'edit', types: ['task'], source: 'config' };

class PlainModel extends AuthorizationModel {
  public readonly name = 'plain';
  public readonly capabilities = caps;
  public init(_ctx: ModelInitContext): void {}
  public applies(_p: PermissionDef, _t: ResourceType): boolean {
    return true;
  }
  public evaluate(_req: DecisionRequest, _ctx: EvaluationContext): Vote {
    return vote('plain');
  }
}

class ListingModel extends PlainModel {
  public listSupport(permission: PermissionDef, _type: ResourceType): ListSupport {
    return permission.list === true ? true : { reason: `${permission.name} is not a list permission` };
  }
  public async listPlan(req: ListPlanRequest, _ctx: EvaluationContext): Promise<ModelListPlan> {
    return req.env?.ip === undefined ? { kind: 'terms', permit: [owner], deny: [] } : { kind: 'abstain' };
  }
}

class PlainAdapter extends ResourceAdapter<{ id: string }> {
  public readonly kind = 'plain';
  public readonly types = ['task'];
  public accepts(target: unknown): target is { id: string } {
    return typeof target === 'object' && target !== null && 'id' in target;
  }
  public refOf(target: { id: string }): ResourceRef {
    return { type: 'task', id: target.id };
  }
  public async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return [ref, GLOBAL];
  }
}

class BatchAdapter extends PlainAdapter {
  public async loadMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>> {
    return new Map(refs.filter((r) => r.id !== 'gone').map((r): [string, unknown] => [resourceKey(r), { id: r.id }]));
  }
  public async ancestorsMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> {
    return new Map(refs.map((r): [string, readonly ResourceRef[] | null] => [resourceKey(r), r.id === 'gone' ? null : [r, GLOBAL]]));
  }
}

class OwnerSql extends PlanTermSql {
  public readonly op = 'relation.owner';
  public toSql(args: unknown, row: SqlRowContext): SqlFragment {
    const { principals } = args as { principals: { type: string; id: string }[] };
    const owner = row.relation('owner');
    if (!owner) return { sql: '1 = 0', bindings: [] };
    const users = principals.filter((p) => owner.typeColumn !== undefined || p.type === 'user');
    if (users.length === 0) return { sql: '1 = 0', bindings: [] };
    if (owner.typeColumn === undefined) {
      return { sql: `${row.rowColumn(owner.column)} IN (${users.map(() => '?').join(', ')})`, bindings: users.map((p) => p.id) };
    }
    return {
      sql: users.map(() => `(${row.rowColumn(owner.typeColumn!)} = ? AND ${row.rowColumn(owner.column)} = ?)`).join(' OR '),
      bindings: users.flatMap((p) => [p.type, p.id]),
    };
  }
}

describe('list plan contracts', () => {
  it('exports PlanTermSql as a runtime value from the barrel', () => {
    expect((authz as Record<string, unknown>).PlanTermSql).to.be.a('function');
  });

  it('list members of AuthorizationModel and batch members of ResourceAdapter are optional', () => {
    expect(new PlainModel().listSupport).to.equal(undefined);
    expect(new PlainModel().listPlan).to.equal(undefined);
    expect(new PlainAdapter().loadMany).to.equal(undefined);
    expect(new PlainAdapter().ancestorsMany).to.equal(undefined);
  });

  it('a model answers list support and a list plan', async () => {
    const m = new ListingModel();
    expect(m.listSupport(taskRead, 'task')).to.equal(true);
    expect(m.listSupport(taskEdit, 'task')).to.deep.equal({ reason: 'task:edit is not a list permission' });
    const ctx = undefined as unknown as EvaluationContext;
    const req: ListPlanRequest = { principal: UNATTENDED, permission: taskRead, type: 'task', env: { now: new Date(0) } };
    expect(await m.listPlan(req, ctx)).to.deep.equal({ kind: 'terms', permit: [owner], deny: [] });
    expect(await m.listPlan({ ...req, actor: UNATTENDED, env: { ip: '10.0.0.1' } }, ctx)).to.deep.equal({ kind: 'abstain' });
  });

  it('an adapter loads rows and ancestors by resourceKey', async () => {
    const a = new BatchAdapter();
    const refs: ResourceRef[] = [
      { type: 'task', id: '1' },
      { type: 'task', id: 'gone' },
    ];
    const rows = await a.loadMany(refs);
    expect([...rows.keys()]).to.deep.equal(['task:1']);
    const ancestors = await a.ancestorsMany(refs);
    expect(ancestors.get('task:1')).to.deep.equal([refs[0], GLOBAL]);
    expect(ancestors.get('task:gone')).to.equal(null);
  });

  it('a PlanTermSql renders its op against the row context and its relation columns', () => {
    const base = { type: 'task', rowId: 'CAST(t.id AS varchar(64))', rowColumn: (c: string) => `t.${c}`, ancestorTable: 'authz_resource_ancestor', now: new Date(0), dialect: 'sqlite' as const };
    const userOwned: SqlRowContext = { ...base, relation: (name) => (name === 'owner' ? { column: 'owner_id' } : undefined) };
    const typedOwner: SqlRowContext = { ...base, relation: (name) => (name === 'owner' ? { column: 'owner_id', typeColumn: 'owner_type' } : undefined) };
    const noOwner: SqlRowContext = { ...base, relation: () => undefined };
    const sql = new OwnerSql();
    expect(sql.toSql(owner.args, userOwned)).to.deep.equal({ sql: 't.owner_id IN (?)', bindings: ['u1'] });
    expect(sql.toSql(owner.args, typedOwner)).to.deep.equal({ sql: '(t.owner_type = ? AND t.owner_id = ?)', bindings: ['user', 'u1'] });
    expect(sql.toSql(owner.args, noOwner)).to.deep.equal({ sql: '1 = 0', bindings: [] });
    expect(sql.toSql({ principals: [{ type: 'service', id: 's1' }] }, userOwned)).to.deep.equal({ sql: '1 = 0', bindings: [] });
  });

  it('an all plan may carry deny terms', () => {
    const plain: ModelListPlan = { kind: 'all' };
    const withDeny: ModelListPlan = { kind: 'all', deny: [owner], validUntil: new Date(0) };
    expect(plain).to.not.have.property('deny');
    expect(withDeny.kind === 'all' ? withDeny.deny : undefined).to.deep.equal([owner]);
  });

  it('PermissionDef carries list', () => {
    yes<Equal<Pick<PermissionDef, 'list'>, { readonly list?: boolean }>>();
    expect(taskRead.list).to.equal(true);
  });

  it('pins the plan shapes', () => {
    yes<Equal<PlanTerm, { readonly op: string; readonly args: unknown }>>();
    yes<
      Equal<
        ModelListPlan,
        | { readonly kind: 'abstain' }
        | { readonly kind: 'all'; readonly deny?: readonly PlanTerm[]; readonly validUntil?: Date }
        | { readonly kind: 'deny-all'; readonly reason: DenyReason }
        | { readonly kind: 'terms'; readonly permit: readonly PlanTerm[]; readonly deny: readonly PlanTerm[]; readonly validUntil?: Date }
      >
    >();
    yes<
      Equal<
        AccessPlan,
        | { readonly kind: 'none'; readonly reason: DenyReason }
        | { readonly kind: 'filter'; readonly permit: 'all' | readonly PlanTerm[]; readonly deny: readonly PlanTerm[]; readonly within?: readonly ResourceRef[]; readonly validUntil?: Date }
      >
    >();
    yes<Equal<ListSupport, true | { readonly reason: string }>>();
    yes<Equal<ListPlanRequest, { readonly principal: Principal; readonly actor?: Principal; readonly permission: PermissionDef; readonly type: ResourceType; readonly env?: Readonly<Record<string, unknown>> }>>();
    yes<Equal<SqlRowContext, { readonly type: ResourceType; readonly rowId: string; readonly rowColumn: (column: string) => string; readonly ancestorTable: string; readonly relation: (name: 'owner' | 'self') => { readonly column: string; readonly typeColumn?: string } | undefined; readonly now: Date; readonly dialect: 'sqlite' | 'postgres' | 'mysql' | 'mssql' }>>();
    yes<Equal<SqlFragment, { readonly sql: string; readonly bindings: readonly unknown[] }>>();
    yes<Equal<Pick<AuthorizationModel, 'listSupport' | 'listPlan'>, { listSupport?: (permission: PermissionDef, type: ResourceType) => ListSupport; listPlan?: (req: ListPlanRequest, ctx: EvaluationContext) => Promise<ModelListPlan> }>>();
    yes<Equal<Pick<ResourceAdapter, 'loadMany' | 'ancestorsMany'>, { loadMany?: (refs: readonly ResourceRef[]) => Promise<ReadonlyMap<string, unknown>>; ancestorsMany?: (refs: readonly ResourceRef[]) => Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> }>>();
    yes<Equal<PlanTermSql['op'], string>>();
    expect(true).to.equal(true);
  });
});
```

In `packages/authz/test/contracts/decision.test.ts`, in `describe('DEFAULT_DENY_PRIORITY', …)` replace the deep-equal of `it('holds the table', …)` with

```ts
      expect({ ...DEFAULT_DENY_PRIORITY }).to.deep.eq({
        unknown_resource: 0,
        unattended: 0,
        anonymous: 0,
        role_denied: 150,
        ceiling: 200,
        delegate: 200,
        no_access: 400,
        role_too_low: 410,
        tag_missing: 420,
        provenance: 430,
        needs_subject: 500,
        model_error: 900,
        residual_false: 900,
      });
```

and add after `it('is frozen', …)`:

```ts
    it('ranks role_denied above ceilings and plain no_access', () => {
      expect(denyPriority({ code: 'role_denied' })).to.eq(150);
      expect(compareDenyReasons({ code: 'role_denied', model: 'rbac' }, { code: 'ceiling' })).to.be.lessThan(0);
      expect(compareDenyReasons({ code: 'role_denied', model: 'rbac' }, { code: 'no_access', model: 'rbac' })).to.be.lessThan(0);
      expect(compareDenyReasons({ code: 'unknown_resource' }, { code: 'role_denied', model: 'rbac' })).to.be.lessThan(0);
    });
```

In `packages/authz/test/contracts/model.test.ts`, in `it('exports every abstract class as a runtime value from the barrel', …)` replace the name list with

```ts
    for (const name of ['AuthorizationModel', 'Combinator', 'NativeFilter', 'ResourceAdapter', 'ScopeResolver', 'RelationResolver', 'AuthzService', 'AuthzDomains', 'DecisionCache', 'ChangeBus', 'DecisionAudit', 'ConditionFunction', 'ConditionCompiler', 'PlanTermSql']) {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/authz && ONE test/contracts/plan.test.ts test/contracts/decision.test.ts test/contracts/model.test.ts test/contracts/boundary.test.ts`
Expected: the run aborts with `TSError: ⨯ Unable to compile TypeScript` and `TS2305: Module '"../../src/index.js"' has no exported member 'PlanTermSql'` (and the other plan types).

- [ ] **Step 3: Create `contracts/plan.ts`**

Create `packages/authz/src/contracts/plan.ts` (the overview's block with its two `./principal.js` imports merged into one):

```ts
import type { Principal, ResourceRef, ResourceType } from './principal.js';
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

In `packages/authz/src/contracts/index.ts`, after `export * from './model.js';` add:

```ts
export * from './plan.js';
```

- [ ] **Step 4: Add the optional model and adapter members**

In `packages/authz/src/contracts/model.ts`, after line 5 (`import type { RelationResolver } from './adapter.js';`) add:

```ts
import type { ListPlanRequest, ListSupport, ModelListPlan } from './plan.js';
```

and in `AuthorizationModel`, after `summarize?(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary>;` add:

```ts
  /** List support for `permission` on `type`; absent means the model cannot plan lists. */
  listSupport?(permission: PermissionDef, type: ResourceType): ListSupport;
  /** The list plan; called only when listSupport answered true. */
  listPlan?(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan>;
```

In `packages/authz/src/contracts/adapter.ts`, after line 13 (`load?(ref: ResourceRef): Promise<unknown | null>; // subject loader for definite answers`) add:

```ts
  /** Rows by resourceKey; missing keys mean unknown resources. */
  loadMany?(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>>;
  /** Ancestors by resourceKey, each `[self, parent, ..., GLOBAL]`; null = unknown resource. */
  ancestorsMany?(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>>;
```

- [ ] **Step 5: Add `role_denied` and the admin code**

In `packages/authz/src/contracts/decision.ts`:

1. Replace line 22

```ts
// RBAC codes: role_too_low{ladder, role, needed}, tag_missing{tag}, provenance{needed}, rule codes from config
```

with

```ts
// RBAC codes: role_denied, role_too_low{ladder, role, needed}, tag_missing{tag}, provenance{needed}, rule codes from config
```

2. In `DEFAULT_DENY_PRIORITY`, after `anonymous: 0,` add:

```ts
  role_denied: 150,
```

In `packages/authz/src/contracts/admin.ts`, replace lines 47-48

```ts
// codes: unknown_role, not_assignable, wrong_scope_type, unknown_ladder, unknown_permission, rule_not_compilable,
//        invalid_attributes, not_found, forbidden, escalation, last_holder, self_lockout, protected_role, conflict
```

with

```ts
// codes: unknown_role, not_assignable, wrong_scope_type, unknown_ladder, unknown_permission, rule_not_compilable,
//        invalid_attributes, not_found, forbidden, escalation, last_holder, self_lockout, protected_role, conflict,
//        not_list_filterable, set_cycle, set_too_deep
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/authz && ONE test/contracts/plan.test.ts test/contracts/decision.test.ts test/contracts/model.test.ts test/contracts/boundary.test.ts test/engine/reasons.test.ts`
Expected: PASS, `0 failing`; `list plan contracts` reports 8 passing tests.

- [ ] **Step 7: Regenerate the snapshot and note the RFC**

Run: `cd packages/authz && npm run compile && cd ../.. && node scripts/api-snapshot.mjs --update && git status --short packages/*/etc`
Expected: only ` M packages/authz/etc/authz.api.md`; its diff adds `plan.ts` declarations, the four optional members and `role_denied: 150`.

In `docs/plans/authz-v3-rfc/RA0-1.md`, under `## As applied`, add the line:

```markdown
- Task 2: items 2, 3, 4, 6 and 7.
```

- [ ] **Step 8: Commit**

```bash
git add packages/authz/src/contracts/plan.ts packages/authz/src/contracts/index.ts packages/authz/src/contracts/model.ts packages/authz/src/contracts/adapter.ts packages/authz/src/contracts/decision.ts packages/authz/src/contracts/admin.ts packages/authz/test/contracts/plan.test.ts packages/authz/test/contracts/decision.test.ts packages/authz/test/contracts/model.test.ts packages/authz/etc/authz.api.md docs/plans/authz-v3-rfc/RA0-1.md
git commit -m "feat(authz): list plan contracts, adapter batch reads and the role_denied priority (RFC RA0-1)"
```

---

### Task 3: `AuthzService.checkAll` / `accessPlan`, push contracts, stubs in every subclass

**Files:**
- Modify: `packages/authz/src/contracts/service.ts`
- Modify: `packages/authz/src/host/service.ts:15-17,190-192`
- Create: `packages/authz/test/contracts/access-service.test.ts`
- Modify: `packages/authz/test/contracts/model.test.ts` (`FakeService`, barrel list)
- Modify: `packages/http-socket/test/access.test.ts`, `packages/http-socket/test/events.test.ts`, `packages/http-socket/test/scripted-authz.ts`
- Modify: `docs/plans/authz-v3-rfc/RA0-1.md`, `packages/authz/etc/authz.api.md`

**Interfaces:**
- Consumes: `AccessPlan` (Task 2).
- Produces: `AuthzService.checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]): Promise<readonly Decision[]>`; `AuthzService.accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>): Promise<AccessPlan>`; `AccessChangedEvent { objects? }`; abstract `ChangeAudience.audience(change: AuthzChange): Promise<{ principals: readonly string[] | '*'; objects?: readonly ResourceRef[] }>`; abstract `AccessPushTransport { name; push(principals, event): Promise<void> }`. `DefaultAuthzService.checkAll` / `accessPlan` reject with `AuthzConfigError` whose message ends in `not implemented until lane L2`; L2 replaces both (see `L02-engine.md`, its `accessPlan`/`checkAll` task). No test pins the stubs, so L2 has nothing to delete.

- [ ] **Step 1: Write the failing contract tests**

Create `packages/authz/test/contracts/access-service.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import * as authz from '../../src/index.js';
import { AccessPushTransport, ChangeAudience } from '../../src/index.js';
import type { AccessChangedEvent, AccessPlan, AuthzChange, AuthzService, Decision, Permission, Principal, ResourceRef, ResourceType } from '../../src/index.js';

const expect = chai.expect;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

const task7: ResourceRef = { type: 'task', id: '7' };

class TagAudience extends ChangeAudience {
  public async audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] }> {
    return change.tags.includes('roles') ? { principals: '*' } : { principals: ['user:alice'], objects: [task7] };
  }
}

class RecordingTransport extends AccessPushTransport {
  public readonly name = 'recording';
  public readonly sent: { principals: readonly string[] | '*'; event: AccessChangedEvent }[] = [];
  public async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    this.sent.push({ principals, event });
  }
}

describe('access service contracts', () => {
  it('exports ChangeAudience and AccessPushTransport as runtime values from the barrel', () => {
    for (const name of ['ChangeAudience', 'AccessPushTransport']) {
      expect((authz as Record<string, unknown>)[name], name).to.be.a('function');
    }
  });

  it('an audience answers principals with exact objects, or every session', async () => {
    const a = new TagAudience();
    expect(await a.audience({ tags: ['subject:user:alice'], at: new Date(0) })).to.deep.equal({ principals: ['user:alice'], objects: [task7] });
    expect(await a.audience({ tags: ['roles'], at: new Date(0) })).to.deep.equal({ principals: '*' });
  });

  it('a transport pushes an event with or without objects', async () => {
    const t = new RecordingTransport();
    await t.push(['user:alice'], { objects: [task7] });
    await t.push('*', {});
    expect(t.name).to.equal('recording');
    expect(t.sent).to.deep.equal([
      { principals: ['user:alice'], event: { objects: [task7] } },
      { principals: '*', event: {} },
    ]);
  });

  it('pins checkAll, accessPlan and the push shapes', () => {
    yes<Equal<Parameters<AuthzService['checkAll']>, [principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]]>>();
    yes<Equal<ReturnType<AuthzService['checkAll']>, Promise<readonly Decision[]>>>();
    yes<Equal<Parameters<AuthzService['accessPlan']>, [principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>]>>();
    yes<Equal<ReturnType<AuthzService['accessPlan']>, Promise<AccessPlan>>>();
    yes<Equal<AccessChangedEvent, { readonly objects?: readonly ResourceRef[] }>>();
    yes<Equal<Shape<ChangeAudience>, { audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] }> }>>();
    yes<Equal<Shape<AccessPushTransport>, { readonly name: string; push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> }>>();
    expect(true).to.equal(true);
  });
});
```

In `packages/authz/test/contracts/model.test.ts`:

1. In the type import on line 7, add `AccessPlan` to the imported names (alphabetical position does not matter):

```ts
import type { AccessPlan, AccessSummary, AuthzAdmin, AuthzChange, CheckInput, Condition, Decision, DecisionRequest, EvaluationContext, FieldSet, FilterOp, PermissionRegistry, PrincipalType, TraceStep, ModelCapabilities, ModelInitContext, ModelSummary, Permission, PermissionDef, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, RoutePlan, Trace, Vote } from '../../src/index.js';
```

2. In `class FakeService`, after `checkMany(…)` add:

```ts
  public async checkAll(_p: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]): Promise<readonly Decision[]> {
    return requests.map(() => decision);
  }
  public async accessPlan(_p: Principal, _permission: Permission, _type: ResourceType, _env?: Readonly<Record<string, unknown>>): Promise<AccessPlan> {
    return { kind: 'filter', permit: 'all', deny: [] };
  }
```

3. Replace the barrel name list (as edited in Task 2) with

```ts
    for (const name of ['AuthorizationModel', 'Combinator', 'NativeFilter', 'ResourceAdapter', 'ScopeResolver', 'RelationResolver', 'AuthzService', 'AuthzDomains', 'DecisionCache', 'ChangeBus', 'DecisionAudit', 'ConditionFunction', 'ConditionCompiler', 'PlanTermSql', 'ChangeAudience', 'AccessPushTransport']) {
```

4. In `it('AuthzService is an AsyncService', …)`, after the `checkMany` expectation add:

```ts
    expect(await s.checkAll(UNATTENDED, [{ permission: 'a:b', resource: GLOBAL }])).to.deep.eq([decision]);
    expect(await s.accessPlan(UNATTENDED, 'a:b', 't')).to.deep.eq({ kind: 'filter', permit: 'all', deny: [] });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/authz && ONE test/contracts/access-service.test.ts test/contracts/model.test.ts`
Expected: the run aborts with `TSError: ⨯ Unable to compile TypeScript` and `TS2305: Module '"../../src/index.js"' has no exported member 'AccessPushTransport'` (and `ChangeAudience`, `AccessChangedEvent`).

- [ ] **Step 3: Add the service contracts**

In `packages/authz/src/contracts/service.ts`:

1. After line 8 (`import type { AuthorizationModel, ModelSummary } from './model.js';`) add:

```ts
import type { AccessPlan } from './plan.js';
```

2. In `AuthzService`, after line 18 (`abstract checkMany(…)`) add:

```ts
  abstract checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]): Promise<readonly Decision[]>;
  abstract accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>): Promise<AccessPlan>;
```

3. After `export abstract class ChangeBus { … }` (ends line 66) add:

```ts

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

- [ ] **Step 4: Stub the two methods in `DefaultAuthzService`**

In `packages/authz/src/host/service.ts`:

1. After line 17 (`import type { Decision } from '../contracts/decision.js';`) add:

```ts
import type { AccessPlan } from '../contracts/plan.js';
```

2. After `checkMany(…) { … }` (lines 190-192) add:

```ts

  async checkAll(_principal: Principal, _requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]): Promise<readonly Decision[]> {
    throw new AuthzConfigError('checkAll: not implemented until lane L2');
  }

  async accessPlan(_principal: Principal, _permission: Permission, _type: ResourceType, _env?: Readonly<Record<string, unknown>>): Promise<AccessPlan> {
    throw new AuthzConfigError('accessPlan: not implemented until lane L2');
  }
```

- [ ] **Step 5: Add the members to the http-socket fakes**

In `packages/http-socket/test/access.test.ts`:

1. Replace line 10 with

```ts
import type { AccessPlan, AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
```

2. In `class AccTestAuthz`, after `checkMany()` add:

```ts

  public checkAll(): Promise<readonly Decision[]> {
    return unused('checkAll');
  }

  public accessPlan(): Promise<AccessPlan> {
    return unused('accessPlan');
  }
```

In `packages/http-socket/test/events.test.ts`:

1. Replace line 11 with

```ts
import type { AccessPlan, AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
```

2. In `class EvtTestAuthz`, after `checkMany()` add:

```ts
  public checkAll(): Promise<readonly Decision[]> {
    return unused('checkAll');
  }
  public accessPlan(): Promise<AccessPlan> {
    return unused('accessPlan');
  }
```

In `packages/http-socket/test/scripted-authz.ts`:

1. Replace line 4 with

```ts
import type { AccessPlan, AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
```

2. In `class ScriptedSocketAuthz`, after `checkMany()` add:

```ts

  public checkAll(): Promise<readonly Decision[]> {
    return unused('ScriptedSocketAuthz.checkAll');
  }

  public accessPlan(): Promise<AccessPlan> {
    return unused('ScriptedSocketAuthz.accessPlan');
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/authz && ONE test/contracts/access-service.test.ts test/contracts/model.test.ts test/contracts/plan.test.ts`
Expected: PASS, `0 failing`; `access service contracts` reports 4 passing tests.

Run: `cd packages/authz && npm run compile && ONE test/host/service.test.ts`
Expected: PASS, `0 failing` (`DefaultAuthzService` compiles with the stubs).

Run: `cd packages/http-socket && ONE test/access.test.ts test/events.test.ts test/access-fields.test.ts test/access-parity.test.ts test/input-filter.test.ts`
Expected: PASS, `0 failing` (the three fakes type-check).

- [ ] **Step 7: Regenerate the snapshot and note the RFC**

Run: `cd packages/authz && npm run compile && cd ../.. && node scripts/api-snapshot.mjs --update && git status --short packages/*/etc`
Expected: only ` M packages/authz/etc/authz.api.md`; its diff adds `checkAll`, `accessPlan`, `AccessChangedEvent`, `ChangeAudience`, `AccessPushTransport`.

In `docs/plans/authz-v3-rfc/RA0-1.md`, under `## As applied`, add:

```markdown
- Task 3: item 5. `DefaultAuthzService.checkAll` and `accessPlan` reject with `AuthzConfigError` until lane
  L2; the test fakes of `packages/authz` and `packages/http-socket` implement both.
```

- [ ] **Step 8: Commit**

```bash
git add packages/authz/src/contracts/service.ts packages/authz/src/host/service.ts packages/authz/test/contracts/access-service.test.ts packages/authz/test/contracts/model.test.ts packages/http-socket/test/access.test.ts packages/http-socket/test/events.test.ts packages/http-socket/test/scripted-authz.ts packages/authz/etc/authz.api.md docs/plans/authz-v3-rfc/RA0-1.md
git commit -m "feat(authz): AuthzService.checkAll and accessPlan, change audience and push transport contracts (RFC RA0-1)"
```

---

### Task 4: authz-rbac contracts (`RoleDef.deny`, `MembershipStore`, `SubjectKey`)

**Files:**
- Modify: `packages/authz-rbac/src/contracts.ts:36-47,82`
- Modify: `packages/authz-rbac/test/contracts.test.ts`
- Modify: `docs/plans/authz-v3-rfc/RA0-1.md`, `packages/authz-rbac/etc/authz-rbac.api.md`

**Interfaces:**
- Produces (from `@spinajs/authz-rbac`): `RoleDef.deny?: boolean`; abstract `MembershipStore { setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]>; membersOf(setKey: string, at: Date): Promise<readonly string[]> }`; `type SubjectKey = string`. Validation of `deny` (config keys, role graph) belongs to L8; storage of membership to L6.

- [ ] **Step 1: Write the failing tests**

In `packages/authz-rbac/test/contracts.test.ts`:

1. Replace line 6 with

```ts
import { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore, SubjectResolver } from '../src/index.js';
```

and line 8 with

```ts
import type { Assignment, AssignmentSubject, GrantDef, ImpliedRole, LadderDef, LinkDef, ResourcePattern, RoleDef, RuleDef, SubjectKey, SubjectSelector } from '../src/index.js';
```

2. In `it('RoleDef has no namespace and requires assignable', …)`, replace

```ts
    const full: RoleDef = { ...r, ladder: 'project', implies: [], subjectSet: true, scopeTypes: ['org'], description: 'd' };
```

with

```ts
    const full: RoleDef = { ...r, ladder: 'project', implies: [], subjectSet: true, deny: false, scopeTypes: ['org'], description: 'd' };
    const blocked: RoleDef = { name: 'blocked', deny: true, extends: [], grants: [{ permission: 'invoice:edit' }], assignable: true, source: 'config' };
    expect(blocked.deny).to.equal(true);
```

3. In `it('store classes are runtime exports of the root', …)`, replace the list with

```ts
    for (const k of ['RoleStore', 'RuleStore', 'AssignmentStore', 'LinkStore', 'SubjectResolver', 'MembershipStore']) {
```

4. After `it('SubjectResolver may return sync or async', …)` add:

```ts
  it('MembershipStore fake answers sets with their expiry and members of a set', async () => {
    const until = new Date('2030-01-01T00:00:00Z');
    const closure: Record<string, { setKey: string; expiresAt?: Date }[]> = {
      'user:42': [{ setKey: 'team:7#member' }, { setKey: 'team:1#member', expiresAt: until }],
      'team:7#member': [{ setKey: 'team:1#member' }],
    };
    class M extends MembershipStore {
      async setsOf(memberKeys: readonly string[], _at: Date) {
        return memberKeys.flatMap((k) => closure[k] ?? []);
      }
      async membersOf(setKey: string, _at: Date) {
        return Object.keys(closure).filter((k) => closure[k].some((s) => s.setKey === setKey));
      }
    }
    const m = new M();
    const key: SubjectKey = 'user:42';
    expect(await m.setsOf([key, 'user:*'], new Date(0))).to.deep.equal([{ setKey: 'team:7#member' }, { setKey: 'team:1#member', expiresAt: until }]);
    expect(await m.membersOf('team:1#member', new Date(0))).to.deep.equal(['user:42', 'team:7#member']);
  });
```

5. In `describe('authz-rbac pinned shapes', …)`, in the `RoleDef` shape, after `readonly subjectSet?: boolean;` add `readonly deny?: boolean;`, so it reads:

```ts
          readonly implies?: readonly ImpliedRole[];
          readonly subjectSet?: boolean;
          readonly deny?: boolean;
          readonly assignable: boolean;
```

and after `yes<Equal<Shape<SubjectResolver>, …>>();` add:

```ts
    yes<Equal<Shape<MembershipStore>, { setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]>; membersOf(setKey: string, at: Date): Promise<readonly string[]> }>>();
    yes<Equal<SubjectKey, string>>();
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/authz-rbac && ONE test/contracts.test.ts`
Expected: the run aborts with `TSError: ⨯ Unable to compile TypeScript` and `TS2305: Module '"../src/index.js"' has no exported member 'MembershipStore'`.

- [ ] **Step 3: Add the contracts**

In `packages/authz-rbac/src/contracts.ts`:

1. In `RoleDef`, replace

```ts
  readonly subjectSet?: boolean; // holders form a subject set others can be assigned to
```

with

```ts
  readonly subjectSet?: boolean; // holders form a subject set others can be assigned to
  readonly deny?: boolean; // subtracts its grants on its scope and below; wins over every permit (role_denied)
```

2. After `export abstract class SubjectResolver { … }` (ends line 82) add:

```ts

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/authz-rbac && ONE test/contracts.test.ts`
Expected: PASS, `16 passing`.

- [ ] **Step 5: Regenerate the snapshot and note the RFC**

Run: `cd packages/authz-rbac && npm run compile && cd ../.. && node scripts/api-snapshot.mjs --update && git status --short packages/*/etc`
Expected: only ` M packages/authz-rbac/etc/authz-rbac.api.md`; its diff adds `deny?`, `MembershipStore` and `SubjectKey`.

In `docs/plans/authz-v3-rfc/RA0-1.md`, under `## As applied`, add:

```markdown
- Task 4: item 8.
```

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/contracts.ts packages/authz-rbac/test/contracts.test.ts packages/authz-rbac/etc/authz-rbac.api.md docs/plans/authz-v3-rfc/RA0-1.md
git commit -m "feat(authz-rbac): RoleDef.deny, MembershipStore and SubjectKey contracts (RFC RA0-1)"
```

---

### Task 5: full build, snapshot gate and suites (G0)

**Files:**
- Modify (only if the full build changes them): `packages/authz/etc/authz.api.md`, `packages/authz-rbac/etc/authz-rbac.api.md`
- Modify: `docs/plans/authz-v3-rfc/RA0-1.md` (status line)

**Interfaces:**
- Produces: gate G0, the contracts every wave 2 lane codes against.

- [ ] **Step 1: Build everything and check the snapshots**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: the build ends without `error TS`; the check prints `API snapshots are up to date` and exits 0. If it reports a difference, run `node scripts/api-snapshot.mjs --update`, confirm with `git diff packages/*/etc` that only lines of this lane's changes moved, and include the files in Step 4's commit.

- [ ] **Step 2: Check the RFC rule**

Run (repo root): `node scripts/api-snapshot.mjs --check-rfc feat/authz-v3`
Expected: `API snapshots changed with RFC docs/plans/authz-v3-rfc/RA0-1.md`, exit 0.

- [ ] **Step 3: Run the package suites**

Run: `cd packages/authz && npm test`
Expected: three mocha runs, each `0 failing` (the first includes `matches the committed snapshots (--check)`, which may take several minutes).

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

Run: `cd packages/http-socket && npm test`
Expected: both runs `0 failing`.

- [ ] **Step 4: Mark the RFC applied and commit**

In `docs/plans/authz-v3-rfc/RA0-1.md`, replace the status paragraph with

```markdown
Status: APPROVED with the plan `docs/superpowers/plans/2026-10-14-authz-resource-access/` (design
`docs/plans/2026-10-14-authz-resource-access-design.md`). APPLIED by lane L0 (gate G0), see "As applied".
```

```bash
git add docs/plans/authz-v3-rfc/RA0-1.md packages/authz/etc/authz.api.md packages/authz-rbac/etc/authz-rbac.api.md
git commit -m "docs(authz): RFC RA0-1 applied; lane L0 contracts complete (G0)"
```

---

## Contract issues found

1. **Import path in the `plan.ts` sketch** (resolved in the overview): `ResourceRef` and `ResourceType` come from `./principal.js`, not `./resource.js`.
2. **`PermissionInput.list` needs no own declaration.** `PermissionInput` is derived from `PermissionDef` with `Omit` (`registry.ts:6`), so it gains `list` from item 1. The work is in `normalize`, the merge in `register` and `toDef`. The host's `PermissionConfig` (`host/config/domain-config.ts:5-10`, not frozen) also needs `list`; Task 1 adds it.
3. **The overview's one-file test command runs everything.** Mocha 10 concatenates the `spec` of `.mocharc.json` with the files on the command line (checked with mocha 10.8.2), so `npx ts-mocha -p tsconfig.json test/x.test.ts` in `packages/authz` also runs every non-host test, including the repository snapshot check (minutes long). This lane uses `--no-config --node-option experimental-specifier-resolution=node --node-option loader=ts-node/esm`. The Global Constraints of `00-overview.md` should say the same.
