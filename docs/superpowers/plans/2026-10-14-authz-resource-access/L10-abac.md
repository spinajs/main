# Lane L10: abac list plans

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane.

**Goal:** Make `AbacModel` plan lists (`listSupport`, `listPlan`), refuse at write time a `policy.put` that would make a `list: true` permission non-filterable, and delete the ABAC scope-residual leaves (`authz.abac.scopeResiduals`, `native:condition.scope`) everywhere.

**Architecture:** An ABAC policy is list-plannable when it can be decided without the row: its condition reads only `principal.*`, `actor.*`, `env.*` and `scope.$global.*`, and its `scope` is absent or `$global`. Then `listPlan` evaluates every candidate policy once for the principal, actor and env of the `ListPlanRequest` (overview decision 8) and answers `deny-all`, `all` or `abstain`; ABAC never emits terms. `listSupport` and the `policy.put` guard share one function, `policyListProblem`, so boot and write time cannot disagree.

**Tech Stack:** TypeScript (node16 modules), `@spinajs/di`, mocha + ts-mocha + chai 4.

**Depends on:** L0 merged (G0): `PermissionDef.list`, `PermissionInput.list`, `ListSupport`, `ListPlanRequest` (with `actor?` and `env?`, overview decision 8), `ModelListPlan`, `AuthorizationModel.listSupport?` / `listPlan?`. L2 Task 7 merged for Task 4 (`ListSupportGuard` exported from `@spinajs/authz`; run `npm run compile` in `packages/authz` first).

**Blocks:** L9 (end-to-end lists with ABAC). L2's boot rule 12 asks this model's `listSupport` for every routed `list: true` permission.

## Global Constraints

- All code, comments, identifiers and commit messages in English; comments only where a reader would ask "why?".
- Match the surrounding code: `Object.freeze` on returned values, `AuthzConfigError` for misconfiguration, `AuthzAdminFailure(code, message, field?)` for refused admin commands.
- Tests: mocha + chai `expect`. One file: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/<path>.test.ts`. After changing `packages/authz`, run `npm run compile` there before the abac tests (they import the built `@spinajs/authz`).
- `packages/authz-abac/src/contracts.ts` and `packages/authz/src/conditions/contracts.ts` are not touched (no API snapshot change). `packages/authz/src/conditions/compiler.ts` and `scope-leaf.ts` are not snapshotted.
- 3.0 is unreleased: no deprecation shims; removed config keys simply go.
- Commit after every task.

## Decisions made in this lane

1. **What "can be decided without the row" means.** Design §7 names only `resource.*`. A policy is also row-dependent when its condition reads `scope.<type>.*` for a type other than `$global` (the nearest ancestor's attributes) or when its `scope` is a node or a bare type (`under` a scope): both differ per row and ABAC has no `PlanTermSql` compiler. `listSupport` refuses all three. A condition function counts through `ParsedCondition.facts` (its `{ ref }` args are in `facts.roots` / `facts.scopeTypes`), so `fn` needs no special case.
2. **`env.*` and `actor.*` are fine** (overview decision 8): `listPlan` compiles each condition against `{ principal, actor, permission, resource: { type }, env }`. L2 never memoises a plan built with a caller env and keeps plans in request scope only (L2 decision 5), so no `cacheable` flag is needed.
3. **`listPlan` fails closed on what `listSupport` should have refused** (a DB policy loaded after boot that slipped past the guard, e.g. stored before the permission became `list: true`): it throws an `Error` naming the policy; L2 turns a throw into `deny-all` `model_error` (L2 decision 3).
4. **`listWarnings` (B19 boot warning) is deleted.** It only existed for list-scoped types of the old authz-orm middleware and read `scopeResiduals`; boot rule 12 with `listSupport` replaces it.
5. **Deny reason of `deny-all`** is the vote's: `{ code: policy.reason ?? 'policy', policy: id, priority, sortKey: id }` (`reasonOf` in `model.ts`), the lowest by `compareDenyReasons` when several deny policies hold.

## Files

- Modify: `packages/authz/src/conditions/compiler.ts` (drop scope leaves: L21, L34-50, L157-163, L172-200, L208-235, L381-431)
- Delete: `packages/authz/src/conditions/scope-leaf.ts`, `packages/authz/test/conditions/scope-leaf.test.ts`
- Modify: `packages/authz/src/conditions/index.ts` (L5)
- Modify: `packages/authz-abac/src/model/model.ts`, `packages/authz-abac/src/model/schema.ts`
- Create: `packages/authz-abac/src/model/list.ts`, `packages/authz-abac/src/admin/list-guard.ts`
- Modify: `packages/authz-abac/src/model/index.ts`, `packages/authz-abac/src/admin/index.ts`
- Delete: `packages/authz-abac/test/model/scope-residuals.test.ts`
- Modify tests: `packages/authz-abac/test/conformance.test.ts`, `packages/authz-abac/test/model/config.test.ts`
- Create tests: `packages/authz-abac/test/model/list.test.ts`, `packages/authz-abac/test/admin/list-guard.test.ts`
- Modify docs: `docs/authz/README.md` (L455-466), `docs/authz/migration-guide.md` (L1388-1396)
- Modify if still present (L5/L3 may have deleted or rewritten them): `packages/authz-testing/test/canvas-c6/config.ts` (L60, L227-229), `packages/authz-testing/test/canvas-c6/config.test.ts` (L125-127), `packages/authz-testing/fixtures/canvas-c6/config.snapshot.json` (L709), `packages/authz-orm/README.md` ("ABAC scope leaves" section, L231-240)

---

### Task 1: Delete `scopeResiduals` and `native:condition.scope`

**Files:** as listed above under "Modify/Delete" except `list.ts`, `list-guard.ts` and the two new tests.

**Interfaces:**
- Removes from `@spinajs/authz`: `SCOPE_CONDITION_OP`, `ScopeConditionValue`, `ScopeConditionArgs`, `parseScopeConditionArgs`, `isScopeLeaf`, `CompileOptions`, `ScopeConditionFilter`, `SCOPE_CONDITION_FILTER`, `CompiledCondition.fault`, the 4th parameter of `DefaultConditionCompiler.compileParsed`.
- Removes from `@spinajs/authz-abac`: `AbacModelOptions.scopeResiduals`, `ABAC_DEFAULT_SCOPE_RESIDUALS`, `AbacModel.listWarnings`, config key `authz.abac.scopeResiduals`.
- Keeps: `CompiledCondition.unresolvedScope` (B39 without leaves).

- [ ] **Step 1: Make the config test expect the key gone (failing test first)**

In `packages/authz-abac/test/model/config.test.ts` replace the defaults assertion (L27) with:

```ts
    expect((await boot(undefined)).get('authz.abac')).to.deep.equal({ stores: ['ConfigPolicyStore'], policies: [], connection: 'default' });
```

and delete the two lines (L43-44):

```ts
    expect(await refused({ scopeResiduals: 'yes' })).to.include('authz.abac.scopeResiduals');
    expect(await refused({ scopeResiduals: {} })).to.include('authz.abac.scopeResiduals');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/model/config.test.ts`
Expected: FAIL in `fills the defaults storesFromConfig reads` (the actual object still holds `scopeResiduals: false`).

- [ ] **Step 3: Remove the leaves from the core condition compiler**

In `packages/authz/src/conditions/compiler.ts`:

Delete the import line 21:

```ts
import { SCOPE_CONDITION_OP, isScopeLeaf, parseScopeConditionArgs } from './scope-leaf.js';
```

Replace `CompiledCondition` and `CompileOptions` (L34-50) with:

```ts
export interface CompiledCondition {
  readonly filter: ResourceFilter;
  readonly cacheable: boolean;
  readonly needsSubject: boolean;
  /** Some `scope.<type>.*` ref could not be read on a request without id (B19 needs the subject, B39 calls it indeterminate; the model decides). */
  readonly unresolvedScope: boolean;
}
```

Replace `compileParsed` (L157-163) with:

```ts
  async compileParsed(p: ParsedCondition, req: DecisionRequest, ctx: EvaluationContext): Promise<CompiledCondition> {
    const run = new Run(req, ctx, this.functions, this.resourceAttributeTypes);
    const filter = simplify(await run.node(p));
    return Object.freeze({ filter, cacheable: run.cacheable, needsSubject: run.needsSubject, unresolvedScope: run.unresolvedScope });
  }
```

In `class Run`: delete the field `leafReads` and its doc comment, change the constructor to

```ts
  constructor(private readonly req: DecisionRequest, private readonly ctx: EvaluationContext, private readonly functions: ReadonlyMap<string, ConditionFunction>, private readonly resourceAttributeTypes: ReadonlySet<string>) {
```

delete the line `if (this.scopeLeaves && isScopeLeaf(p)) return this.scopeLeaf(p.attr, p.op, p.operand);` in `node()`, and delete the methods `fault()` and `scopeLeaf()` with their doc comments. Change `async comparison(` and `async scopeValue(` to `private async comparison(` and `private async scopeValue(` (only `ScopeConditionFilter` called them from outside).

Delete, after `class Run`, everything from `function scopeLeafNode(` through `function saysFault(...) { ... }` inclusive: `scopeLeafNode`, `NO_PRINCIPAL`, `NO_FUNCTIONS`, `NO_TYPES`, the `ScopeConditionFilter` class with its doc comment, `SCOPE_CONDITION_FILTER` and `saysFault`. Then remove imports the file no longer uses: run `npx tsc -p tsconfig.json --noEmit` in `packages/authz` and drop each import it reports as unused (expected: `NativeFilter`, and `Principal` if nothing else reads it; `ConditionOperand` stays only if still referenced).

Delete `packages/authz/src/conditions/scope-leaf.ts` and `packages/authz/test/conditions/scope-leaf.test.ts`, and remove line 5 of `packages/authz/src/conditions/index.ts`:

```ts
export * from './scope-leaf.js';
```

- [ ] **Step 4: Compile the core**

Run: `cd packages/authz && npx tsc -p tsconfig.json --noEmit && npm run compile`
Expected: no errors.

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/conditions/compiler.test.ts`
Expected: `0 failing` (its `unresolvedScope` cases stay).

- [ ] **Step 5: Remove the switch from the ABAC model**

In `packages/authz-abac/src/model/schema.ts` delete `export const ABAC_DEFAULT_SCOPE_RESIDUALS = false;` and, in `AUTHZ_ABAC_CONFIGURATION_SCHEMA.properties`, the comment line and the `scopeResiduals` property.

In `packages/authz-abac/src/model/model.ts`:

Line 2 becomes:

```ts
import { AuthorizationModel, AuthzConfigError, BUILTIN_CONDITION_FUNCTIONS, ConditionFunction, DefaultConditionCompiler, FALSE, GLOBAL, TRUE, and, or, subtractFieldGlobs, unionFieldGlobs } from '@spinajs/authz';
```

Line 10 becomes:

```ts
import { ABAC_DEFAULT_CONNECTION, ABAC_DEFAULT_STORES, ABAC_STORE_NAMES } from './schema.js';
```

Delete the `scopeResiduals` member of `AbacModelOptions` with its doc comment, the constant `SCOPE_RESIDUALS`, the field `private scopeResiduals: boolean | undefined;`, and the constructor line `this.scopeResiduals = options.scopeResiduals;`.

In `capabilities` the return becomes:

```ts
    return { effects: ['permit', 'deny'], residuals: RESIDUALS, sync, fields: true, needsSubject: true };
```

In `init` delete the block from `if (this.scopeResiduals === undefined) {` through `if (this.scopeResiduals) ctx.registerNativeFilter(SCOPE_CONDITION_FILTER);`.

Replace `evaluateAsync` (L178-217) with:

```ts
  private async evaluateAsync(req: DecisionRequest, ctx: EvaluationContext, live: readonly LoadedPolicy[], readAncestors: boolean, root: readonly ResourceRef[] | undefined): Promise<Vote> {
    let ancestors = root;
    if (readAncestors) {
      const list = await ctx.ancestors(req.resource);
      if (list === null) throw new Error(`the ancestors of ${req.resource.type}:${req.resource.id} are unknown`);
      ancestors = list;
    }
    let cacheable = true;
    const entries: Entry[] = [];
    for (const p of live) {
      const scope = scopeFilter(p.policy.scope, ancestors);
      if (scope === FALSE) continue;
      if (!p.when) {
        entries.push({ p, when: scope, needsSubject: false });
        continue;
      }
      const c = await this.compile(p, req, ctx);
      if (!c.cacheable) cacheable = false;
      // A scope.* ref a request without id cannot read, even where the filter folded: the check of a
      // row still reads it and faults where it is missing, so no fold may list that row.
      const unread = c.unresolvedScope;
      // Decided without the row after all: a resource.* read it lacks sits under a junction that does not matter.
      if (c.filter.op === 'false' && !unread) continue;
      if (!c.needsSubject || (c.filter.op === 'true' && !unread)) {
        entries.push({ p, when: and(scope, c.filter), needsSubject: false });
      } else if (p.policy.effect === 'deny') {
        // B19: fail closed; the deny holds wherever the policy applies, with its own reason.
        entries.push({ p, when: scope, needsSubject: true });
      } else if (unread) {
        // B39: the vote is indeterminate.
        throw new Error(`${p.where}: its condition reads scope attributes, which a request without id cannot resolve`);
      }
      // A permit whose condition needs the row it was not given permits nothing (B19).
    }
    return this.vote(entries, cacheable);
  }
```

Replace `compile` (L219-223) with:

```ts
  private compile(p: LoadedPolicy, req: DecisionRequest, ctx: EvaluationContext): Promise<CompiledCondition> {
    const compiler = ctx.conditions as Partial<DefaultConditionCompiler>;
    if (typeof compiler.compileParsed === 'function') return compiler.compileParsed(p.when!, req, ctx);
    return ctx.conditions.compile(p.policy.when!, req, ctx) as Promise<CompiledCondition>;
  }
```

Replace `vote` (L230-248) with:

```ts
  private vote(entries: readonly Entry[], cacheable: boolean): Vote {
    const live = entries.filter((e) => e.when !== FALSE);
    const permits = live.filter((e) => e.p.policy.effect === 'permit');
    const denies = live.filter((e) => e.p.policy.effect === 'deny');
    const expiries = live.flatMap((e) => (e.p.expiresAt ? [e.p.expiresAt.getTime()] : []));
    const fields = fieldsOf(permits, denies);
    const blocking = denies.map((e) => ({ when: e.when, reason: reasonOf(e) }));
    return {
      model: this.name,
      permitWhen: permits.length === 0 ? FALSE : or(...permits.map((e) => e.when)),
      denyWhen: blocking.length === 0 ? FALSE : or(...blocking.map((e) => e.when)),
      ...(blocking.length > 0 ? { denies: blocking } : {}),
      ...(fields ? { fields } : {}),
      ...(expiries.length > 0 ? { validUntil: new Date(Math.min(...expiries)) } : {}),
      cacheable,
    };
  }
```

Delete `listWarnings` (L324-340 with its doc comment), the module function `needsRow` (L454-466) and `faultReason` (L496-498). Run `npx tsc -p tsconfig.json --noEmit` in `packages/authz-abac`; drop any import it reports unused (`ParsedCondition` stays: `readsSession` uses it).

- [ ] **Step 6: Remove the scope-residual tests**

Delete `packages/authz-abac/test/model/scope-residuals.test.ts`.

In `packages/authz-abac/test/conformance.test.ts`:
- line 3 becomes `import { DefaultConditionCompiler } from '@spinajs/authz';`
- line 4 becomes `import type { Policy } from '@spinajs/authz';`
- line 5 becomes `import { FakeAdapter, FakeScopeResolver, agentPrincipal, runModelConformance, servicePrincipal, userPrincipal, worldRows } from '@spinajs/authz-testing';`
- delete L71-131 (the `O3`, `SCOPE_POLICIES`, `SCOPE_PERMISSIONS`, `scopeWorld`, `scopeFactory` block), L136-172 (the scopeResiduals `runModelConformance` and the `it('with scopeResiduals on, ...')` case) and L174-186 (the `listWarnings` case).

The `describe` body keeps only `runModelConformance('AbacModel over a memory store', factory, { timeoutMs: 120_000 });`.

- [ ] **Step 7: Docs and leftover references**

`docs/authz/README.md`, replace L455-466 (from `Config keys:` through `("ABAC scope leaves").`) with:

```markdown
Config keys: `authz.abac.policies`, `authz.abac.stores` (`ConfigPolicyStore`, `DbPolicyStore`) and
`authz.abac.connection` (default `default`). Policy writes go through `AuthzAdmin` (`policy.put`,
`policy.delete`). The app registers the model itself ([Wiring the models](#wiring-the-models)).

**Lists.** A permission declared `list: true` is list-filterable for ABAC when every policy that can
match it reads only `principal.*`, `actor.*`, `env.*` and `scope.$global.*`, and has no scope other
than `$global`. Such policies are decided once per list, before the query: a matching deny denies the
whole list, a matching permit lists every row. Boot rule 12 refuses a `list: true` permission that a
row-dependent policy can match, and `policy.put` refuses such a policy (`not_list_filterable`).
```

`docs/authz/migration-guide.md`, replace L1388-1396 (the paragraph under `### K1, K1b and A4: ...`) with:

```markdown
No change for a 2.x app. Canvas runs RBAC and ABAC with the config of design §8.5 and writes every fact
through `AuthzAdmin`. The A4 switch `authz.abac.scopeResiduals` and its residual op
`native:condition.scope` were removed with the query-rewriting list path: an ABAC comparison of
`scope.<type>.*` is decided per object by checks, and a permission whose policies read it is not
list-filterable.
```

Then, for each of these files that still exists, remove the key:
- `packages/authz-testing/test/canvas-c6/config.ts`: L60 type becomes `abac: { policies: CanvasPolicy[] };`; L227-229 become `abac: { policies: canvasPolicies() },` (drop the two comment lines above it).
- `packages/authz-testing/test/canvas-c6/config.test.ts`: in the `agents-disabled` case delete the line `scopeResiduals: true,` and rename the case to `'has the agents-disabled policy'`.
- `packages/authz-testing/fixtures/canvas-c6/config.snapshot.json`: delete the line `"scopeResiduals": true,` under `"abac"`.
- `packages/authz-orm/README.md`: delete the `### ABAC scope leaves` section (heading through the paragraph before the next `###`).

- [ ] **Step 8: Verify nothing refers to the removed names**

Run (repo root): `grep -rnE "scopeResiduals|SCOPE_CONDITION|condition\.scope|isScopeLeaf|scopeLeaves|ScopeConditionFilter|listWarnings" packages/*/src packages/*/test packages/*/fixtures docs/authz packages/authz-orm/README.md`
Expected: no output, except under `packages/authz-rbac/src/orm/` and `packages/authz-rbac/test/orm-compile/` if L7 has not merged yet (L7 deletes them; re-run after L7).

- [ ] **Step 9: Run the tests**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json test/conditions/*.test.ts`
Expected: `0 failing`.

Run: `cd packages/authz-abac && npm test`
Expected: `0 failing` (config test from Step 1 now passes).

- [ ] **Step 10: Commit**

```bash
git add -A packages/authz/src/conditions packages/authz/test/conditions packages/authz-abac docs/authz packages/authz-testing packages/authz-orm/README.md
git commit -m "refactor(authz-abac): remove scopeResiduals and the native:condition.scope leaf"
```

---

### Task 2: `listSupport` and the shared row-dependence check

**Files:**
- Create: `packages/authz-abac/src/model/list.ts`
- Modify: `packages/authz-abac/src/model/model.ts`, `packages/authz-abac/src/model/index.ts`
- Test: `packages/authz-abac/test/model/list.test.ts`

**Interfaces:**
- Consumes: `LoadedPolicy` (`policies.ts`), `ListSupport`, `PermissionDef`, `ResourceType`, `GLOBAL` (L0/core).
- Produces: `rowDependence(p: LoadedPolicy): string | undefined` (why the policy needs the row, or undefined); `AbacModel.listSupport(permission: PermissionDef, type: ResourceType): ListSupport`; `AbacModel.listProblem(policy: Omit<Policy, 'source'>): string | undefined` (Task 4's guard): loads the policy as `validate` does and names the first `list: true` permission and type it would make non-filterable.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-abac/test/model/list.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { DefaultConditionCompiler, PermissionRegistryImpl } from '@spinajs/authz';
import type { EvaluationContext, ListPlanRequest, Policy, Principal } from '@spinajs/authz';
import { agentPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, MemoryPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const alice = userPrincipal('alice', { attributes: { dept: 'ops' } });
const bob = userPrincipal('bob', { attributes: { dept: 'sales' } });

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'doc:read', types: ['doc'], list: true },
      { name: 'doc:write', types: ['doc'] },
      { name: 'doc:delete', types: ['doc'], list: true },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['doc:read'], source: 'test', ...extra });

async function modelWith(policies: readonly Policy[]): Promise<{ model: AbacModel; registry: PermissionRegistryImpl }> {
  const reg = registry();
  const model = new AbacModel({ stores: [new MemoryPolicyStore(policies)] });
  await model.init(fakeModelInitContext({ permissions: reg }));
  return { model, registry: reg };
}

const support = async (policies: readonly Policy[], permission = 'doc:read', type = 'doc') => {
  const { model, registry: reg } = await modelWith(policies);
  return model.listSupport(reg.require(permission), type);
};

describe('authz-abac: list support', () => {
  it('is true for policies that read the principal, the actor and env only', async () => {
    expect(
      await support([
        policy('p1'),
        policy('p2', { when: { attr: 'principal.attributes.dept', eq: 'ops' } }),
        policy('d1', { effect: 'deny', when: { attr: 'env.ip', eq: '10.0.0.1' } }),
        policy('a1', { actorTypes: ['agent'], when: { attr: 'actor.type', eq: 'agent' } }),
        policy('g1', { when: { attr: 'scope.$global.flags.open', eq: true } }),
        policy('s1', { scope: { type: '$global' } }),
      ]),
    ).to.equal(true);
  });

  it('refuses a permit or a deny that reads resource.*', async () => {
    expect(await support([policy('own', { when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } })])).to.deep.equal({ reason: 'abac policy "own" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
    expect(await support([policy('closed', { effect: 'deny', when: { attr: 'resource.status', eq: 'closed' } })])).to.deep.equal({ reason: 'abac policy "closed" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
  });

  it('refuses a function whose args read resource.*', async () => {
    const out = await support([policy('named', { when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'a/*' } } })]);
    expect(out).to.deep.equal({ reason: 'abac policy "named" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
  });

  it('refuses scope attributes of a node and a scoped policy', async () => {
    expect(await support([policy('frozen', { effect: 'deny', when: { attr: 'scope.org.policies.frozen', eq: true } })])).to.deep.equal({ reason: 'abac policy "frozen" (source: test) reads scope.org.* in its condition, so doc:read on "doc" is not list-filterable' });
    expect(await support([policy('org', { scope: { type: 'org', id: 'o1' } })])).to.deep.equal({ reason: 'abac policy "org" (source: test) applies under org:o1 only, so doc:read on "doc" is not list-filterable' });
  });

  it('ignores policies that cannot match the permission or the type', async () => {
    expect(await support([policy('w', { permissions: ['doc:write'], when: { attr: 'resource.x', eq: 1 } }), policy('t', { resourceTypes: ['folder'], when: { attr: 'resource.x', eq: 1 } })])).to.equal(true);
  });

  it('listProblem names the list permission a new policy would break, or nothing', async () => {
    const { model } = await modelWith([]);
    expect(model.listProblem({ id: 'n', effect: 'deny', permissions: ['doc:*'], when: { attr: 'resource.status', eq: 'x' } })).to.equal('abac policy "n" (source: db) reads resource.* in its condition, so doc:delete on "doc" is not list-filterable');
    expect(model.listProblem({ id: 'w', effect: 'permit', permissions: ['doc:write'], when: { attr: 'resource.status', eq: 'x' } })).to.equal(undefined);
    expect(model.listProblem({ id: 'ok', effect: 'permit', permissions: ['doc:read'], when: { attr: 'principal.attributes.dept', eq: 'ops' } })).to.equal(undefined);
  });
});
```

(The `listPlan` describe block of Task 3 is appended to this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npm run compile && cd ../authz-abac && npx ts-mocha -p tsconfig.json test/model/list.test.ts`
Expected: FAIL with a TSError `Property 'listSupport' does not exist on type 'AbacModel'` (or `'listProblem'`).

- [ ] **Step 3: Write `list.ts`**

Create `packages/authz-abac/src/model/list.ts`:

```ts
import { GLOBAL, resourceKey } from '@spinajs/authz';

import type { LoadedPolicy } from './policies.js';

/**
 * Why the policy's answer can differ from row to row, or undefined when it is decided by the principal,
 * the actor and env alone (design §7, lane L10 decision 1).
 */
export function rowDependence(p: LoadedPolicy): string | undefined {
  const scope = p.policy.scope;
  if (scope && scope.type !== GLOBAL.type) return `applies under ${resourceKey(scope)} only`;
  const facts = p.when?.facts;
  if (!facts) return undefined;
  if (facts.roots.includes('resource')) return 'reads resource.* in its condition';
  const node = facts.scopeTypes.find((t) => t !== GLOBAL.type);
  if (node !== undefined) return `reads scope.${node}.* in its condition`;
  return undefined;
}

export const notListFilterable = (p: LoadedPolicy, why: string, permission: string, type: string): string => `${p.where} (source: ${p.policy.source}) ${why}, so ${permission} on ${JSON.stringify(type)} is not list-filterable`;
```

- [ ] **Step 4: Add `listSupport` and `listProblem` to `AbacModel`**

In `packages/authz-abac/src/model/model.ts`, extend the core import of line 2 with nothing new, the type import (line 5) with `ListSupport`, and add:

```ts
import { notListFilterable, rowDependence } from './list.js';
```

Add these methods after `applies` (after the closing brace of `applies`, about L120):

```ts
  /** Design §7 for this model: every policy that can match the permission on the type is decided without the row. */
  listSupport(permission: PermissionDef, type: ResourceType): ListSupport {
    for (const p of this.index().candidates(permission.name, type)) {
      const why = rowDependence(p);
      if (why !== undefined) return Object.freeze({ reason: notListFilterable(p, why, permission.name, type) });
    }
    return true;
  }

  /**
   * The list permission and type a policy about to be stored would make non-filterable (policy.put's
   * ListSupportGuard), or undefined. Loads it as `validate` does, so a malformed policy throws the same way.
   */
  listProblem(policy: Omit<Policy, 'source'>, source = 'db'): string | undefined {
    if (!this.registry) throw new AuthzConfigError(`${this.name}: the model is used before init`);
    const p = loadPolicy({ ...policy, source }, 0, { source }, (c, where) => this.parser.parse(c, where));
    const why = rowDependence(p);
    if (why === undefined) return undefined;
    const index = new PolicyIndex([p], this.registry);
    for (const name of [...index.permissions()].sort()) {
      const def = this.registry.get(name);
      if (!def?.list) continue;
      const type = def.types.find((t) => index.candidates(name, t).length > 0);
      if (type !== undefined) return notListFilterable(p, why, name, type);
    }
    return undefined;
  }
```

In `packages/authz-abac/src/model/index.ts` add `export * from './list.js';`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/model/list.test.ts`
Expected: PASS, `6 passing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-abac/src/model/list.ts packages/authz-abac/src/model/model.ts packages/authz-abac/src/model/index.ts packages/authz-abac/test/model/list.test.ts
git commit -m "feat(authz-abac): listSupport refuses policies that need the row"
```

---

### Task 3: `listPlan`

**Files:**
- Modify: `packages/authz-abac/src/model/model.ts`
- Test: `packages/authz-abac/test/model/list.test.ts` (append)

**Interfaces:**
- Consumes: `ListPlanRequest` (`principal`, `actor?`, `permission`, `type`, `env?`), `ModelListPlan`, `compareDenyReasons` (core), `targets`, `scopeFilter` (`policies.ts`), `rowDependence` (Task 2).
- Produces: `AbacModel.listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan>`: `deny-all` (lowest deny reason) when a deny policy holds; else `all` when a permit holds; else `abstain`. `validUntil` is the earliest `expiresAt` of the policies that held.

- [ ] **Step 1: Append the failing tests**

Append to `packages/authz-abac/test/model/list.test.ts`:

```ts
describe('authz-abac: list plan', () => {
  const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, permissions: registry(), conditions: new DefaultConditionCompiler() });

  async function plan(policies: readonly Policy[], over: Partial<ListPlanRequest> & { principal?: Principal } = {}) {
    const { model, registry: reg } = await modelWith(policies);
    return model.listPlan({ principal: alice, permission: reg.require('doc:read'), type: 'doc', env: { now: NOW }, ...over }, ctx());
  }

  it('abstains when no policy matches', async () => {
    expect(await plan([])).to.deep.equal({ kind: 'abstain' });
    expect(await plan([policy('p', { when: { attr: 'principal.attributes.dept', eq: 'sales' } })])).to.deep.equal({ kind: 'abstain' });
  });

  it('lists every row when a permit holds for the principal', async () => {
    expect(await plan([policy('p', { when: { attr: 'principal.attributes.dept', eq: 'ops' } })])).to.deep.equal({ kind: 'all' });
    expect(await plan([policy('p', { when: { attr: 'principal.attributes.dept', eq: 'ops' } })], { principal: bob })).to.deep.equal({ kind: 'abstain' });
  });

  it('a holding deny beats a permit, with the policy reason and priority', async () => {
    const out = await plan([policy('p'), policy('mfa', { effect: 'deny', when: { attr: 'env.mfa', eq: false }, reason: 'mfa_required', priority: 50 })], { env: { now: NOW, mfa: false } });
    expect(out).to.deep.equal({ kind: 'deny-all', reason: { code: 'mfa_required', policy: 'mfa', priority: 50, sortKey: 'mfa' } });
    expect(await plan([policy('p'), policy('mfa', { effect: 'deny', when: { attr: 'env.mfa', eq: false }, reason: 'mfa_required' })], { env: { now: NOW, mfa: true } })).to.deep.equal({ kind: 'all' });
  });

  it('of several holding denies the lowest priority wins', async () => {
    const out = await plan([policy('a', { effect: 'deny', reason: 'a', priority: 300 }), policy('b', { effect: 'deny', reason: 'b', priority: 100 })]);
    expect(out).to.deep.equal({ kind: 'deny-all', reason: { code: 'b', policy: 'b', priority: 100, sortKey: 'b' } });
  });

  it('reads the actor of the request', async () => {
    const agent = agentPrincipal('ag1', alice);
    const policies = [policy('p'), policy('no-agents', { effect: 'deny', actorTypes: ['agent'], reason: 'agents_disabled' })];
    expect((await plan(policies, { actor: agent })).kind).to.equal('deny-all');
    expect(await plan(policies)).to.deep.equal({ kind: 'all' });
  });

  it('bounds the plan by the earliest expiry of the policies that held', async () => {
    const soon = new Date(NOW.getTime() + 60_000);
    const later = new Date(NOW.getTime() + 120_000);
    expect(await plan([policy('a', { expiresAt: later }), policy('b', { expiresAt: soon })])).to.deep.equal({ kind: 'all', validUntil: soon });
    expect(await plan([policy('gone', { expiresAt: new Date(NOW.getTime() - 1) })])).to.deep.equal({ kind: 'abstain' });
  });

  it('fails closed on a policy that needs the row', async () => {
    let caught: unknown;
    try {
      await plan([policy('own', { when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } })]);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).to.equal('abac policy "own" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable');
  });
});
```

- [ ] **Step 2: Run to verify the new cases fail**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/model/list.test.ts`
Expected: FAIL, TSError `Property 'listPlan' does not exist on type 'AbacModel'`.

- [ ] **Step 3: Implement `listPlan`**

In `packages/authz-abac/src/model/model.ts` add `compareDenyReasons` to the value import of line 2, and `ListPlanRequest`, `ModelListPlan` to the type import of line 5. Add after `listProblem`:

```ts
  /**
   * Design §6.2 for ABAC: every candidate policy is decided now for the principal, actor and env of
   * the request (overview decision 8), so the plan is deny-all, all or abstain and never holds terms.
   */
  async listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan> {
    await this.upTo(this.generation);
    const permission = req.permission.name;
    const request: DecisionRequest = { principal: req.principal, ...(req.actor ? { actor: req.actor } : {}), permission, resource: { type: req.type }, env: req.env ?? { now: ctx.now } };
    const held: LoadedPolicy[] = [];
    for (const p of this.index().candidates(permission, req.type)) {
      if (!targets(p, request, ctx.now)) continue;
      const why = rowDependence(p);
      if (why !== undefined) throw new Error(notListFilterable(p, why, permission, req.type));
      if (!p.when) {
        held.push(p);
        continue;
      }
      const c = await this.compile(p, request, ctx);
      if (c.filter.op === 'true') held.push(p);
      else if (c.filter.op !== 'false') throw new Error(`${p.where}: its condition is not decided before the query (${JSON.stringify(c.filter)})`);
    }
    const expiries = held.flatMap((p) => (p.expiresAt ? [p.expiresAt.getTime()] : []));
    const bound = expiries.length > 0 ? { validUntil: new Date(Math.min(...expiries)) } : {};
    const denies = held.filter((p) => p.policy.effect === 'deny').map((p) => reasonOf({ p, when: TRUE, needsSubject: false }));
    if (denies.length > 0) return Object.freeze({ kind: 'deny-all', reason: Object.freeze(denies.sort(compareDenyReasons)[0]), ...bound });
    if (held.some((p) => p.policy.effect === 'permit')) return Object.freeze({ kind: 'all', ...bound });
    return Object.freeze({ kind: 'abstain' });
  }
```

The deny-all `validUntil` from a permit's expiry is harmless (it only shortens the plan's life).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/model/list.test.ts`
Expected: PASS, `13 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-abac/src/model/model.ts packages/authz-abac/test/model/list.test.ts
git commit -m "feat(authz-abac): listPlan decides principal, actor and env policies before the query"
```

---

### Task 4: `ListSupportGuard` for `policy.put`

**Files:**
- Create: `packages/authz-abac/src/admin/list-guard.ts`
- Modify: `packages/authz-abac/src/admin/index.ts`
- Test: `packages/authz-abac/test/admin/list-guard.test.ts`

**Interfaces:**
- Consumes: L2 Task 7 `ListSupportGuard` (`abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void>`, refuse by throwing; `ListSupportValidator` runs it for `policy.put` / `rule.put` only and passes an `AuthzAdminFailure` through), `abacModels(ctx)` (`admin/common.ts:41`), `AbacModel.listProblem` (Task 2).
- Produces: `AbacListSupportGuard` registered at import with `@Singleton() @Injectable(ListSupportGuard)`; refuses with `AuthzAdminFailure('not_list_filterable', <listProblem text>, 'policy')`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-abac/test/admin/list-guard.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { AuthzAdminFailure, ListSupportGuard, PermissionRegistryImpl } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzService } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { AbacListSupportGuard, AbacModel, MemoryPolicyStore } from '../../src/index.js';

const expect = chai.expect;

async function context(): Promise<AdminContext> {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc'], list: true }, { name: 'doc:write', types: ['doc'] }], 'test');
  registry.freeze();
  const model = new AbacModel({ stores: [new MemoryPolicyStore([])] });
  await model.init(fakeModelInitContext({ permissions: registry }));
  return { domain: 'root', now: new Date('2026-10-14T12:00:00.000Z'), authz: { models: () => [model] } as unknown as AuthzService };
}

const put = (policy: Record<string, unknown>): AuthzCommand => ({ kind: 'policy.put', policy: { effect: 'permit', permissions: ['doc:read'], ...policy } as never });

async function refusal(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected a refusal');
}

describe('authz-abac: AbacListSupportGuard', () => {
  it('is registered as a ListSupportGuard at import', async () => {
    const guards = (await DI.resolve(Array.ofType(ListSupportGuard))) as ListSupportGuard[];
    expect(guards.some((g) => g instanceof AbacListSupportGuard)).to.equal(true);
  });

  it('refuses a policy that reads the row on a list permission', async () => {
    const e = await refusal(new AbacListSupportGuard().checkCommand(put({ id: 'own', when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } }), await context()));
    expect(e.code).to.equal('not_list_filterable');
    expect(e.field).to.equal('policy');
    expect(e.message).to.equal('abac policy "own" (source: db) reads resource.* in its condition, so doc:read on "doc" is not list-filterable');
  });

  it('accepts a row-dependent policy on a permission without list, and any principal-level policy', async () => {
    const guard = new AbacListSupportGuard();
    await guard.checkCommand(put({ id: 'w', permissions: ['doc:write'], when: { attr: 'resource.status', eq: 'x' } }), await context());
    await guard.checkCommand(put({ id: 'p', when: { attr: 'principal.attributes.dept', eq: 'ops' } }), await context());
    await guard.checkCommand({ kind: 'rule.put', rule: { id: 'r', kind: 'cap', scope: { type: '$global' } } } as AuthzCommand, await context());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/admin/list-guard.test.ts`
Expected: FAIL, TSError `Module '"../../src/index.js"' has no exported member 'AbacListSupportGuard'`.

- [ ] **Step 3: Implement the guard**

Create `packages/authz-abac/src/admin/list-guard.ts`:

```ts
import { AuthzAdminFailure, ListSupportGuard } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, Policy } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { abacModels } from './common.js';

/** Design §7 at write time: policy.put may not make a `list: true` permission need the row. */
@Singleton()
@Injectable(ListSupportGuard)
export class AbacListSupportGuard extends ListSupportGuard {
  async checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind !== 'policy.put') return;
    for (const model of abacModels(ctx)) {
      const problem = model.listProblem(c.policy as Omit<Policy, 'source'>);
      if (problem !== undefined) throw new AuthzAdminFailure('not_list_filterable', problem, 'policy');
    }
  }
}
```

In `packages/authz-abac/src/admin/index.ts` add `export * from './list-guard.js';` after the `forgetter.js` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-abac && npx ts-mocha -p tsconfig.json test/admin/list-guard.test.ts`
Expected: PASS, `3 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-abac/src/admin/list-guard.ts packages/authz-abac/src/admin/index.ts packages/authz-abac/test/admin/list-guard.test.ts
git commit -m "feat(authz-abac): refuse policy.put that makes a list permission need the row"
```

---

### Task 5: Lane verification

**Files:** none (fix-ups only).

- [ ] **Step 1: Packages**

Run: `cd packages/authz && npm test` — Expected: `0 failing` in each mocha run.
Run: `cd packages/authz-abac && npm test` — Expected: `0 failing`.
Run: `cd packages/authz-testing && npm test` — Expected: `0 failing`.

- [ ] **Step 2: Lint**

Run: `cd packages/authz-abac && npx eslint -c .eslintrc.cjs --ext .ts src/model/list.ts src/model/model.ts src/admin/list-guard.ts`
Expected: no errors.

- [ ] **Step 3: API snapshot**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: passes (no snapshotted file changed). If it reports the removed `SCOPE_CONDITION_*` exports because `src/conditions/contracts.ts` re-exports them, add `docs/plans/authz-v3-rfc/RA10-1.md` ("remove the ABAC scope-residual leaf; design §4.4, §9"), run `node scripts/api-snapshot.mjs --update` and commit both together.

- [ ] **Step 4: Commit any fix-ups**

```bash
git add -A packages/authz packages/authz-abac
git commit -m "chore(authz-abac): lane L10 verification fixes"
```

---

## Contract issues found

1. **Accepted (overview decision 17): design §7 is narrower than what ABAC can plan.** It refuses only conditions that read `resource.*`; a condition on `scope.<type>.*` (a node other than `$global`) and a policy with a node `scope` also differ per row and ABAC has no `PlanTermSql` compiler for them. This lane refuses both too (decision 1). If lists over scoped ABAC policies are wanted, ABAC needs its own plan term (an `under`-style op over `authz_resource_ancestor`), which L4 would render.
2. **Policies stored before a permission becomes `list: true`** are not seen by the `policy.put` guard; `listSupport` sees DB policies only as loaded at boot. `listPlan` throws on such a policy (decision 3), which L2 turns into `deny-all` `model_error`: fail closed, but the list is a 500/403 until the policy is fixed.
3. **None blocking with L2:** `ListSupportGuard` is used exactly as L2 Task 7 defines it; the guard throws `AuthzAdminFailure('not_list_filterable', …, 'policy')`, which `ListSupportValidator` passes through.
