# Lane L2: engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane.

**Goal:** Give `@spinajs/authz` the engine half of resource access: `accessPlan` (list plans combined from the models), `checkAll` (many single-object checks with batched ancestor and row loads), boot rule 12 (list permissions must be plannable), the write-time list-support validator for `policy.put` / `rule.put`, `forgetScopesInTx` for deletes outside `AuthzAdmin`, and the `AccessChangeRouter` that turns `AuthzChange`s into client pushes.

**Architecture:** All engine work sits in `Authorizer` (`packages/authz/src/engine/authorizer.ts`) next to `check`/`checkMany`, reusing its principal gate, delegation, ceilings, route table, request-scope L1 and model contexts. The pure plan combination lives in a new `engine/plan.ts`. Host wiring (`DefaultAuthzService`, root-only router start) goes in `host/service.ts` and a new `host/push.ts`. Admin pieces (`ListSupportGuard` registry + validator, `forgetScopesInTx`) live in `admin/`.

**Tech Stack:** TypeScript (node16 modules), `@spinajs/di`, mocha + ts-mocha + chai 4.

**Depends on:** L0 merged (G0): `PermissionDef.list`, `PermissionInput.list`, `contracts/plan.ts` (`PlanTerm`, `ModelListPlan`, `AccessPlan`, `ListSupport`, `ListPlanRequest`), `AuthorizationModel.listSupport?` / `listPlan?`, `ResourceAdapter.loadMany?` / `ancestorsMany?`, `AuthzService.checkAll` / `accessPlan`, `AccessChangedEvent`, `ChangeAudience`, `AccessPushTransport`, `DEFAULT_DENY_PRIORITY.role_denied`. L0 must also have kept every `AuthzService` subclass compiling (it adds abstract members): this lane assumes `DefaultAuthzService` either has no `checkAll`/`accessPlan` yet or has throwing stubs from L0, and replaces them.

**Blocks:** L4 (`authz().accessPlan` behind `.accessible()` / `withAccess`), L3 (`forgetScopesInTx` in the delete clean-up), L8 and L10 (`ListSupportGuard` to register; boot rule 12 their models must pass), L11 (`checkAll` for `POST /user/access/checks`; `AccessChangeRouter` feeding the SSE transport), L13 (router feeding the socket transport), L9.

## Global Constraints

- All code, comments, identifiers and commit messages in English; comments only where a reader would ask "why?" (no restating code, no history).
- Match the surrounding code: `Object.freeze` on returned values, `AuthzConfigError` for misconfiguration, `AuthzAdminFailure(code, message, field?)` for refused admin commands, `@Singleton()` / `@Injectable(Token)` registrations.
- Tests: mocha + chai `expect`; engine tests import `../../src/...`; host and admin tests import the built `@spinajs/authz`, so run `npm run compile` in `packages/authz` before them.
- One file: `cd packages/authz && npx ts-mocha -p tsconfig.json test/<path>.test.ts`; host tests add `--config .mocharc.host.json`, admin tests `--config .mocharc.admin.json`.
- No file under `packages/authz/src/contracts/` is edited in this lane (L0 owns them). No API snapshot change: nothing here is in a snapshotted file.
- Commit after every task with a conventional message.

## Decisions made in this lane

1. **Delegation in `accessPlan`.** `check()` under `intersect` runs the delegate's own check and ANDs its residual into ours (`authorizer.ts:950-975`). A plan's permit terms are an OR-list, so two principals' plans cannot be ANDed: an intersect delegate gets `{ kind: 'none', reason: { code: 'delegate', priority: 200, delegate } }`. Under `inherit`, `check()` runs the models as the narrowed delegate copy with every ceiling of the chain (`resolveDelegation`, `delegation.ts:146-161`); `accessPlan` does the same. A forbidden delegate gives the resolution's own `delegate` denial.
2. **Ceilings.** The plan uses `ceilingOutcome` at the type-level ref `{ type }`, as a type-level `check()` does: a failing ceiling (permissions, expiry, `resources: []`) is `none` with its reason, and no model is asked; a `resources` ceiling becomes `within`; `expiresAt` joins `validUntil`. Two resource ceilings in one inherit chain intersect, which one `within` list cannot express: that plan is `none` with `ceiling` (fail closed; overview decision 9).
3. **Model faults** (listPlan throws, rejects, times out after `modelTimeoutMs`, sets `ctx` fault, or returns a malformed plan) become a `deny-all` with `{ code: 'model_error', model }`, the same fail-closed rule as an indeterminate vote under deny-overrides (B04). A faulted plan is never memoised.
4. **A routed model that cannot plan** (no `listSupport`, an answer other than `true`, or no `listPlan`) and a route algorithm other than `deny-overrides` throw `AuthzConfigError` at call time; boot rule 12 normally refuses both at boot.
5. **Plan cache:** request-scope L1 only, key `l1Key('plan', domain, JSON.stringify([principalState(principal), permission, type, versionVector]))`, dropped by `invalidate()` through the generation check (same rule as `CachedDecision`). No L2. A call with a caller `env` is not memoised: env facts (IP, user agent) are not part of the key, as votes that read env are `cacheable: false` in `check()`.
10. **`ListPlanRequest.env` and `actor`** (overview: accepted from this lane's contract issue 1) are built as `check()` builds its `DecisionRequest` (`authorizer.ts:1626-1631`): `env` is `envOf(env, run.instant)` (a frozen copy whose `now` is the engine instant, always present), `actor` is `delegation.actor` (the agent under `inherit`; absent otherwise, since `accessPlan` takes no request actor).
6. **`checkAll` loads rows in a second pass.** Pass 1 checks every request without a subject, after one `ancestorsMany` call per type has filled the L1 ancestor entries. Pass 2 takes the decisions that are allowed with a residual (only they need the row), loads their rows with one `loadMany` call per type (else `load` per ref), and checks them again with `subject: row`, as `authz-http`'s `subject: 'load'` does (`authz-http/src/access/policy.ts:113-116`). A missing row denies with `unknown_resource`, a failed load with `model_error`; with no loader the decision stays conditional. A missing key in an `ancestorsMany` answer counts as `null` (unknown resource), like a missing `loadMany` key. A failed `ancestorsMany` falls back to `ancestors()` per ref. `checkAll` answers an entry with an unregistered permission, or a type outside the permission's types (a type registered after boot included), with a denial `{ code: 'invalid_request' }` instead of throwing (no registry accessor on `AuthzService` needed, no contract change); a non-object entry or malformed ref still throws `AuthzConfigError`.
7. **Boot rule 12** needs no new `BootInput` field: `registry` carries `list`, and the route table is already compiled in `validateBoot`.
8. **`ListSupportGuard`** (`admin/list-guard.ts`, not snapshotted): `abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void>`. A guard refuses by throwing. The built-in `ListSupportValidator` (an `AuthzCommandValidator`) runs every guard for `policy.put` and `rule.put` only; an `AuthzAdminFailure` or `AuthzConfigError` passes through as is, any other error becomes `AuthzAdminFailure('not_list_filterable', its message, 'policy' | 'rule')`.
9. **`AccessChangeRouter`** resolves transports and audiences from the root container per change (so ones registered after boot count). Tags containing `'*'` (or a malformed change) go to `'*'` without asking any audience; no audience registered also means `'*'`. Principals are the sorted union of every audience's answer (`'*'` if any says `'*'`); `objects` is the union only when every audience answered with `objects`. An audience that throws or answers malformed widens the push to `'*'` (logged). An empty principal list pushes nothing. Each transport's failure is logged, never thrown. **Convention for audiences (L8):** a change that does not concern an audience is answered `{ principals: [], objects: [] }`, which leaves the union exact.

## Files

- Create: `packages/authz/src/engine/plan.ts` (plan combination, model-plan reader, `withinOf`)
- Modify: `packages/authz/src/engine/context.ts:29` (`l1Key` kind `'plan'`)
- Modify: `packages/authz/src/engine/authorizer.ts` (imports L1-33, `CachedPlan` + `RowLoad` after L219, constants after L270, `checkAll` + `accessPlan` after `checkMany` L432, private helpers after `customPlan` L847, module helpers at the end)
- Modify: `packages/authz/src/engine/validate.ts` (`Rule` L44, doc L88, guard call after L161, new `checkListPermissions`)
- Modify: `packages/authz/src/host/service.ts` (imports, `Booted` L51-66, `checkAll` / `accessPlan` after `checkMany` L190-192, `dispose` L242-247, boot tail L506-523)
- Create: `packages/authz/src/host/push.ts` (`AccessChangeRouter`)
- Modify: `packages/authz/src/host/index.ts` (export `push.js`)
- Modify: `packages/authz/src/admin/forget.ts` (extract `forgetNode`, add `forgetScopesInTx`)
- Create: `packages/authz/src/admin/list-guard.ts` (`ListSupportGuard`, `ListSupportValidator`)
- Modify: `packages/authz/src/admin/index.ts` (export `list-guard.js`)
- Modify: `packages/authz/test/engine/fakes.ts` (`ListModel`, `LoadingAdapter`, `BatchAdapter`, `FakeAdapter.chain` / `rowsByKey`)
- Create tests: `test/engine/plan.test.ts`, `test/engine/access-plan.test.ts`, `test/engine/check-all.test.ts`, `test/engine/validate-list.test.ts`, `test/host/access.test.ts`, `test/host/push.test.ts`, `test/admin/list-guard.test.ts`, `test/admin/forget-in-tx.test.ts` (all under `packages/authz/`)

---

### Task 1: Plan combination (`engine/plan.ts`)

**Files:**
- Create: `packages/authz/src/engine/plan.ts`
- Test: `packages/authz/test/engine/plan.test.ts`

**Interfaces:**
- Consumes (L0): `AccessPlan`, `ModelListPlan` (its `all` variant has `deny?: readonly PlanTerm[]`), `PlanTerm` from `contracts/plan.ts`; `compareDenyReasons`, `DenyReason` from `contracts/decision.ts`.
- Produces (used by Task 2): `ALL_PLAN: AccessPlan`, `NO_ACCESS: DenyReason`, `CEILING_DENIAL: DenyReason`, `nonePlan(reason: DenyReason): AccessPlan`, `interface PlanAnswer { model: string; plan: ModelListPlan }`, `combinePlans(answers: readonly PlanAnswer[], bounds?: { within?: readonly ResourceRef[]; validUntil?: Date }): AccessPlan`, `readModelPlan(raw: unknown): ModelListPlan` (throws `VoteFault` on a malformed plan), `withinOf(restrict: ResourceFilter): readonly ResourceRef[] | undefined | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz/test/engine/plan.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { ALL_PLAN, combinePlans, nonePlan, readModelPlan, withinOf } from '../../src/engine/plan.js';
import type { PlanAnswer } from '../../src/engine/plan.js';
import { TRUE } from '../../src/index.js';
import type { ModelListPlan, PlanTerm, ResourceFilter } from '../../src/index.js';

const expect = chai.expect;

const t = (op: string, args: unknown = {}): PlanTerm => ({ op, args });
const ans = (model: string, plan: ModelListPlan): PlanAnswer => ({ model, plan });
const terms = (permit: PlanTerm[], deny: PlanTerm[] = [], validUntil?: Date): ModelListPlan => (validUntil ? { kind: 'terms', permit, deny, validUntil } : { kind: 'terms', permit, deny });

function deepFrozen(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v !== 'object' || seen.has(v)) return true;
  seen.add(v);
  if (!Object.isFrozen(v)) return false;
  return Object.values(v as object).every((x) => deepFrozen(x, seen));
}

describe('access plan combination', () => {
  describe('combinePlans', () => {
    it('no answer at all is none with no_access (H16)', () => {
      expect(combinePlans([])).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
    });

    it('abstentions alone are none with no_access', () => {
      expect(combinePlans([ans('a', { kind: 'abstain' }), ans('b', { kind: 'abstain' })])).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
    });

    it('deny terms without any permit are none with no_access', () => {
      expect(combinePlans([ans('a', terms([], [t('x.deny')]))])).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
    });

    it('concatenates the permit and deny terms in answer order', () => {
      const plan = combinePlans([ans('a', terms([t('a.1'), t('a.2')], [t('a.d')])), ans('b', { kind: 'abstain' }), ans('c', terms([t('c.1')], [t('c.d')]))]);
      expect(plan).to.deep.equal({ kind: 'filter', permit: [t('a.1'), t('a.2'), t('c.1')], deny: [t('a.d'), t('c.d')] });
    });

    it('one all makes the permit unfiltered and keeps every deny term', () => {
      expect(combinePlans([ans('a', { kind: 'all' }), ans('b', terms([t('b.1')], [t('b.d')]))])).to.deep.equal({ kind: 'filter', permit: 'all', deny: [t('b.d')] });
    });

    it('an all with deny terms is still an unfiltered permit, and its deny terms join the others', () => {
      const plan = combinePlans([ans('rbac', { kind: 'all', deny: [t('rbac.deny')] }), ans('abac', terms([t('abac.1')], [t('abac.d')]))]);
      expect(plan).to.deep.equal({ kind: 'filter', permit: 'all', deny: [t('rbac.deny'), t('abac.d')] });
    });

    it('a deny-all wins over every permit and names its model', () => {
      expect(combinePlans([ans('a', { kind: 'all' }), ans('b', { kind: 'deny-all', reason: { code: 'mfa_required' } })])).to.deep.equal({ kind: 'none', reason: { code: 'mfa_required', model: 'b' } });
    });

    it('of several deny-alls the lowest (priority, sortKey) reason wins', () => {
      const plan = combinePlans([ans('a', { kind: 'deny-all', reason: { code: 'no_access' } }), ans('b', { kind: 'deny-all', reason: { code: 'blocked', priority: 150 } }), ans('c', { kind: 'deny-all', reason: { code: 'x', priority: 900 } })]);
      expect(plan).to.deep.equal({ kind: 'none', reason: { code: 'blocked', priority: 150, model: 'b' } });
    });

    it('keeps the model a reason already names', () => {
      expect(combinePlans([ans('a', { kind: 'deny-all', reason: { code: 'x', model: 'inner' } })])).to.deep.equal({ kind: 'none', reason: { code: 'x', model: 'inner' } });
    });

    it('takes the earliest validUntil of the answers and the bounds', () => {
      const plan = combinePlans([ans('a', { kind: 'all', validUntil: new Date(3000) }), ans('b', terms([t('b')], [], new Date(2000)))], { validUntil: new Date(2500) });
      expect(plan).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], validUntil: new Date(2000) });
    });

    it('carries within from the bounds', () => {
      const within = [{ type: 'folder', id: 'f1' }];
      expect(combinePlans([ans('a', { kind: 'all' })], { within })).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], within });
    });

    it('returns a deeply frozen plan', () => {
      expect(deepFrozen(combinePlans([ans('a', terms([t('a', { k: [1] })], [t('d')]))], { within: [{ type: 'f', id: '1' }] }))).to.equal(true);
    });
  });

  describe('readModelPlan', () => {
    it('copies and freezes each kind', () => {
      const args = { subjects: ['user:1'] };
      const read = readModelPlan({ kind: 'terms', permit: [{ op: 'rbac.assignment', args }], deny: [], validUntil: new Date(5) });
      expect(read).to.deep.equal({ kind: 'terms', permit: [{ op: 'rbac.assignment', args: { subjects: ['user:1'] } }], deny: [], validUntil: new Date(5) });
      expect((read as { permit: PlanTerm[] }).permit[0].args).to.not.equal(args);
      expect(deepFrozen(read)).to.equal(true);
      expect(readModelPlan({ kind: 'abstain' })).to.deep.equal({ kind: 'abstain' });
      expect(readModelPlan({ kind: 'all' })).to.deep.equal({ kind: 'all' });
      expect(readModelPlan({ kind: 'all', deny: [{ op: 'rbac.deny', args: {} }] })).to.deep.equal({ kind: 'all', deny: [{ op: 'rbac.deny', args: {} }] });
      expect(readModelPlan({ kind: 'deny-all', reason: { code: 'role_denied', role: 'blocked' } })).to.deep.equal({ kind: 'deny-all', reason: { code: 'role_denied', role: 'blocked' } });
    });

    it('refuses a malformed plan', () => {
      const bad: unknown[] = [
        null,
        {},
        { kind: 'some' },
        { kind: 'terms', permit: 'x', deny: [] },
        { kind: 'terms', permit: [], deny: undefined },
        { kind: 'terms', permit: [{ args: 1 }], deny: [] },
        { kind: 'terms', permit: [{ op: 'x', args: () => 1 }], deny: [] },
        { kind: 'deny-all' },
        { kind: 'deny-all', reason: {} },
        { kind: 'all', validUntil: 'tomorrow' },
        { kind: 'all', deny: 'x' },
      ];
      for (const raw of bad) expect(() => readModelPlan(raw), JSON.stringify(raw) ?? String(raw)).to.throw();
    });
  });

  it('withinOf reads TRUE as no restriction, under as its scopes and anything else as not expressible', () => {
    const f1 = { type: 'folder', id: 'f1' };
    expect(withinOf(TRUE)).to.equal(undefined);
    expect(withinOf({ op: 'under', scopes: [f1] })).to.deep.equal([f1]);
    const both = { op: 'and', args: [{ op: 'under', scopes: [f1] }, { op: 'under', scopes: [{ type: 'folder', id: 'f2' }] }] } as ResourceFilter;
    expect(withinOf(both)).to.equal(null);
  });

  it('ALL_PLAN and nonePlan are frozen, and nonePlan copies the reason', () => {
    expect(ALL_PLAN).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
    expect(deepFrozen(ALL_PLAN)).to.equal(true);
    const reason = { code: 'x' };
    const none = nonePlan(reason);
    expect(none).to.deep.equal({ kind: 'none', reason: { code: 'x' } });
    expect((none as { reason: unknown }).reason).to.not.equal(reason);
    expect(deepFrozen(none)).to.equal(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/plan.test.ts`
Expected: FAIL, ts-node cannot resolve `../../src/engine/plan.js` (`Cannot find module` / TSError).

- [ ] **Step 3: Write the implementation**

Create `packages/authz/src/engine/plan.ts`:

```ts
import { compareDenyReasons } from '../contracts/decision.js';
import type { DenyReason } from '../contracts/decision.js';
import type { ResourceFilter } from '../contracts/filter.js';
import type { AccessPlan, ModelListPlan, PlanTerm } from '../contracts/plan.js';
import type { ResourceRef } from '../contracts/principal.js';
import { VoteFault, budget, copyData, validDate } from './vote.js';
import type { Budget } from './vote.js';

/** Values copied from one model's plan: an RBAC term carries up to authz.rbac.maxPlanSubjects keys. */
const MAX_PLAN_VALUES = 100_000;

export interface PlanAnswer {
  readonly model: string;
  readonly plan: ModelListPlan;
}

type FilterPlan = Extract<AccessPlan, { readonly kind: 'filter' }>;

export const ALL_PLAN: AccessPlan = Object.freeze({ kind: 'filter', permit: 'all', deny: Object.freeze([]) });
export const NO_ACCESS: DenyReason = Object.freeze({ code: 'no_access' });
export const CEILING_DENIAL: DenyReason = Object.freeze({ code: 'ceiling', priority: 200 });
const ABSTAIN: ModelListPlan = Object.freeze({ kind: 'abstain' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

export function nonePlan(reason: DenyReason): AccessPlan {
  return Object.freeze({ kind: 'none', reason: Object.freeze({ ...reason }) });
}

/** Deny-overrides over the models' plans (resource-access plan decision 8); H16: no permit at all is `none`. */
export function combinePlans(answers: readonly PlanAnswer[], bounds: { readonly within?: readonly ResourceRef[]; readonly validUntil?: Date } = {}): AccessPlan {
  const denials: DenyReason[] = [];
  const permit: PlanTerm[] = [];
  const deny: PlanTerm[] = [];
  const until: (Date | undefined)[] = [bounds.validUntil];
  let all = false;
  for (const { model, plan } of answers) {
    switch (plan.kind) {
      case 'deny-all':
        denials.push(plan.reason.model === undefined ? { ...plan.reason, model } : plan.reason);
        break;
      case 'all':
        all = true;
        deny.push(...(plan.deny ?? []));
        until.push(plan.validUntil);
        break;
      case 'terms':
        permit.push(...plan.permit);
        deny.push(...plan.deny);
        until.push(plan.validUntil);
        break;
      case 'abstain':
        break;
    }
  }
  if (denials.length > 0) return nonePlan(denials.sort(compareDenyReasons)[0]);
  if (!all && permit.length === 0) return nonePlan(NO_ACCESS);
  const out: { -readonly [K in keyof FilterPlan]: FilterPlan[K] } = { kind: 'filter', permit: all ? 'all' : Object.freeze(permit), deny: Object.freeze(deny) };
  if (bounds.within !== undefined) out.within = Object.freeze(bounds.within.map((r) => Object.freeze({ ...r })));
  const validUntil = earliest(until);
  if (validUntil !== undefined) out.validUntil = validUntil;
  return Object.freeze(out);
}

/** A frozen copy of what a model's listPlan returned; throws VoteFault when it is not a ModelListPlan of plain data. */
export function readModelPlan(raw: unknown): ModelListPlan {
  if (!isObject(raw)) throw new VoteFault(`a list plan must be an object, got ${raw === null ? 'null' : typeof raw}`);
  const kind = raw.kind;
  const values = budget(MAX_PLAN_VALUES);
  switch (kind) {
    case 'abstain':
      return ABSTAIN;
    case 'all': {
      const plan: ModelListPlan = { kind: 'all', ...(raw.deny === undefined ? {} : { deny: readTerms(raw.deny, 'deny', values) }), ...until(raw.validUntil) };
      return Object.freeze(plan);
    }
    case 'deny-all': {
      const reason = raw.reason;
      if (!isObject(reason) || typeof reason.code !== 'string' || reason.code === '') throw new VoteFault('a deny-all plan needs a reason with a non-empty code');
      const plan: ModelListPlan = { kind: 'deny-all', reason: copyData(reason, true, values) as DenyReason };
      return Object.freeze(plan);
    }
    case 'terms': {
      const plan: ModelListPlan = { kind: 'terms', permit: readTerms(raw.permit, 'permit', values), deny: readTerms(raw.deny, 'deny', values), ...until(raw.validUntil) };
      return Object.freeze(plan);
    }
    default:
      throw new VoteFault(`unknown list plan kind ${typeof kind === 'string' ? JSON.stringify(kind) : typeof kind}`);
  }
}

/** A ceiling's restriction as one `within` list: undefined when it restricts nothing, null when it is not one `under` (two resource ceilings intersect). */
export function withinOf(restrict: ResourceFilter): readonly ResourceRef[] | undefined | null {
  if (restrict.op === 'true') return undefined;
  if (restrict.op === 'under') return restrict.scopes;
  return null;
}

function until(v: unknown): { readonly validUntil?: Date } {
  if (v === undefined) return {};
  const date = validDate(v);
  if (date === undefined) throw new VoteFault('validUntil must be a valid Date');
  return { validUntil: date };
}

function readTerms(v: unknown, what: string, values: Budget): readonly PlanTerm[] {
  if (!Array.isArray(v)) throw new VoteFault(`${what} must be an array of terms`);
  return Object.freeze(
    v.map((term: unknown) => {
      if (!isObject(term) || typeof term.op !== 'string' || term.op === '') throw new VoteFault(`${what} holds a term without an op`);
      return Object.freeze({ op: term.op, args: copyData(term.args, true, values) });
    }),
  );
}

function earliest(dates: readonly (Date | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const d of dates) if (d !== undefined && (best === undefined || d.getTime() < best.getTime())) best = d;
  return best === undefined ? undefined : validDate(best);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/plan.test.ts`
Expected: PASS, `16 passing`, `0 failing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz/src/engine/plan.ts packages/authz/test/engine/plan.test.ts
git commit -m "feat(authz): access plan combination (deny-overrides over model list plans)"
```

---

### Task 2: `Authorizer.accessPlan`

**Files:**
- Modify: `packages/authz/src/engine/context.ts:29`
- Modify: `packages/authz/src/engine/authorizer.ts` (imports, after L219, after L432, after L847)
- Modify: `packages/authz/test/engine/fakes.ts` (imports L1-2; append `ListModel`)
- Test: `packages/authz/test/engine/access-plan.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; L0 `AuthorizationModel.listSupport?(permission: PermissionDef, type: ResourceType): ListSupport`, `listPlan?(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan>`, `PermissionDef.list?: boolean`.
- Produces: `Authorizer.accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>, scope?: RequestScope): Promise<AccessPlan>` (Task 5 wires it into `DefaultAuthzService`); `ListPlanRequest` passed to models carries `env` (always, with `now`) and `actor` (inherit agent only); test fake `ListModel(name, { listSupport?, listPlan?, ...StaticModelOptions })` with `planCalls: { req; ctx }[]`.

- [ ] **Step 1: Add the `ListModel` fake**

In `packages/authz/test/engine/fakes.ts` replace line 2:

```ts
import type { DecisionRequest, EvaluationContext, ListPlanRequest, ListSupport, ModelCapabilities, ModelListPlan, PermissionDef, Principal, PrincipalType, ResourceFilter, ResourceRef, ResourceType, Trace, Vote } from '../../src/index.js';
```

and insert after the `StaticModel` class (after line 63):

```ts
export interface ListModelOptions extends StaticModelOptions {
  /** Default true. */
  readonly listSupport?: ListSupport | ((def: PermissionDef, type: ResourceType) => ListSupport);
  /** Default abstain; a function's result is returned as is (a promise, a throw, a malformed value). */
  readonly listPlan?: ModelListPlan | ((req: ListPlanRequest, ctx: EvaluationContext) => unknown);
}

/** A StaticModel that plans lists; StaticModel itself has no listSupport, so it cannot. */
export class ListModel extends StaticModel {
  readonly planCalls: { readonly req: ListPlanRequest; readonly ctx: EvaluationContext }[] = [];

  constructor(name: string, private readonly list: ListModelOptions = {}) {
    super(name, list);
  }

  listSupport(def: PermissionDef, type: ResourceType): ListSupport {
    const support = this.list.listSupport ?? true;
    return typeof support === 'function' ? support(def, type) : support;
  }

  listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan> {
    this.planCalls.push({ req, ctx });
    const plan = this.list.listPlan ?? { kind: 'abstain' };
    return Promise.resolve().then(() => (typeof plan === 'function' ? plan(req, ctx) : plan)) as Promise<ModelListPlan>;
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/authz/test/engine/access-plan.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { AuthzConfigError, SYSTEM, UNATTENDED, UnknownPermission } from '../../src/index.js';
import type { ListPlanRequest, ModelListPlan, PlanTerm } from '../../src/index.js';
import { ListModel, RecordingLog, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc', 'folder'], list: true },
  { name: 'doc:write', types: ['doc'] },
]);

const alice = principal('user', 'alice');
const term = (op: string, args: unknown = {}): PlanTerm => ({ op, args });

let log: RecordingLog;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  log = new RecordingLog();
  clock = fakeClock();
});

const make = (models: ListModel[], options: Partial<AuthorizerOptions> = {}): Authorizer => new Authorizer({ domain: 'root', models, registry: REG, clock: clock.clock, log, ...options });
const planner = (name: string, plan: ModelListPlan | ((req: ListPlanRequest) => unknown)): ListModel => new ListModel(name, { listPlan: plan });

async function rejectsWith(p: Promise<unknown>, type: abstract new (...args: never[]) => Error, pattern?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).to.be.instanceOf(type);
  if (pattern) expect((caught as Error).message).to.match(pattern);
}

describe('Authorizer.accessPlan', () => {
  describe('refusals', () => {
    it('throws UnknownPermission for an unregistered permission', async () => {
      await rejectsWith(make([]).accessPlan(alice, 'doc:delete', 'doc'), UnknownPermission);
    });

    it('throws AuthzConfigError for a permission not declared list: true', async () => {
      await rejectsWith(make([]).accessPlan(alice, 'doc:write', 'doc'), AuthzConfigError, /list: true/);
    });

    it('throws AuthzConfigError for a type outside the permission types, $global included', async () => {
      await rejectsWith(make([]).accessPlan(alice, 'doc:read', 'task'), AuthzConfigError, /not in its types/);
      await rejectsWith(make([]).accessPlan(alice, 'doc:read', '$global'), AuthzConfigError, /not in its types/);
    });

    it('throws AuthzConfigError when a routed model cannot plan the permission', async () => {
      await rejectsWith(make([new ListModel('m', { listSupport: { reason: 'reads rows' } })]).accessPlan(alice, 'doc:read', 'doc'), AuthzConfigError, /model "m" cannot plan lists of doc:read on "doc"/);
    });

    it('throws AuthzConfigError when the type is routed with another algorithm than deny-overrides', async () => {
      const a = make([planner('m', { kind: 'all' })], { combine: { default: { algorithm: 'deny-overrides' }, types: { doc: { algorithm: 'permit-overrides' } } } });
      await rejectsWith(a.accessPlan(alice, 'doc:read', 'doc'), AuthzConfigError, /deny-overrides only/);
    });
  });

  describe('principal gate and delegation', () => {
    it('SYSTEM gets an unfiltered plan without asking a model', async () => {
      const m = planner('m', { kind: 'deny-all', reason: { code: 'x' } });
      expect(await make([m]).accessPlan(SYSTEM, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
      expect(m.planCalls).to.have.length(0);
    });

    it('UNATTENDED gets none with unattended', async () => {
      const m = planner('m', { kind: 'all' });
      expect(await make([m]).accessPlan(UNATTENDED, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'unattended' } });
      expect(m.planCalls).to.have.length(0);
    });

    it('an anonymous principal is planned for like any other', async () => {
      const m = planner('m', { kind: 'all' });
      expect(await make([m]).accessPlan(principal('anonymous', 'anonymous', { authenticated: false }), 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
      expect(m.planCalls[0].req.principal.type).to.equal('anonymous');
    });

    it('an intersect delegate gets none with delegate, since plans cannot be ANDed', async () => {
      const m = planner('m', { kind: 'all' });
      const agent = principal('agent', 'bot', { onBehalfOf: alice });
      expect(await make([m]).accessPlan(agent, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'delegate', priority: 200, delegate: 'user:alice' } });
      expect(m.planCalls).to.have.length(0);
    });

    it('under inherit the models plan for the delegate', async () => {
      const m = planner('m', (req) => ({ kind: 'terms', permit: [term('owner', { id: req.principal.id })], deny: [] }));
      const agent = principal('agent', 'bot', { onBehalfOf: alice, delegation: 'inherit' });
      expect(await make([m]).accessPlan(agent, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: [term('owner', { id: 'alice' })], deny: [] });
      expect(m.planCalls[0].req.principal.type).to.equal('user');
    });

    it('under inherit the agent is the request actor; without delegation there is none', async () => {
      const m = planner('m', { kind: 'all' });
      const a = make([m]);
      await a.accessPlan(principal('agent', 'bot', { onBehalfOf: alice, delegation: 'inherit' }), 'doc:read', 'doc');
      expect(m.planCalls[0].req.actor?.type).to.equal('agent');
      expect(m.planCalls[0].req.actor?.id).to.equal('bot');
      await a.accessPlan(alice, 'doc:read', 'doc');
      expect(m.planCalls[1].req.actor).to.equal(undefined);
    });
  });

  describe('env', () => {
    it('passes the caller env as check() does: a frozen copy whose now is the engine instant', async () => {
      const m = planner('m', { kind: 'all' });
      const env = { ip: '10.0.0.1', now: new Date('1999-01-01T00:00:00.000Z') };
      await make([m]).accessPlan(alice, 'doc:read', 'doc', env);
      const seen = m.planCalls[0].req.env!;
      expect(seen.ip).to.equal('10.0.0.1');
      expect((seen.now as Date).toISOString()).to.equal('2026-10-01T12:00:00.000Z');
      expect(Object.isFrozen(seen)).to.equal(true);
      expect(seen).to.not.equal(env);
    });

    it('gives an env with only now when the caller passes none, and is not memoised when the caller passes one', async () => {
      const m = planner('m', { kind: 'all' });
      const a = make([m]);
      const scope = { cache: new Map<string, unknown>() };
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(Object.keys(m.planCalls[0].req.env!)).to.deep.equal(['now']);
      await a.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.1' }, scope);
      await a.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.2' }, scope);
      expect(m.planCalls).to.have.length(3);
    });
  });

  describe('combination', () => {
    it('is none with no_access when no model is routed for the permission', async () => {
      expect(await make([]).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
      const elsewhere = new ListModel('m', { applies: () => false, listPlan: { kind: 'all' } });
      expect(await make([elsewhere]).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
      expect(elsewhere.planCalls).to.have.length(0);
    });

    it('concatenates the models terms in route order, and a deny-all wins', async () => {
      const a = make([planner('rbac', { kind: 'terms', permit: [term('rbac.assignment')], deny: [term('rbac.deny')] }), planner('owner', { kind: 'terms', permit: [term('relation.column')], deny: [] })]);
      expect(await a.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: [term('rbac.assignment'), term('relation.column')], deny: [term('rbac.deny')] });
      const b = make([planner('rbac', { kind: 'all' }), planner('abac', { kind: 'deny-all', reason: { code: 'mfa_required' } })]);
      expect(await b.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'mfa_required', model: 'abac' } });
    });

    it('skips a model that does not serve the principal type', async () => {
      const svc = new ListModel('svc', { capabilities: { principalTypes: ['service'] }, listPlan: { kind: 'all' } });
      expect(await make([svc]).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'no_access' } });
      expect(svc.planCalls).to.have.length(0);
    });

    it('passes the permission, the type and an evaluation context of the domain', async () => {
      const m = planner('m', { kind: 'all' });
      await make([m]).accessPlan(alice, 'doc:read', 'folder');
      const { req, ctx } = m.planCalls[0];
      expect(req.permission.name).to.equal('doc:read');
      expect(req.type).to.equal('folder');
      expect(ctx.domain).to.equal('root');
      expect(ctx.now.toISOString()).to.equal('2026-10-01T12:00:00.000Z');
    });
  });

  describe('ceilings', () => {
    it('a ceiling whose permissions miss the permission is none with its reason, and no model is asked', async () => {
      const m = planner('m', { kind: 'all' });
      const p = principal('user', 'alice', { ceiling: { permissions: ['doc:write'], reason: 'token_scope' } });
      expect(await make([m]).accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'token_scope', priority: 200 } });
      expect(m.planCalls).to.have.length(0);
    });

    it('resource ceilings become within; a type-wide one restricts nothing; an empty one covers nothing', async () => {
      const a = make([planner('m', { kind: 'all' })]);
      const f1 = { type: 'folder', id: 'f1' };
      expect(await a.accessPlan(principal('user', 'alice', { ceiling: { resources: [f1] } }), 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], within: [f1] });
      expect(await a.accessPlan(principal('user', 'alice', { ceiling: { resources: [{ type: 'doc' }] } }), 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [] });
      expect(await a.accessPlan(principal('user', 'alice', { ceiling: { resources: [] } }), 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'ceiling', priority: 200 } });
    });

    it('an expired ceiling is none with ceiling', async () => {
      const m = planner('m', { kind: 'all' });
      const p = principal('user', 'alice', { ceiling: { expiresAt: new Date('2026-10-01T11:00:00.000Z') } });
      expect(await make([m]).accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'ceiling', priority: 200 } });
      expect(m.planCalls).to.have.length(0);
    });

    it('validUntil is the earliest of the ceiling expiry and the models', async () => {
      const p = principal('user', 'alice', { ceiling: { expiresAt: new Date('2026-10-01T14:00:00.000Z') } });
      const sooner = make([planner('m', { kind: 'all', validUntil: new Date('2026-10-01T13:00:00.000Z') })]);
      expect(await sooner.accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], validUntil: new Date('2026-10-01T13:00:00.000Z') });
      const later = make([planner('m', { kind: 'all', validUntil: new Date('2026-10-01T15:00:00.000Z') })]);
      expect(await later.accessPlan(p, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: 'all', deny: [], validUntil: new Date('2026-10-01T14:00:00.000Z') });
    });

    it('two resource ceilings of one inherit chain are none with ceiling (one within list cannot intersect them)', async () => {
      const delegate = principal('user', 'alice', { ceiling: { resources: [{ type: 'folder', id: 'f2' }] } });
      const agent = principal('agent', 'bot', { onBehalfOf: delegate, delegation: 'inherit', ceiling: { resources: [{ type: 'folder', id: 'f1' }] } });
      expect(await make([planner('m', { kind: 'all' })]).accessPlan(agent, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'ceiling', priority: 200 } });
    });
  });

  describe('faults', () => {
    for (const [what, plan] of [
      ['rejects', () => Promise.reject(new Error('store down'))],
      ['returns a malformed plan', () => ({ kind: 'terms', permit: 'everything', deny: [] })],
      ['returns nothing', () => undefined],
    ] as const) {
      it(`a model that ${what} makes the plan none with model_error, logged`, async () => {
        const a = make([planner('ok', { kind: 'all' }), planner('m', plan)]);
        expect(await a.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'model_error', model: 'm' } });
        expect(log.at('error').map((e) => e.message).join('\n')).to.match(/model "m" failed to plan doc:read on "doc"/);
      });
    }

    it('a model past modelTimeoutMs makes the plan none with model_error', async () => {
      const slow = planner('slow', () => new Promise((resolve) => setTimeout(() => resolve({ kind: 'all' }), 50)));
      expect(await make([slow], { config: { modelTimeoutMs: 20 } }).accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'model_error', model: 'slow' } });
    });

    it('a deny-all reason with a lower priority than model_error still wins', async () => {
      const a = make([planner('a', { kind: 'deny-all', reason: { code: 'blocked', priority: 100 } }), planner('m', () => Promise.reject(new Error('down')))]);
      expect(await a.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'none', reason: { code: 'blocked', priority: 100, model: 'a' } });
    });
  });

  describe('memo', () => {
    it('is memoised per request scope and type, and dropped by invalidate()', async () => {
      const m = planner('m', { kind: 'all' });
      const a = make([m]);
      const scope = { cache: new Map<string, unknown>() };
      const first = await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope)).to.equal(first);
      expect(m.planCalls).to.have.length(1);
      await a.accessPlan(alice, 'doc:read', 'folder', undefined, scope);
      expect(m.planCalls).to.have.length(2);
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, { cache: new Map() });
      expect(m.planCalls).to.have.length(3);
      a.invalidate(['*']);
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(m.planCalls).to.have.length(4);
    });

    it('a faulted plan is not memoised', async () => {
      const m = planner('m', () => Promise.reject(new Error('store down')));
      const a = make([m]);
      const scope = { cache: new Map<string, unknown>() };
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      await a.accessPlan(alice, 'doc:read', 'doc', undefined, scope);
      expect(m.planCalls).to.have.length(2);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/access-plan.test.ts`
Expected: FAIL with a TSError `Property 'accessPlan' does not exist on type 'Authorizer'`.

- [ ] **Step 4: Add the `'plan'` L1 kind**

In `packages/authz/src/engine/context.ts` replace line 29:

```ts
export const l1Key = (kind: 'ancestors' | 'attributes' | 'nodes' | 'model' | 'decision' | 'plan' | 'generation' | 'fault' | 'preloaded', domain: string, key: string): string => `\u0000authz\u0000${kind}\u0000${domain}\u0000${key}`;
```

- [ ] **Step 5: Add imports and the cache entry to the Authorizer**

In `packages/authz/src/engine/authorizer.ts`, after line 4 (`import type { CombiningAlgorithm, ... } from '../contracts/decision.js';`) add:

```ts
import { compareDenyReasons } from '../contracts/decision.js';
import type { AccessPlan, ListPlanRequest, ModelListPlan } from '../contracts/plan.js';
```

After line 33 (`import { MAX_DATA_VALUES, ... } from './vote.js';`) add:

```ts
import { ALL_PLAN, CEILING_DENIAL, combinePlans, nonePlan, readModelPlan, withinOf } from './plan.js';
import type { PlanAnswer } from './plan.js';
```

After the `CachedDecision` class (after line 219) add:

```ts
/** An L1 access plan; `generation` makes an invalidate drop it too. */
class CachedPlan {
  constructor(
    readonly plan: AccessPlan,
    readonly generation: number,
  ) {}
}
```

- [ ] **Step 6: Add `accessPlan`**

In `packages/authz/src/engine/authorizer.ts`, after `checkMany` (after line 432) add:

```ts
  /**
   * Design §6.2: the routed models' listPlan answers combined with deny-overrides, under the
   * principal's ceilings. Throws like check() for an unknown permission or a type outside its
   * types, and AuthzConfigError for a permission not declared `list: true`. PlanTerms are OR-ed,
   * so an intersect delegate (whose decision check() ANDs in) gets `none` with `delegate`.
   */
  async accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>, scope?: RequestScope): Promise<AccessPlan> {
    const def = this.requirePermission(permission);
    if (def.list !== true) throw new AuthzConfigError(`${this.where}: permission ${quote(def.name)} is not declared with list: true, so it has no access plan`);
    this.refuseLateType(type);
    if (!def.types.includes(type)) throw new AuthzConfigError(`${this.where}: permission ${quote(def.name)} is planned on type ${quote(type)}, which is not in its types (${def.types.join(', ')})`);
    const gate = this.principalGate(principal);
    if (gate.kind === 'system') return ALL_PLAN;
    if (gate.kind === 'deny') return nonePlan(gate.reason);
    const run = this.newRun(false, scope);
    const delegation = this.delegation(gate.principal, undefined, run.delegationBudget);
    if (delegation.denial) return nonePlan(delegation.denial);
    if (delegation.intersect !== undefined) return nonePlan({ code: 'delegate', priority: DELEGATE_PRIORITY, delegate: delegation.intersectKey });
    // Env facts are not in the key, so a call with a caller env is never memoised.
    const key = env === undefined ? this.planKey(gate.principal, def, type, run) : undefined;
    const hit = key === undefined ? undefined : this.cachedPlan(key, run);
    if (hit) return hit;
    const built = await this.buildPlan(delegation, def, type, this.envOf(env, run.instant), run);
    if (key !== undefined && !built.faulted) run.scope.set(key, new CachedPlan(built.plan, run.generation));
    return built.plan;
  }
```

- [ ] **Step 7: Add the private plan helpers**

In `packages/authz/src/engine/authorizer.ts`, after `customPlan` (after line 847, before `// ---- the check pipeline (design §10.1) ----`) add:

```ts
  // ---- accessPlan ----

  /** undefined when nothing may be cached for this call (a model version() that fails, a principal without canonical state). */
  private planKey(principal: Principal, def: PermissionDef, type: ResourceType, run: Run): string | undefined {
    if (run.versions === undefined) return undefined;
    const state = principalState(principal);
    return state === undefined ? undefined : l1Key('plan', this.domain, JSON.stringify([state, def.name, type, run.versions]));
  }

  private cachedPlan(key: string, run: Run): AccessPlan | undefined {
    const entry = run.scope.get(key);
    if (!(entry instanceof CachedPlan) || entry.generation !== this.generation) return undefined;
    const until = entry.plan.kind === 'filter' ? entry.plan.validUntil : undefined;
    return until !== undefined && until.getTime() <= run.instant.getTime() ? undefined : entry.plan;
  }

  private async buildPlan(d: Delegation, def: PermissionDef, type: ResourceType, env: Readonly<Record<string, unknown>>, run: Run): Promise<{ readonly plan: AccessPlan; readonly faulted: boolean }> {
    const ceiling = this.ceilingOf(d, def, { type }, undefined, run.instant);
    if (ceiling.denials.length > 0) return { plan: nonePlan([...ceiling.denials].sort(compareDenyReasons)[0]), faulted: false };
    const within = withinOf(ceiling.restrict);
    if (within === null) return { plan: nonePlan(CEILING_DENIAL), faulted: false };
    const route = this.table.get(def.name, type) ?? { algorithm: 'deny-overrides', models: [] };
    if (route.algorithm !== 'deny-overrides') throw new AuthzConfigError(`${this.where}: list permission ${quote(def.name)} is routed on type ${quote(type)} with ${quote(route.algorithm)}; access plans combine with deny-overrides only (boot rule 12)`);
    const runAs = d.principal;
    const req: ListPlanRequest = Object.freeze(d.actor === undefined ? { principal: runAs, permission: def, type, env } : { principal: runAs, actor: d.actor, permission: def, type, env });
    const host = this.hostFor(run);
    const cacheId = principalCacheId(runAs);
    const label = `${def.name} on ${quote(type)}`;
    const answers = await Promise.all(route.models.filter((m) => admits(m, runAs)).map((m) => this.modelPlan(m, req, new ModelContext(host, m.name, run.scope, run.instant, 0, undefined, contextCacheKey(m.name, cacheId, 'listPlan')), label)));
    const bounds = { ...(within ? { within } : {}), ...(ceiling.expiresAt ? { validUntil: ceiling.expiresAt } : {}) };
    return { plan: combinePlans(answers, bounds), faulted: answers.some((a) => a.faulted) || run.nested.faulted };
  }

  /** A failure, a timeout, a ctx fault or a malformed plan is a deny-all with model_error: fail closed like an indeterminate vote (B04). */
  private async modelPlan(model: AuthorizationModel, req: ListPlanRequest, ctx: ModelContext, label: string): Promise<PlanAnswer & { readonly faulted: boolean }> {
    let support: unknown;
    try {
      support = typeof model.listSupport === 'function' ? model.listSupport(req.permission, req.type) : undefined;
    } catch (e) {
      throw new AuthzConfigError(`${this.where}: model ${quote(model.name)} threw from listSupport() for ${label}: ${describeError(e)}`, { cause: e });
    }
    if (support !== true || typeof model.listPlan !== 'function') throw new AuthzConfigError(`${this.where}: model ${quote(model.name)} cannot plan lists of ${label} (boot rule 12)`);
    const settled = await settleWithin(
      Promise.resolve().then(() => model.listPlan!(req, ctx)),
      this.config.modelTimeoutMs,
      describeError,
      'listPlan',
    );
    let fault: string | undefined;
    let plan: ModelListPlan | undefined;
    if (!settled.ok) fault = settled.error;
    else if (ctx.fault !== undefined) fault = ctx.fault;
    else {
      try {
        plan = readModelPlan(settled.value);
      } catch (e) {
        fault = `listPlan returned a malformed plan: ${describeError(e)}`;
      }
    }
    if (plan !== undefined) return { model: model.name, plan, faulted: false };
    this.logAt('error', `${this.where}: model ${quote(model.name)} failed to plan ${label}: ${fault}`);
    ctx.detachMemo();
    return { model: model.name, plan: Object.freeze({ kind: 'deny-all', reason: Object.freeze({ code: 'model_error', model: model.name }) }), faulted: true };
  }
```

`envOf` is the private method `check()` uses (L1634-1637; it throws `AuthzConfigError` for a non-object env). `admits`, `principalCacheId` and `contextCacheKey` are module functions of the same file (L1931, L1972, L2002); `principalState`, `settleWithin`, `describeError`, `ModelContext`, `l1Key` and `Delegation` are already imported (L22-33).

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/access-plan.test.ts`
Expected: PASS, `29 passing`, `0 failing`.

- [ ] **Step 9: Run the engine suite for regressions**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json`
Expected: `0 failing`.

- [ ] **Step 10: Commit**

```bash
git add packages/authz/src/engine/context.ts packages/authz/src/engine/authorizer.ts packages/authz/test/engine/fakes.ts packages/authz/test/engine/access-plan.test.ts
git commit -m "feat(authz): Authorizer.accessPlan, list plans under the gate, delegation and ceilings"
```

---

### Task 3: `Authorizer.checkAll`

**Files:**
- Modify: `packages/authz/src/engine/authorizer.ts` (constants after L270, `checkAll` after `accessPlan`, helpers after Task 2's block, module helpers at the end)
- Modify: `packages/authz/test/engine/fakes.ts` (`FakeAdapter` L87-140; append `LoadingAdapter`, `BatchAdapter`)
- Test: `packages/authz/test/engine/check-all.test.ts`

**Interfaces:**
- Consumes: L0 `ResourceAdapter.loadMany?(refs): Promise<ReadonlyMap<string, unknown>>`, `ancestorsMany?(refs): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>>`.
- Produces: `Authorizer.checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[], scope?: RequestScope): Promise<readonly Decision[]>` (input order). An entry with an unregistered permission, or a type outside the permission's types (or a type registered after boot), is answered with a denied `Decision` (`reason: { code: 'invalid_request' }`, `residual: FALSE`) instead of throwing, so L11 needs no pre-validation and no registry accessor (no contract change). A non-object entry or a malformed ref still throws `AuthzConfigError`: L11 checks the wire shape itself. Ancestor L1 key: `l1Key('ancestors', domain, resourceKey(ref))`.

- [ ] **Step 1: Extend the adapter fakes**

In `packages/authz/test/engine/fakes.ts`, inside `FakeAdapter`, replace the field `private readonly parents = new Map<string, ResourceRef | null>();` (line 92) with:

```ts
  private readonly parents = new Map<string, ResourceRef | null>();
  protected readonly rowsByKey = new Map<string, FakeRow>();
```

replace `add` (lines 103-105) with:

```ts
  add(row: FakeRow): void {
    const key = resourceKey({ type: row.$type, id: row.id });
    this.parents.set(key, row.$parent ?? null);
    this.rowsByKey.set(key, row);
  }
```

and replace `ancestors` (lines 117-130) with:

```ts
  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    this.ancestorCalls.push(ref);
    return this.chain(ref);
  }

  /** [self, parent, ..., GLOBAL] without recording a call; null for an unknown node. */
  protected chain(ref: ResourceRef): ResourceRef[] | null {
    if (ref.id === undefined) return [ref, GLOBAL];
    const key = resourceKey(ref);
    if (!this.parents.has(key)) return null;
    const out: ResourceRef[] = [ref];
    let parent = this.parents.get(key) ?? null;
    while (parent && out.length < 32) {
      out.push(parent);
      parent = this.parents.get(resourceKey(parent)) ?? null;
    }
    out.push(GLOBAL);
    return out;
  }
```

Append after the `FakeAdapter` class:

```ts
/** A FakeAdapter that loads its rows one at a time. */
export class LoadingAdapter extends FakeAdapter {
  readonly loadCalls: ResourceRef[] = [];

  async load(ref: ResourceRef): Promise<unknown | null> {
    this.loadCalls.push(ref);
    return this.rowsByKey.get(resourceKey(ref)) ?? null;
  }
}

export interface BatchAdapterOptions extends FakeAdapterOptions {
  readonly failAncestorsMany?: boolean;
  readonly failLoadMany?: boolean;
}

/** A LoadingAdapter with the batch methods. */
export class BatchAdapter extends LoadingAdapter {
  readonly ancestorsManyCalls: (readonly ResourceRef[])[] = [];
  readonly loadManyCalls: (readonly ResourceRef[])[] = [];

  constructor(types: readonly ResourceType[], private readonly batch: BatchAdapterOptions = {}) {
    super(types, batch);
  }

  async ancestorsMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> {
    this.ancestorsManyCalls.push(refs);
    if (this.batch.failAncestorsMany) throw new Error('ancestor store down');
    return new Map(refs.map((r) => [resourceKey(r), this.chain(r)]));
  }

  async loadMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>> {
    this.loadManyCalls.push(refs);
    if (this.batch.failLoadMany) throw new Error('row store down');
    const out = new Map<string, unknown>();
    for (const r of refs) {
      const row = this.rowsByKey.get(resourceKey(r));
      if (row) out.set(resourceKey(r), row);
    }
    return out;
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/authz/test/engine/check-all.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { l1Key } from '../../src/engine/context.js';
import { FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { DecisionRequest, ResourceAdapter, ResourceFilter, ResourceRef, Vote } from '../../src/index.js';
import { BatchAdapter, FakeAdapter, FakeRow, LoadingAdapter, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'task:read', types: ['task'] },
]);

const alice = principal('user', 'alice');
const owner = (): ResourceFilter => ({ op: 'cmp', field: 'owner', cmp: 'eq', value: { ref: 'principal.id' } });
/** doc:read is unconditional; task:read holds on the rows alice owns. */
const model = (): StaticModel => new StaticModel('m', { vote: (req: DecisionRequest): Vote => ({ model: 'm', permitWhen: req.permission === 'doc:read' ? TRUE : owner(), denyWhen: FALSE, cacheable: true }) });

const d1: ResourceRef = { type: 'doc', id: 'd1' };
const d9: ResourceRef = { type: 'doc', id: 'd9' };
const t1: ResourceRef = { type: 'task', id: 't1' };
const t2: ResourceRef = { type: 'task', id: 't2' };
const docRows = (): FakeRow[] => [new FakeRow('doc', 'd1'), new FakeRow('doc', 'd2')];
const taskRows = (): FakeRow[] => [new FakeRow('task', 't1', { owner: 'alice' }), new FakeRow('task', 't2', { owner: 'bob' })];
const BATCH = [
  { permission: 'task:read', resource: t1 },
  { permission: 'doc:read', resource: d1 },
  { permission: 'task:read', resource: t2 },
  { permission: 'doc:read', resource: d9 },
];

let log: RecordingLog;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  log = new RecordingLog();
  clock = fakeClock();
});

const make = (adapters: ResourceAdapter[], options: Partial<AuthorizerOptions> = {}): Authorizer => new Authorizer({ domain: 'root', models: [model()], registry: REG, adapters, clock: clock.clock, log, ...options });

describe('Authorizer.checkAll', () => {
  it('answers in input order, each as check() would with the loaded row', async () => {
    const out = await make([new BatchAdapter(['doc'], { kind: 'docs', rows: docRows() }), new BatchAdapter(['task'], { kind: 'tasks', rows: taskRows() })]).checkAll(alice, BATCH);
    expect(out.map((d) => [d.permission, d.resource.id, d.allowed, d.residual.op])).to.deep.equal([
      ['task:read', 't1', true, 'true'],
      ['doc:read', 'd1', true, 'true'],
      ['task:read', 't2', false, 'false'],
      ['doc:read', 'd9', false, 'false'],
    ]);
    expect(out[3].reason?.code).to.equal('unknown_resource');
    const single = make([new BatchAdapter(['task'], { rows: taskRows() })]);
    expect(out[2].reason).to.deep.equal((await single.check({ principal: alice, permission: 'task:read', resource: t2, subject: taskRows()[1] })).reason);
    expect(Object.isFrozen(out)).to.equal(true);
  });

  it('asks each adapter for its ancestors once, with ancestorsMany', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const tasks = new BatchAdapter(['task'], { rows: taskRows() });
    await make([docs, tasks]).checkAll(alice, BATCH);
    expect(docs.ancestorsManyCalls).to.deep.equal([[d1, d9]]);
    expect(tasks.ancestorsManyCalls).to.deep.equal([[t1, t2]]);
    expect(docs.ancestorCalls).to.deep.equal([]);
    expect(tasks.ancestorCalls).to.deep.equal([]);
  });

  it('loads only the rows of conditional decisions, once per type', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const tasks = new BatchAdapter(['task'], { rows: taskRows() });
    await make([docs, tasks]).checkAll(alice, BATCH);
    expect(tasks.loadManyCalls).to.deep.equal([[t1, t2]]);
    expect(docs.loadManyCalls).to.deep.equal([]);
    expect(tasks.loadCalls).to.deep.equal([]);
  });

  it('fills the shared request scope with the ancestors', async () => {
    const scope = { cache: new Map<string, unknown>() };
    await make([new BatchAdapter(['doc'], { rows: docRows() })]).checkAll(alice, [{ permission: 'doc:read', resource: d1 }, { permission: 'doc:read', resource: d9 }], scope);
    expect(scope.cache.get(l1Key('ancestors', 'root', 'doc:d1'))).to.deep.equal([d1, GLOBAL]);
    expect(scope.cache.get(l1Key('ancestors', 'root', 'doc:d9'))).to.equal(null);
  });

  it('asks about a ref named twice once', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const out = await make([docs]).checkAll(alice, [{ permission: 'doc:read', resource: d1 }, { permission: 'doc:read', resource: d1 }]);
    expect(out.map((d) => d.allowed)).to.deep.equal([true, true]);
    expect(docs.ancestorsManyCalls).to.deep.equal([[d1]]);
  });

  it('does not batch type-level refs', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const out = await make([docs]).checkAll(alice, [{ permission: 'doc:read', resource: { type: 'doc' } }]);
    expect(out[0].allowed).to.equal(true);
    expect(docs.ancestorsManyCalls).to.deep.equal([]);
  });

  it('falls back to ancestors() and load() per ref without the batch methods', async () => {
    const tasks = new LoadingAdapter(['task'], { rows: taskRows() });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: t1 }, { permission: 'task:read', resource: t2 }]);
    expect(out.map((d) => d.allowed)).to.deep.equal([true, false]);
    expect(tasks.ancestorCalls).to.deep.equal([t1, t2]);
    expect(tasks.loadCalls).to.deep.equal([t1, t2]);
  });

  it('leaves a decision conditional when the adapter cannot load rows', async () => {
    const out = await make([new FakeAdapter(['task'], { rows: taskRows() })]).checkAll(alice, [{ permission: 'task:read', resource: t1 }]);
    expect(out[0].allowed).to.equal(true);
    expect(out[0].residual.op).to.equal('cmp');
  });

  it('denies with unknown_resource when loadMany has no row for a known node', async () => {
    const tasks = new BatchAdapter(['task'], { rows: taskRows(), nodes: { 'task:t3': null } });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: { type: 'task', id: 't3' } }]);
    expect(out[0].allowed).to.equal(false);
    expect(out[0].reason).to.deep.equal({ code: 'unknown_resource' });
  });

  it('denies the conditional decisions with model_error when loadMany fails, and logs it', async () => {
    const tasks = new BatchAdapter(['task'], { rows: taskRows(), failLoadMany: true });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: t1 }]);
    expect(out[0].allowed).to.equal(false);
    expect(out[0].residual).to.deep.equal(FALSE);
    expect(out[0].reason).to.deep.equal({ code: 'model_error' });
    expect(log.at('error').map((e) => e.message).join('\n')).to.match(/loadMany/);
  });

  it('falls back to ancestors() per ref when ancestorsMany fails, and logs it', async () => {
    const tasks = new BatchAdapter(['task'], { rows: taskRows(), failAncestorsMany: true });
    const out = await make([tasks]).checkAll(alice, [{ permission: 'task:read', resource: t1 }, { permission: 'task:read', resource: t2 }]);
    expect(out.map((d) => d.allowed)).to.deep.equal([true, false]);
    expect(tasks.ancestorCalls).to.deep.equal([t1, t2]);
    expect(log.at('error').map((e) => e.message).join('\n')).to.match(/ancestorsMany/);
  });

  it('answers invalid_request for an unregistered permission or a type outside its types, and checks the rest', async () => {
    const docs = new BatchAdapter(['doc'], { rows: docRows() });
    const out = await make([docs]).checkAll(alice, [
      { permission: 'doc:nope', resource: d1 },
      { permission: 'doc:read', resource: t1 },
      { permission: 'doc:read', resource: d1 },
    ]);
    expect(out.map((d) => [d.permission, d.allowed, d.reason?.code])).to.deep.equal([
      ['doc:nope', false, 'invalid_request'],
      ['doc:read', false, 'invalid_request'],
      ['doc:read', true, undefined],
    ]);
    expect(out[0].residual).to.deep.equal(FALSE);
    expect(docs.ancestorsManyCalls).to.deep.equal([[d1]]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/check-all.test.ts`
Expected: FAIL with a TSError `Property 'checkAll' does not exist on type 'Authorizer'`.

- [ ] **Step 4: Add the row-load type and constants**

In `packages/authz/src/engine/authorizer.ts`, after the `CachedPlan` class from Task 2 add:

```ts
/** checkAll's second pass: the row, no row (unknown resource), or a failed load. */
type RowLoad = { readonly kind: 'row'; readonly row: unknown } | { readonly kind: 'missing' } | { readonly kind: 'failed' };
```

After line 270 (`const UNATTENDED_REF ...`) add:

```ts
const UNKNOWN_RESOURCE: DenyReason = Object.freeze({ code: 'unknown_resource' });
const INVALID_REQUEST: DenyReason = Object.freeze({ code: 'invalid_request' });
const MISSING_ROW: RowLoad = Object.freeze({ kind: 'missing' });
const FAILED_ROW: RowLoad = Object.freeze({ kind: 'failed' });
```

- [ ] **Step 5: Add `checkAll`**

After `accessPlan` (Task 2, Step 6) add:

```ts
  /**
   * Many single-object checks of one principal over one request scope, in input order (resource-access
   * plan decision 3). One ancestorsMany call per type fills the L1 before the checks. A decision allowed
   * with a residual is checked again against its row, as authz-http's `subject: 'load'` does: one loadMany
   * call per type (else load per ref); no row denies with unknown_resource, a failed load with model_error;
   * an adapter that cannot load leaves the decision conditional. An unregistered permission or a type the
   * permission cannot be checked on is a denial with invalid_request, so one bad entry never fails the batch.
   */
  async checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[], scope?: RequestScope): Promise<readonly Decision[]> {
    if (!Array.isArray(requests)) throw new AuthzConfigError(`${this.where}: checkAll requests must be an array`);
    const out: Decision[] = [];
    const items = (requests as readonly unknown[]).map((r, i) => {
      if (!isObject(r)) throw new AuthzConfigError(`${this.where}: checkAll request ${i} must be an object`);
      const ref = this.requireRef(r.resource);
      const def = typeof r.permission === 'string' ? this.registry.get(r.permission) : undefined;
      if (!def || this.lateType(ref.type) !== undefined || (ref.type !== GLOBAL_TYPE && !def.types.includes(ref.type))) {
        out[i] = this.invalidRequest(principal, r.permission, ref);
        return undefined;
      }
      return { def, ref };
    });
    const shared: RequestScope = { cache: scopeMap(scope) };
    await this.prefillAncestors(
      items.flatMap((x) => (x ? [x.ref] : [])),
      shared.cache!,
    );
    const check = async (def: PermissionDef, ref: ResourceRef, subject: unknown): Promise<Decision> => (await runAsync(this.pipeline({ principal, permission: def.name }, this.newRun(false, shared), { ref, subject }))).decision;
    for (const [i, x] of items.entries()) if (x) out[i] = await check(x.def, x.ref, undefined);
    const conditional = items.flatMap((x, i) => (x && out[i].allowed && out[i].residual.op !== 'true' && x.ref.id !== undefined ? [i] : []));
    if (conditional.length > 0) {
      const rows = await this.loadRows(conditional.map((i) => items[i]!.ref));
      for (const i of conditional) {
        const { def, ref } = items[i]!;
        const got = rows.get(resourceKey(ref));
        if (got === undefined) continue;
        if (got.kind === 'failed') out[i] = deniedCopy(out[i], ENGINE_FAULT);
        else if (got.kind === 'missing') out[i] = deniedCopy(out[i], UNKNOWN_RESOURCE);
        else out[i] = await check(def, ref, got.row);
      }
    }
    return Object.freeze(out);
  }

  /** The denial checkAll answers for an entry check() would throw on (UnknownPermission, AuthzConfigError). */
  private invalidRequest(principal: unknown, permission: unknown, ref: ResourceRef): Decision {
    const gate = this.principalGate(principal);
    const who = gate.kind === 'system' ? SYSTEM_REF : gate.kind === 'deny' ? gate.principal : gate.ref;
    return deepFreeze({ allowed: false, permission: String(permission), resource: ref, principal: who, residual: FALSE, fields: NO_FIELDS, roles: NO_ROLES, reason: { ...INVALID_REQUEST }, domain: this.domain });
  }
```

- [ ] **Step 6: Add the batch-load helpers**

After `modelPlan` (Task 2, Step 7) add:

```ts
  // ---- checkAll ----

  /** One ancestorsMany call per type for the refs with an id the L1 lacks; a failure leaves them to ancestors() per ref. */
  private async prefillAncestors(refs: readonly ResourceRef[], scope: Map<string, unknown>): Promise<void> {
    const pending = refs.filter((r) => r.id !== undefined && !scope.has(l1Key('ancestors', this.domain, resourceKey(r))));
    await Promise.all(
      [...byType(pending)].map(async ([type, list]) => {
        const adapter = this.adapterByType.get(type);
        if (!adapter || typeof adapter.ancestorsMany !== 'function') return;
        const settled = await settleWithin(
          Promise.resolve().then(() => adapter.ancestorsMany!(list)),
          this.config.modelTimeoutMs,
          describeError,
          'ancestorsMany',
        );
        if (!settled.ok || !(settled.value instanceof Map)) {
          this.logAt('error', `${this.where}: ancestorsMany of adapter ${quote(adapter.kind)} for ${list.length} ${quote(type)} ref(s) failed, asking ancestors() per ref: ${settled.ok ? 'it did not return a Map' : settled.error}`);
          return;
        }
        const found = settled.value as ReadonlyMap<string, unknown>;
        for (const ref of list) {
          const key = resourceKey(ref);
          try {
            scope.set(l1Key('ancestors', this.domain, key), this.ancestorList(found.get(key) ?? null, ref));
          } catch (e) {
            this.logAt('error', `${this.where}: ancestorsMany of adapter ${quote(adapter.kind)} answered a malformed list for ${key}, asking ancestors(): ${describeError(e)}`);
          }
        }
      }),
    );
  }

  /** Rows by resourceKey; a type whose adapter has neither loadMany nor load is left out. */
  private async loadRows(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, RowLoad>> {
    const out = new Map<string, RowLoad>();
    const rowOf = (v: unknown): RowLoad => (v === undefined || v === null ? MISSING_ROW : { kind: 'row', row: v });
    await Promise.all(
      [...byType(refs)].map(async ([type, list]) => {
        const adapter = this.adapterByType.get(type);
        if (adapter && typeof adapter.loadMany === 'function') {
          const settled = await settleWithin(
            Promise.resolve().then(() => adapter.loadMany!(list)),
            this.config.modelTimeoutMs,
            describeError,
            'loadMany',
          );
          const found = settled.ok && settled.value instanceof Map ? (settled.value as ReadonlyMap<string, unknown>) : undefined;
          if (!found) this.logAt('error', `${this.where}: loadMany of adapter ${quote(adapter.kind)} for ${list.length} ${quote(type)} row(s) failed: ${settled.ok ? 'it did not return a Map' : settled.error}`);
          for (const ref of list) out.set(resourceKey(ref), found ? rowOf(found.get(resourceKey(ref))) : FAILED_ROW);
        } else if (adapter && typeof adapter.load === 'function') {
          await Promise.all(
            list.map(async (ref) => {
              const settled = await settleWithin(
                Promise.resolve().then(() => adapter.load!(ref)),
                this.config.modelTimeoutMs,
                describeError,
                'load',
              );
              if (!settled.ok) this.logAt('error', `${this.where}: load of ${resourceKey(ref)} from adapter ${quote(adapter.kind)} failed: ${settled.error}`);
              out.set(resourceKey(ref), settled.ok ? rowOf(settled.value) : FAILED_ROW);
            }),
          );
        }
      }),
    );
    return out;
  }
```

At the end of the file (after the last function) add:

```ts
/** Distinct refs (by resourceKey) grouped by type, in first-seen order. */
function byType(refs: readonly ResourceRef[]): Map<ResourceType, ResourceRef[]> {
  const out = new Map<ResourceType, ResourceRef[]>();
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = resourceKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(ref.type);
    if (list) list.push(ref);
    else out.set(ref.type, [ref]);
  }
  return out;
}

/** A conditional decision whose row could not be read, denied the way authz-http's subject loading denies it. */
function deniedCopy(d: Decision, reason: DenyReason): Decision {
  return deepFreeze({ ...d, allowed: false, residual: FALSE, fields: NO_FIELDS, reason: { ...reason } });
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/check-all.test.ts`
Expected: PASS, `12 passing`, `0 failing`.

- [ ] **Step 8: Run the engine suite for regressions**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json`
Expected: `0 failing` (the `FakeAdapter` refactor keeps `ancestors()` behaviour and `ancestorCalls`).

- [ ] **Step 9: Commit**

```bash
git add packages/authz/src/engine/authorizer.ts packages/authz/test/engine/fakes.ts packages/authz/test/engine/check-all.test.ts
git commit -m "feat(authz): Authorizer.checkAll with batched ancestors and row loads"
```

---

### Task 4: Boot rule 12 (list permissions)

**Files:**
- Modify: `packages/authz/src/engine/validate.ts` (L44, L88, after L161, new function after `checkRoutes` L312)
- Test: `packages/authz/test/engine/validate-list.test.ts`

**Interfaces:**
- Consumes: `PermissionDef.list`, `AuthorizationModel.listSupport?` / `listPlan?`, `ListSupport` (L0).
- Produces: report lines `[6.5/12] domain "<d>", type "<t>", permission "<p>"[, model "<m>"]: <text>`, texts: `cannot plan lists: it has no listSupport()`, `not list-filterable: <reason from ListSupport>`, `listSupport() threw: <message>`, `listSupport() answered <json>; expected true or { reason }`, `answers listSupport() true but has no listPlan()`, `list permissions combine with deny-overrides only, got "<algorithm>"`. L8 and L10 put the permission, the rule or policy id and the config key into their `ListSupport.reason`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz/test/engine/validate-list.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { validateBoot } from '../../src/engine/validate.js';
import type { BootInput } from '../../src/engine/validate.js';
import { PermissionRegistryImpl } from '../../src/engine/registry.js';
import { AuthorizationModel, AuthzConfigError } from '../../src/contracts/index.js';
import type { ListSupport, ModelCapabilities, ModelListPlan, PermissionDef, ResourceType, Vote } from '../../src/contracts/index.js';

const expect = chai.expect;

type Route = (def: PermissionDef, type: ResourceType) => boolean;

/** Has no listSupport, so it cannot plan lists. */
class PlainModel extends AuthorizationModel {
  readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: [], sync: 'always', fields: false, needsSubject: false };

  constructor(readonly name: string, private readonly route: Route = () => true) {
    super();
  }

  init(): void {}

  applies(def: PermissionDef, type: ResourceType): boolean {
    return this.route(def, type);
  }

  evaluate(): Vote {
    throw new Error('evaluate must not run at boot');
  }
}

class ListingModel extends PlainModel {
  readonly asked: string[] = [];

  constructor(name: string, private readonly answer: (def: PermissionDef, type: ResourceType) => unknown = () => true, route?: Route) {
    super(name, route);
  }

  listSupport(def: PermissionDef, type: ResourceType): ListSupport {
    this.asked.push(`${def.name}@${type}`);
    return this.answer(def, type) as ListSupport;
  }

  async listPlan(): Promise<ModelListPlan> {
    throw new Error('listPlan must not run at boot');
  }
}

class SupportOnlyModel extends PlainModel {
  listSupport(): ListSupport {
    return true;
  }
}

const registry = (defs: { name: string; types?: string[]; list?: boolean }[] = [{ name: 'doc:read', types: ['doc', 'folder'], list: true }, { name: 'doc:write', types: ['doc'] }]): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(defs, 'test');
  r.freeze();
  return r;
};

const input = (over: Partial<BootInput>): BootInput => ({ domain: 'app', models: [], registry: registry(), ...over });

function lines(over: Partial<BootInput>): string[] {
  let caught: unknown;
  try {
    validateBoot(input(over));
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected validateBoot to throw').to.be.instanceOf(AuthzConfigError);
  return (caught as Error).message.split('\n').slice(1);
}

describe('validateBoot rule 12: list permissions', () => {
  it('passes when every model routed for a list permission plans it, asking about each of its types once', () => {
    const m = new ListingModel('rbac');
    expect(validateBoot(input({ models: [m] })).warnings).to.deep.equal([]);
    expect(m.asked).to.deep.equal(['doc:read@doc', 'doc:read@folder']);
  });

  it('reports a routed model without listSupport on each type', () => {
    expect(lines({ models: [new PlainModel('abac')] })).to.deep.equal([
      '[6.5/12] domain "app", type "doc", permission "doc:read", model "abac": cannot plan lists: it has no listSupport()',
      '[6.5/12] domain "app", type "folder", permission "doc:read", model "abac": cannot plan lists: it has no listSupport()',
    ]);
  });

  it('names the reason the model gives', () => {
    const m = new ListingModel('abac', (_def, type) => (type === 'doc' ? { reason: 'policy "p1" reads resource.status (authz.abac.policies)' } : true));
    expect(lines({ models: [m] })).to.deep.equal(['[6.5/12] domain "app", type "doc", permission "doc:read", model "abac": not list-filterable: policy "p1" reads resource.status (authz.abac.policies)']);
  });

  it('reports a listSupport that throws or answers neither true nor { reason }', () => {
    const boom = new ListingModel('boom', () => {
      throw new Error('store down');
    });
    const odd = new ListingModel('odd', () => false);
    const out = lines({ models: [boom, odd] });
    expect(out).to.have.length(4);
    expect(out).to.include('[6.5/12] domain "app", type "doc", permission "doc:read", model "boom": listSupport() threw: store down');
    expect(out).to.include('[6.5/12] domain "app", type "doc", permission "doc:read", model "odd": listSupport() answered "false"; expected true or { reason }');
  });

  it('reports a model that answers true but has no listPlan', () => {
    expect(lines({ models: [new SupportOnlyModel('half')] })).to.deep.equal([
      '[6.5/12] domain "app", type "doc", permission "doc:read", model "half": answers listSupport() true but has no listPlan()',
      '[6.5/12] domain "app", type "folder", permission "doc:read", model "half": answers listSupport() true but has no listPlan()',
    ]);
  });

  it('refuses another algorithm than deny-overrides on a type of a list permission', () => {
    const out = lines({ models: [new ListingModel('rbac')], combine: { default: { algorithm: 'deny-overrides' }, types: { folder: { algorithm: 'permit-overrides' } } } });
    expect(out).to.deep.equal(['[6.5/12] domain "app", type "folder", permission "doc:read": list permissions combine with deny-overrides only, got "permit-overrides"']);
  });

  it('does not ask a model the list permission is not routed to', () => {
    const narrow = new PlainModel('fs', (def) => def.name !== 'doc:read');
    expect(validateBoot(input({ models: [narrow, new ListingModel('rbac')] })).warnings).to.deep.equal([]);
  });

  it('checks nothing when no permission is list: true', () => {
    expect(validateBoot(input({ registry: registry([{ name: 'doc:write', types: ['doc'] }]), models: [new PlainModel('abac')] })).warnings).to.deep.equal([]);
  });

  it('sorts rule 12 after the other rules', () => {
    const out = lines({ models: [new PlainModel('abac')], combine: { default: { algorithm: 'deny-overrides', models: ['ghost', 'abac'] } } });
    expect(out[0]).to.match(/^\[6\.5\/1\] /);
    expect(out[out.length - 1]).to.match(/^\[6\.5\/12\] /);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/validate-list.test.ts`
Expected: FAIL; e.g. `reports a routed model without listSupport on each type` fails with `expected validateBoot to throw` (rule 12 does not exist yet).

- [ ] **Step 3: Write the implementation**

In `packages/authz/src/engine/validate.ts`:

Replace line 44:

```ts
type Rule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 12 | 'models' | 'combine' | 'routes';
```

Replace line 88:

```ts
/** Design §6.5 rules 1–8 and 10, and rule 12 (list permissions, resource-access plan decision 8); rules 9 and 11 are checked by the models. */
```

After line 161 (`guard(4, () => checkRoutes(routes, caps, adaptersByType, natives, joinTypes, add));`) add:

```ts
    guard(12, () => checkListPermissions(routes, registry, add));
```

After `checkRoutes` (after line 312) add:

```ts
/** Rule 12: every model routed for a `list: true` permission on one of its types plans it, under deny-overrides (the only algorithm plans combine with). */
function checkListPermissions(table: RouteTable, registry: PermissionRegistry, add: Add): void {
  for (const def of registry.all()) {
    if (def.list !== true) continue;
    for (const type of new Set(listOf(def.types))) {
      const plan = table.get(def.name, type);
      if (!plan) continue;
      if (plan.algorithm !== 'deny-overrides') add({ rule: 12, type, permission: def.name, text: `list permissions combine with deny-overrides only, got ${q(plan.algorithm)}` });
      for (const model of plan.models) {
        const text = listProblem(model, def, type);
        if (text !== undefined) add({ rule: 12, type, permission: def.name, model: model.name, text });
      }
    }
  }
}

function listProblem(model: AuthorizationModel, def: PermissionDef, type: ResourceType): string | undefined {
  const support: unknown = (model as { listSupport?: unknown }).listSupport;
  if (typeof support !== 'function') return 'cannot plan lists: it has no listSupport()';
  let answer: unknown;
  try {
    answer = support.call(model, def, type);
  } catch (err) {
    return `listSupport() threw: ${message(err)}`;
  }
  if (answer === true) return typeof (model as { listPlan?: unknown }).listPlan === 'function' ? undefined : 'answers listSupport() true but has no listPlan()';
  if (isObject(answer) && typeof answer.reason === 'string') return `not list-filterable: ${answer.reason}`;
  return `listSupport() answered ${q(answer)}; expected true or { reason }`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/validate-list.test.ts`
Expected: PASS, `9 passing`, `0 failing`.

- [ ] **Step 5: Run the existing boot-rule tests**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json test/engine/validate.test.ts`
Expected: `0 failing` (no existing registry declares `list: true`).

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/engine/validate.ts packages/authz/test/engine/validate-list.test.ts
git commit -m "feat(authz): boot rule 12, list permissions must be planned by every routed model"
```

---

### Task 5: `DefaultAuthzService.accessPlan` and `checkAll`

**Files:**
- Modify: `packages/authz/src/host/service.ts` (imports L15-17, after `checkMany` L190-192)
- Test: `packages/authz/test/host/access.test.ts`

**Interfaces:**
- Consumes: `Authorizer.accessPlan` (Task 2), `Authorizer.checkAll` (Task 3), boot rule 12 (Task 4).
- Produces: `AuthzService.accessPlan(principal, permission, type, env?): Promise<AccessPlan>` (env passed through to the models as `ListPlanRequest.env`) and `AuthzService.checkAll(principal, requests): Promise<readonly Decision[]>` on every booted domain, each sharing the request's `AuthzCache` (`requestScope()`). L4 calls `authz(domain).accessPlan(...)`; L11 calls `checkAll`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz/test/host/access.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { StaticModel, userPrincipal } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzConfigError, TRUE } from '@spinajs/authz';
import type { ListPlanRequest, ListSupport, ModelListPlan } from '@spinajs/authz';
import { installHost, instance, registerInRoot, resetHost, rootService, setConfig, uninstallHost } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');

/** Plans one owner term for the principal. */
class PlanningModel extends StaticModel {
  listSupport(): ListSupport {
    return true;
  }

  async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
    return { kind: 'terms', permit: [{ op: 'test.owner', args: { id: req.principal.id } }], deny: [] };
  }
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('DefaultAuthzService: accessPlan, checkAll and boot rule 12', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  it('accessPlan answers through the domain service', async () => {
    setConfig('authz.permissions', { 'doc:read': { list: true } });
    registerInRoot(AuthorizationModel, instance(new PlanningModel({ name: 'planner' })));
    const svc = await rootService();
    expect(await svc.accessPlan(alice, 'doc:read', 'doc')).to.deep.equal({ kind: 'filter', permit: [{ op: 'test.owner', args: { id: 'alice' } }], deny: [] });
  });

  it('accessPlan hands the caller env to the models', async () => {
    const seen: ListPlanRequest[] = [];
    class EnvModel extends PlanningModel {
      async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
        seen.push(req);
        return super.listPlan(req);
      }
    }
    setConfig('authz.permissions', { 'doc:read': { list: true } });
    registerInRoot(AuthorizationModel, instance(new EnvModel({ name: 'planner' })));
    const svc = await rootService();
    await svc.accessPlan(alice, 'doc:read', 'doc', { ip: '10.0.0.1' });
    expect(seen[0].env?.ip).to.equal('10.0.0.1');
    expect(seen[0].env?.now).to.be.instanceOf(Date);
  });

  it('boot refuses a list permission routed to a model that cannot plan it', async () => {
    setConfig('authz.permissions', { 'doc:read': { list: true } });
    registerInRoot(AuthorizationModel, instance(new StaticModel({ name: 'plain' })));
    const err = await rejection(rootService());
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(err.message).to.contain('[6.5/12] domain "root", type "doc", permission "doc:read", model "plain": cannot plan lists: it has no listSupport()');
  });

  it('checkAll answers each request in input order', async () => {
    setConfig('authz.permissions', { 'doc:read': {}, 'doc:write': {} });
    registerInRoot(AuthorizationModel, instance(new StaticModel({ name: 'reader', votes: (req) => (req.permission === 'doc:read' ? { permitWhen: TRUE } : {}) })));
    const svc = await rootService();
    const doc = { type: 'doc', id: '1' };
    const out = await svc.checkAll(alice, [
      { permission: 'doc:write', resource: doc },
      { permission: 'doc:read', resource: doc },
    ]);
    expect(out.map((d) => [d.permission, d.allowed])).to.deep.equal([
      ['doc:write', false],
      ['doc:read', true],
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.host.json test/host/access.test.ts`
Expected: FAIL: `accessPlan answers ...` and `checkAll answers ...` fail (no method on `DefaultAuthzService`, or L0's stub throws); the boot test already passes (rule 12 from Task 4).

- [ ] **Step 3: Write the implementation**

In `packages/authz/src/host/service.ts`, after line 17 (`import type { Decision } from '../contracts/decision.js';`) add:

```ts
import type { AccessPlan } from '../contracts/plan.js';
```

After `checkMany` (lines 190-192) add, replacing any `checkAll` / `accessPlan` stubs L0 left in this class:

```ts
  async checkAll(principal: Principal, requests: readonly { readonly permission: Permission; readonly resource: ResourceRef }[]): Promise<readonly Decision[]> {
    return this.state().authorizer.checkAll(principal, requests, requestScope());
  }

  async accessPlan(principal: Principal, permission: Permission, type: ResourceType, env?: Readonly<Record<string, unknown>>): Promise<AccessPlan> {
    return this.state().authorizer.accessPlan(principal, permission, type, env, requestScope());
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.host.json test/host/access.test.ts`
Expected: PASS, `4 passing`, `0 failing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz/src/host/service.ts packages/authz/test/host/access.test.ts
git commit -m "feat(authz): DefaultAuthzService.accessPlan and checkAll"
```

---

### Task 6: `forgetScopesInTx`

**Files:**
- Modify: `packages/authz/src/admin/forget.ts` (whole file)
- Test: `packages/authz/test/admin/forget-in-tx.test.ts`

**Interfaces:**
- Consumes: `ScopeForgetter`, `WritableScopeAttributeStore` (`admin/ports.ts`), `AdminCallContext` (`admin/context.ts`), `AuthzService` (contracts), `AuthzClock` (`host/clock.ts`).
- Produces (L3 uses it in the delete clean-up, design §6.4 step 3): `forgetScopesInTx(container: IContainer, scopes: readonly ResourceRef[], tx: AuthzTx, ctx: { readonly actor: Principal; readonly reason: string }): Promise<{ tags: string[] }>`, exported from `@spinajs/authz` (through `admin/index.ts` → `src/index.ts`). It runs every `ScopeForgetter` and the attribute store per node in `tx`, with an `AdminCallContext` of the container's domain (`actor`, `reason`, `now` from `AuthzClock`, `dryRun: false`), and returns the union of tags including `scope:<resourceKey>` per node. It does no permission check, guard, version bump, publish, event sink or audit: the caller bumps `authz_version`, publishes `AuthzChange { tags }` after its commit and writes the audit entry. A scope without an id, or `GLOBAL`, throws `AuthzConfigError`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz/test/admin/forget-in-tx.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, AuthzContributor, GLOBAL, MemoryScopeAttributeStore, SYSTEM, ScopeAttributeStore, ScopeForgetter, WritableScopeAttributeStore, adminActor, adminContainer, forgetScopesInTx, memoryTx } from '@spinajs/authz';
import type { AdminContext, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const p1: ResourceRef = { type: 'project', id: 'p1' };
const p2: ResourceRef = { type: 'project', id: 'p2' };
const DELETED = { actor: SYSTEM, reason: 'resource-deleted' };

/** Rows per scope key; forget removes the rows AT the scope, undoable. */
class RowForgetter extends ScopeForgetter {
  readonly rows = new Map<string, string[]>([
    ['project:p1', ['r1', 'r2']],
    ['project:p2', ['r3']],
  ]);
  readonly seen: { scope: ResourceRef; ctx: AdminContext }[] = [];

  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    this.seen.push({ scope, ctx });
    const key = `${scope.type}:${scope.id}`;
    const gone = this.rows.get(key) ?? [];
    this.rows.delete(key);
    memoryTx(tx).onRollback(() => this.rows.set(key, gone));
    return { affected: gone.length, tags: gone.map((r) => `rule:${r}`), events: [] };
  }
}

const SCHEMA = { scopeType: 'project', schema: { type: 'object' }, defaults: {} };

async function domain(forgetter: RowForgetter, store?: MemoryScopeAttributeStore): Promise<AdminDomain> {
  return adminDomain('test', {
    register(c) {
      c.register(instance(forgetter)).as(ScopeForgetter);
      if (store) {
        c.register(instance(store)).as(ScopeAttributeStore);
        c.register(instance(store)).as(WritableScopeAttributeStore);
        c.register(instance({ contribute: () => ({ scopeAttributeSchemas: [SCHEMA] }) })).as(AuthzContributor);
      }
    },
  });
}

describe('forgetScopesInTx', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
  });

  it('runs the scope.forget fan-out for every scope inside the given transaction, publishing nothing', async () => {
    const forgetter = new RowForgetter();
    const store = new MemoryScopeAttributeStore({ values: [{ scope: p1, attributes: { a: 1 } }] });
    const d = await domain(forgetter, store);
    const out = await d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [p1, p2], tx, DELETED));
    expect([...out.tags].sort()).to.deep.equal(['rule:r1', 'rule:r2', 'rule:r3', 'scope:project:p1', 'scope:project:p2']);
    expect(forgetter.rows.size).to.equal(0);
    expect(await store.get(p1)).to.deep.equal({});
    expect(d.bus.published).to.deep.equal([]);
    expect(d.sink.events).to.deep.equal([]);
  });

  it('hands the forgetters an admin context of the domain with the actor and the reason', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    await d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [p1], tx, DELETED));
    const ctx = forgetter.seen[0].ctx;
    expect(ctx.domain).to.equal('test');
    expect(ctx.reason).to.equal('resource-deleted');
    expect(ctx.now.getTime()).to.equal(d.clock.now().getTime());
    expect(adminActor(ctx)).to.equal(SYSTEM);
    expect(adminContainer(ctx)).to.equal(d.container);
  });

  it('rolls back with the caller transaction', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    const err = await rejection(
      d.backend.transaction('test', async (tx) => {
        await forgetScopesInTx(d.container, [p1], tx, DELETED);
        throw new Error('the delete failed');
      }),
    );
    expect(err.message).to.equal('the delete failed');
    expect(forgetter.rows.get('project:p1')).to.deep.equal(['r1', 'r2']);
  });

  it('refuses GLOBAL and a ref without an id with AuthzConfigError', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    for (const scope of [GLOBAL, { type: 'project' }]) {
      const err = await rejection(d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [scope as ResourceRef], tx, DELETED)));
      expect(err).to.be.instanceOf(AuthzConfigError);
    }
    expect(forgetter.seen).to.deep.equal([]);
  });

  it('forgets nothing for an empty list', async () => {
    const forgetter = new RowForgetter();
    const d = await domain(forgetter);
    expect(await d.backend.transaction('test', (tx) => forgetScopesInTx(d.container, [], tx, DELETED))).to.deep.equal({ tags: [] });
    expect(forgetter.seen).to.deep.equal([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.admin.json test/admin/forget-in-tx.test.ts`
Expected: FAIL with a TSError `Module '"@spinajs/authz"' has no exported member 'forgetScopesInTx'`.

- [ ] **Step 3: Write the implementation**

Replace `packages/authz/src/admin/forget.ts` with:

```ts
import { Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AuthzAdminFailure, AuthzWriteHandler } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand, AuthzEvent, AuthzTx } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Permission } from '../contracts/permission.js';
import type { Principal, ResourceRef } from '../contracts/principal.js';
import { GLOBAL, resourceKey } from '../contracts/resource.js';
import { AuthzService } from '../contracts/service.js';
import { AuthzClock } from '../host/clock.js';
import { adminActor, adminContainer } from './context.js';
import type { AdminCallContext } from './context.js';
import { ScopeForgetter, WritableScopeAttributeStore } from './ports.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const name = (v: unknown): string => (isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v));

function nodeOf(scope: unknown): ResourceRef {
  if (isObject(scope) && scope.type === GLOBAL.type) throw new AuthzAdminFailure('conflict', 'GLOBAL cannot be forgotten', 'scope');
  if (!isObject(scope) || typeof scope.type !== 'string' || scope.type === '' || typeof scope.id !== 'string' || scope.id === '') throw new AuthzAdminFailure('conflict', 'scope.forget needs one node: a resource ref with a type and an id', 'scope');
  return { type: scope.type, id: scope.id };
}

const scopeOf = (c: AuthzCommand): ResourceRef => nodeOf((c as { scope?: unknown }).scope);

/** Every ScopeForgetter, then the node's scope attributes, inside `tx`. */
async function forgetNode(container: IContainer, scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
  const where = `Authz domain ${JSON.stringify(ctx.domain)}`;
  let affected = 0;
  const tags = new Set<string>();
  const events: AuthzEvent[] = [];

  const forgetters = container.hasRegistered(ScopeForgetter) ? [...(await container.resolve(Array.chainOf(ScopeForgetter)))] : [];
  for (const f of forgetters) {
    if (!isObject(f) || typeof f.forget !== 'function') throw new AuthzConfigError(`${where}: ${name(f)} is not a ScopeForgetter`);
    const out: unknown = await f.forget(scope, ctx, tx);
    if (!isObject(out) || typeof out.affected !== 'number' || !Number.isInteger(out.affected) || out.affected < 0 || !Array.isArray(out.tags) || !out.tags.every((t) => typeof t === 'string') || !Array.isArray(out.events) || !out.events.every((e) => isObject(e) && typeof e.type === 'string' && isObject(e.data))) {
      throw new AuthzConfigError(`${where}: ${name(f)}.forget() must return { affected, tags: string[], events: { type, data }[] }`);
    }
    affected += out.affected;
    for (const t of out.tags as string[]) tags.add(t);
    events.push(...(out.events as AuthzEvent[]));
  }

  if (container.hasRegistered(WritableScopeAttributeStore)) {
    const store = (await container.resolve(WritableScopeAttributeStore)) as WritableScopeAttributeStore;
    affected += await store.forget(scope, tx);
  }

  // Always: decisions that read the node (attributes, ancestors) must not outlive it.
  tags.add(`scope:${resourceKey(scope)}`);
  const actor = adminActor(ctx);
  events.push({ type: 'ScopeForgotten', domain: ctx.domain, actor: { type: actor.type, id: actor.id }, at: ctx.now, data: { scope, affected } });
  return { affected, tags: [...tags], events };
}

/**
 * scope.forget: every model's data AT the node (each registered ScopeForgetter) and the node's scope
 * attributes, in the batch transaction. Data below the node is the caller's: it sends one command per node.
 */
@Singleton()
@Injectable(AuthzWriteHandler)
export class ScopeForgetHandler extends AuthzWriteHandler {
  readonly kinds = ['scope.forget'] as const;

  async validate(c: AuthzCommand): Promise<void> {
    scopeOf(c);
  }

  permission(c: AuthzCommand): { permission: Permission; resource: ResourceRef } {
    return { permission: 'authz:scope.forget', resource: scopeOf(c) };
  }

  async apply(c: AuthzCommand, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return forgetNode(adminContainer(ctx), scopeOf(c), ctx, tx);
  }
}

/**
 * Design §6.4 step 3: scope.forget's store writes for nodes a delete removed, in the caller's transaction,
 * since DbAuthzAdminBackend refuses to open one inside it. No permission check, guard, version bump, publish
 * or audit: the caller bumps the version, publishes the returned tags after its commit and audits as `ctx.actor`.
 */
export async function forgetScopesInTx(container: IContainer, scopes: readonly ResourceRef[], tx: AuthzTx, ctx: { readonly actor: Principal; readonly reason: string }): Promise<{ tags: string[] }> {
  if (!Array.isArray(scopes)) throw new AuthzConfigError('forgetScopesInTx needs an array of scopes');
  const nodes = scopes.map((scope) => {
    try {
      return nodeOf(scope);
    } catch (e) {
      throw new AuthzConfigError(`forgetScopesInTx: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  });
  if (nodes.length === 0) return { tags: [] };
  const service = (await container.resolve(AuthzService)) as AuthzService;
  const clock = (await container.resolve(AuthzClock)) as AuthzClock;
  const call: AdminCallContext = Object.freeze({ domain: service.domain, now: clock.now(), authz: service, reason: ctx.reason, actor: ctx.actor, container, dryRun: false });
  const tags = new Set<string>();
  for (const node of nodes) for (const t of (await forgetNode(container, node, call, tx)).tags) tags.add(t);
  return { tags: [...tags] };
}
```

- [ ] **Step 4: Run the new test and the existing scope.forget tests**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.admin.json test/admin/forget-in-tx.test.ts`
Expected: PASS, `5 passing`, `0 failing`.

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json --config .mocharc.admin.json test/admin/forget.test.ts`
Expected: `0 failing` (the handler's behaviour is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/authz/src/admin/forget.ts packages/authz/test/admin/forget-in-tx.test.ts
git commit -m "feat(authz): forgetScopesInTx, the scope.forget fan-out inside a caller's transaction"
```

---

### Task 7: `ListSupportGuard` and the write-time validator

**Files:**
- Create: `packages/authz/src/admin/list-guard.ts`
- Modify: `packages/authz/src/admin/index.ts`
- Test: `packages/authz/test/admin/list-guard.test.ts`

**Interfaces:**
- Consumes: `AuthzCommandValidator`, `AuthzAdminFailure` (contracts), `adminContainer` (`admin/context.ts`).
- Produces (L8 registers one for `rule.put`, L10 for `policy.put`): `abstract class ListSupportGuard { abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void> }`, registered with `@Injectable(ListSupportGuard)` in the model package. A guard resolves when the command keeps every `list: true` permission list-filterable and throws otherwise; its error message should name the permission, the rule or policy id, and why. `ListSupportValidator` (built in) turns a plain error into `AuthzAdminFailure('not_list_filterable', message, 'policy' | 'rule')`; `AuthzAdminFailure` and `AuthzConfigError` pass through unchanged. Only `policy.put` and `rule.put` reach the guards.

- [ ] **Step 1: Write the failing test**

Create `packages/authz/test/admin/list-guard.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { userPrincipal } from '@spinajs/authz-testing';

import { AuthzAdminFailure, AuthzCommandValidator, AuthzConfigError, AuthzWriteHandler, GLOBAL, ListSupportGuard, ListSupportValidator } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzEvent, Permission, ResourceRef } from '@spinajs/authz';
import { adminConfig, adminDomain, installHost, instance, rejection, resetHost, uninstallHost } from './support.js';
import type { AdminDomain } from './support.js';

const expect = chai.expect;

const alice = userPrincipal('alice');

class PolicyRuleHandler extends AuthzWriteHandler {
  readonly kinds = ['policy.put', 'rule.put'] as const;

  async validate(): Promise<void> {}

  permission(): { permission: Permission; resource: ResourceRef } {
    return { permission: 'app:settings.manage', resource: { type: 'project', id: 'p1' } };
  }

  async apply(): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    return { affected: 1, tags: ['policy:changed'], events: [] };
  }
}

/** Refuses ids starting with "bad"; `error`, when set, is thrown instead. */
class RecordingGuard extends ListSupportGuard {
  readonly seen: string[] = [];
  error: unknown;

  async checkCommand(c: AuthzCommand, _ctx: AdminContext): Promise<void> {
    this.seen.push(c.kind);
    if (this.error !== undefined) throw this.error;
    const id = c.kind === 'policy.put' ? c.policy.id : c.kind === 'rule.put' ? c.rule.id : '';
    if (id.startsWith('bad')) throw new Error(`${c.kind} ${id} reads resource.status, so doc:read is not list-filterable`);
  }
}

const putPolicy = (id: string): AuthzCommand => ({ kind: 'policy.put', policy: { id, effect: 'permit', permissions: ['doc:read'] } });
const putRule = (id: string): AuthzCommand => ({ kind: 'rule.put', rule: { id, kind: 'cap', scope: GLOBAL } });
const errorOf = (r: unknown) => (r as { error: { code: string; message: string; field?: string } }).error;

async function domain(guard?: RecordingGuard): Promise<AdminDomain> {
  return adminDomain('test', {
    register(c) {
      c.register(PolicyRuleHandler).as(AuthzWriteHandler);
      if (guard) c.register(instance(guard)).as(ListSupportGuard);
    },
  });
}

describe('ListSupportValidator', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    adminConfig();
  });

  it('is a built-in AuthzCommandValidator', () => {
    expect(new ListSupportValidator()).to.be.instanceOf(AuthzCommandValidator);
  });

  it('refuses a policy.put a guard refuses with not_list_filterable', async () => {
    const d = await domain(new RecordingGuard());
    const out = await d.admin.execute(alice, [putPolicy('bad1')]);
    expect(out[0]).to.deep.include({ ok: false, kind: 'policy.put' });
    expect(errorOf(out[0])).to.deep.include({ code: 'not_list_filterable', field: 'policy' });
    expect(errorOf(out[0]).message).to.contain('resource.status');
    expect(d.bus.published).to.deep.equal([]);
  });

  it('refuses a rule.put the same way', async () => {
    const d = await domain(new RecordingGuard());
    const out = await d.admin.execute(alice, [putRule('bad-rule')]);
    expect(errorOf(out[0])).to.deep.include({ code: 'not_list_filterable', field: 'rule' });
  });

  it('lets an accepted policy.put through', async () => {
    const d = await domain(new RecordingGuard());
    expect(await d.admin.execute(alice, [putPolicy('good')])).to.deep.equal([{ ok: true, kind: 'policy.put', affected: 1 }]);
  });

  it('asks the guards about policy.put and rule.put only', async () => {
    const guard = new RecordingGuard();
    const d = await domain(guard);
    await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: { type: 'user', id: 'bob' }, role: 'editor', scope: { type: 'project', id: 'p1' } }, putPolicy('good'), putRule('good')]);
    expect(guard.seen).to.deep.equal(['policy.put', 'rule.put']);
  });

  it('passes an AuthzAdminFailure of a guard through as is', async () => {
    const guard = new RecordingGuard();
    guard.error = new AuthzAdminFailure('conflict', 'busy', 'policy.id');
    const d = await domain(guard);
    expect(errorOf((await d.admin.execute(alice, [putPolicy('good')]))[0])).to.deep.equal({ code: 'conflict', message: 'busy', field: 'policy.id' });
  });

  it('lets an AuthzConfigError of a guard reject the batch', async () => {
    const guard = new RecordingGuard();
    guard.error = new AuthzConfigError('broken guard');
    const d = await domain(guard);
    expect(await rejection(d.admin.execute(alice, [putPolicy('good')]))).to.be.instanceOf(AuthzConfigError);
  });

  it('accepts every policy.put when no guard is registered', async () => {
    const d = await domain();
    expect(await d.admin.execute(alice, [putPolicy('bad1')])).to.deep.equal([{ ok: true, kind: 'policy.put', affected: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.admin.json test/admin/list-guard.test.ts`
Expected: FAIL with a TSError `Module '"@spinajs/authz"' has no exported member 'ListSupportGuard'`.

- [ ] **Step 3: Write the implementation**

Create `packages/authz/src/admin/list-guard.ts`:

```ts
import { Injectable, Singleton } from '@spinajs/di';

import { AuthzAdminFailure, AuthzCommandValidator } from '../contracts/admin.js';
import type { AdminContext, AuthzCommand } from '../contracts/admin.js';
import { AuthzConfigError } from '../contracts/errors.js';
import type { Principal } from '../contracts/principal.js';
import { adminContainer } from './context.js';

/**
 * Design §7 at write time: the model that owns the data a policy.put or rule.put changes says whether
 * every `list: true` permission stays list-filterable with it (RBAC registers one for rules, ABAC for
 * policies). Refuses by throwing; the message names the permission, the rule or policy, and why.
 */
export abstract class ListSupportGuard {
  abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void>;
}

const FIELD: Readonly<Record<string, string>> = Object.freeze({ 'policy.put': 'policy', 'rule.put': 'rule' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const className = (v: unknown): string => (isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v));

@Singleton()
@Injectable(AuthzCommandValidator)
export class ListSupportValidator extends AuthzCommandValidator {
  async validate(_actor: Principal, c: AuthzCommand, ctx: AdminContext): Promise<void> {
    const field = FIELD[c.kind];
    if (field === undefined) return;
    const container = adminContainer(ctx);
    if (!container.hasRegistered(ListSupportGuard)) return;
    for (const guard of [...(await container.resolve(Array.chainOf(ListSupportGuard)))]) {
      if (!isObject(guard) || typeof guard.checkCommand !== 'function') throw new AuthzConfigError(`Authz domain ${JSON.stringify(ctx.domain)}: ${className(guard)} is not a ListSupportGuard`);
      try {
        await guard.checkCommand(c, ctx);
      } catch (e) {
        if (e instanceof AuthzAdminFailure || e instanceof AuthzConfigError) throw e;
        throw new AuthzAdminFailure('not_list_filterable', e instanceof Error ? e.message : String(e), field, { cause: e });
      }
    }
  }
}
```

In `packages/authz/src/admin/index.ts` append:

```ts
export * from './list-guard.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.admin.json test/admin/list-guard.test.ts`
Expected: PASS, `8 passing`, `0 failing`.

- [ ] **Step 5: Run the admin suite for regressions (the validator is now registered for every domain)**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json --config .mocharc.admin.json`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz/src/admin/list-guard.ts packages/authz/src/admin/index.ts packages/authz/test/admin/list-guard.test.ts
git commit -m "feat(authz): ListSupportGuard registry and the not_list_filterable admin validator"
```

---

### Task 8: `AccessChangeRouter`

**Files:**
- Create: `packages/authz/src/host/push.ts`
- Modify: `packages/authz/src/host/index.ts`
- Modify: `packages/authz/src/host/service.ts` (imports after L33, `Booted` L51-66, `dispose` L242-247, boot tail L508-523)
- Test: `packages/authz/test/host/push.test.ts`

**Interfaces:**
- Consumes (L0): `AuthzChange`, `ChangeBus`, `ChangeAudience.audience(change): Promise<{ principals: readonly string[] | '*'; objects?: readonly ResourceRef[] }>`, `AccessPushTransport { name; push(principals, event) }`, `AccessChangedEvent { objects? }`.
- Produces: `export const AUTHZ_CHANGED_EVENT = 'authz.changed'` (the event name L11's SSE and L13's socket transport send), and `@Singleton() class AccessChangeRouter { start(bus: ChangeBus, container: IContainer): () => void; route(change: AuthzChange, container: IContainer): Promise<void> }`, exported from `@spinajs/authz`. Started by the root domain's `DefaultAuthzService` boot on the bus it picked, stopped by its `dispose()`. L8 registers `@Injectable(ChangeAudience)`; L11 (SSE) and L13 (socket) register `@Injectable(AccessPushTransport)`. Audience convention: answer `{ principals: [], objects: [] }` for a change that does not concern you.

- [ ] **Step 1: Write the failing test**

Create `packages/authz/test/host/push.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_CHANGED_EVENT, AccessChangeRouter, AccessPushTransport, ChangeAudience, ChangeBus } from '@spinajs/authz';
import type { AccessChangedEvent, AuthzChange, HostLog } from '@spinajs/authz';
import { domains, installHost, instance, registerInRoot, resetHost, resetRoot, rootService, uninstallHost } from './support.js';

const expect = chai.expect;

class RecordingTransport extends AccessPushTransport {
  readonly pushes: { principals: readonly string[] | '*'; event: AccessChangedEvent }[] = [];

  constructor(readonly name: string, private readonly fail = false) {
    super();
  }

  async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    this.pushes.push({ principals, event });
    if (this.fail) throw new Error(`${this.name} down`);
  }
}

class FixedAudience extends ChangeAudience {
  readonly asked: AuthzChange[] = [];

  constructor(private readonly answer: unknown) {
    super();
  }

  async audience(change: AuthzChange): Promise<{ readonly principals: readonly string[] | '*'; readonly objects?: readonly { type: string; id?: string }[] }> {
    this.asked.push(change);
    if (this.answer instanceof Error) throw this.answer;
    return this.answer as { principals: readonly string[] | '*' };
  }
}

class QuietRouter extends AccessChangeRouter {
  readonly errors: string[] = [];
  protected log: HostLog = { error: (m: string) => void this.errors.push(m), warn: () => {}, info: () => {}, debug: () => {} };
}

const change = (tags: string[]): AuthzChange => ({ domain: 'root', tags, at: new Date(0) });
const task7 = { type: 'task', id: '7' };
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('AccessChangeRouter', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
  });

  describe('route', () => {
    let c: IContainer;

    beforeEach(() => {
      c = DI.RootContainer.child();
    });

    afterEach(async () => {
      await c.dispose();
    });

    it('asks no audience while no transport is registered', async () => {
      const audience = new FixedAudience({ principals: ['user:1'] });
      c.register(instance(audience)).as(ChangeAudience);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(audience.asked).to.deep.equal([]);
    });

    it("pushes tags ['*'] to every session without asking the audiences", async () => {
      const t = new RecordingTransport('sse');
      const audience = new FixedAudience({ principals: ['user:1'] });
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(audience)).as(ChangeAudience);
      await new QuietRouter().route(change(['*']), c);
      expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
      expect(audience.asked).to.deep.equal([]);
    });

    it('pushes to every session when no audience is registered', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
    });

    it('pushes the sorted union of the audiences, with objects when every audience is exact', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(new FixedAudience({ principals: ['user:2', 'user:1'], objects: [task7] }))).as(ChangeAudience);
      c.register(instance(new FixedAudience({ principals: ['user:1', 'user:3'], objects: [] }))).as(ChangeAudience);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(t.pushes).to.deep.equal([{ principals: ['user:1', 'user:2', 'user:3'], event: { objects: [task7] } }]);
    });

    it('drops objects when one audience is not exact', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(new FixedAudience({ principals: ['user:1'], objects: [task7] }))).as(ChangeAudience);
      c.register(instance(new FixedAudience({ principals: ['user:2'] }))).as(ChangeAudience);
      await new QuietRouter().route(change(['subject:user:1']), c);
      expect(t.pushes).to.deep.equal([{ principals: ['user:1', 'user:2'], event: {} }]);
    });

    it('widens the push to every session when an audience throws or answers malformed, and logs it', async () => {
      for (const answer of [new Error('membership store down'), { principals: 'everyone' }]) {
        const child = DI.RootContainer.child();
        const t = new RecordingTransport('sse');
        child.register(instance(t)).as(AccessPushTransport);
        child.register(instance(new FixedAudience(answer))).as(ChangeAudience);
        const router = new QuietRouter();
        await router.route(change(['subject:user:1']), child);
        expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
        expect(router.errors).to.have.length(1);
        await child.dispose();
      }
    });

    it('logs a failing transport and still pushes to the others', async () => {
      const bad = new RecordingTransport('socket', true);
      const good = new RecordingTransport('sse');
      c.register(instance(bad)).as(AccessPushTransport);
      c.register(instance(good)).as(AccessPushTransport);
      const router = new QuietRouter();
      await router.route(change(['*']), c);
      expect(good.pushes).to.have.length(1);
      expect(router.errors.join('\n')).to.contain('socket');
    });

    it('pushes nothing for an empty audience', async () => {
      const t = new RecordingTransport('sse');
      c.register(instance(t)).as(AccessPushTransport);
      c.register(instance(new FixedAudience({ principals: [], objects: [] }))).as(ChangeAudience);
      await new QuietRouter().route(change(['role:editor']), c);
      expect(t.pushes).to.deep.equal([]);
    });
  });

  describe('wiring', () => {
    it('the root domain routes the changes of its ChangeBus', async () => {
      const t = new RecordingTransport('sse');
      registerInRoot(AccessPushTransport, instance(t));
      await rootService();
      await (await DI.resolve(ChangeBus)).publish(change(['*']));
      await tick();
      expect(t.pushes).to.deep.equal([{ principals: '*', event: {} }]);
      expect(AUTHZ_CHANGED_EVENT).to.equal('authz.changed');
    });

    it('a child domain does not route the same change again', async () => {
      const t = new RecordingTransport('sse');
      registerInRoot(AccessPushTransport, instance(t));
      await rootService();
      const d = await domains();
      d.create('fs');
      await d.service('fs');
      await (await DI.resolve(ChangeBus)).publish(change(['*']));
      await tick();
      expect(t.pushes).to.have.length(1);
    });

    it('disposing the root service stops the routing', async () => {
      const t = new RecordingTransport('sse');
      registerInRoot(AccessPushTransport, instance(t));
      await rootService();
      await resetRoot();
      await (await DI.resolve(ChangeBus)).publish(change(['*']));
      await tick();
      expect(t.pushes).to.deep.equal([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.host.json test/host/push.test.ts`
Expected: FAIL with a TSError `Module '"@spinajs/authz"' has no exported member 'AccessChangeRouter'`.

- [ ] **Step 3: Write the router**

Create `packages/authz/src/host/push.ts`:

```ts
import { Singleton } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

import { AuthzConfigError } from '../contracts/errors.js';
import type { ResourceRef } from '../contracts/principal.js';
import { resourceKey } from '../contracts/resource.js';
import { AccessPushTransport, ChangeAudience } from '../contracts/service.js';
import type { AccessChangedEvent, AuthzChange, ChangeBus } from '../contracts/service.js';
import { engineLog } from './log.js';
import type { HostLog } from './log.js';

/** The event name every push transport sends an AccessChangedEvent under (design §10.4). */
export const AUTHZ_CHANGED_EVENT = 'authz.changed';

type Audience = { readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] };

const EVERYONE: Audience = Object.freeze({ principals: '*' });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nameOf = (v: unknown): string => {
  try {
    if (isObject(v) && typeof v.name === 'string') return v.name;
    return isObject(v) && typeof v.constructor === 'function' ? v.constructor.name : String(v);
  } catch {
    return '<unreadable>';
  }
};

async function chain<T>(container: IContainer, token: Class<T>): Promise<T[]> {
  return container.hasRegistered(token) ? [...(await container.resolve(Array.chainOf(token)))] : [];
}

/** Throws on a malformed answer, which widens the push to every session. */
function readAudience(raw: unknown): Audience {
  if (!isObject(raw)) throw new Error(`expected { principals, objects? }, got ${raw === null ? 'null' : typeof raw}`);
  const p = raw.principals;
  if (p !== '*' && !(Array.isArray(p) && p.every((x) => typeof x === 'string'))) throw new Error('principals must be "*" or a list of principal keys');
  const principals = p === '*' ? '*' : Object.freeze([...(p as string[])]);
  const o = raw.objects;
  if (o === undefined) return { principals };
  if (!Array.isArray(o) || !o.every((r) => isObject(r) && typeof r.type === 'string' && r.type !== '' && (r.id === undefined || typeof r.id === 'string'))) throw new Error('objects must be a list of resource refs');
  return { principals, objects: (o as ResourceRef[]).map((r) => Object.freeze(r.id === undefined ? { type: r.type } : { type: r.type, id: r.id })) };
}

/**
 * Resource-access plan decision 4: each AuthzChange of the root ChangeBus becomes one AccessChangedEvent
 * per registered transport, for the principals the ChangeAudiences name. Audiences and transports are
 * resolved per change, so ones registered after boot count.
 */
@Singleton()
export class AccessChangeRouter {
  protected log: HostLog = engineLog('authz-push');

  start(bus: ChangeBus, container: IContainer): () => void {
    const off: unknown = bus.subscribe((change) => {
      void this.route(change, container);
    });
    if (typeof off !== 'function') throw new AuthzConfigError('AccessChangeRouter: ChangeBus.subscribe did not return an unsubscribe function');
    return off as () => void;
  }

  /** Never rejects: the change is committed, so a failure here is logged and that push dropped. */
  async route(change: AuthzChange, container: IContainer): Promise<void> {
    try {
      const transports = await chain(container, AccessPushTransport);
      if (transports.length === 0) return;
      const audience = await this.audienceOf(change, container);
      if (audience.principals !== '*' && audience.principals.length === 0) return;
      const event: AccessChangedEvent = Object.freeze(audience.objects === undefined ? {} : { objects: Object.freeze(audience.objects) });
      await Promise.all(
        transports.map(async (t) => {
          try {
            await t.push(audience.principals, event);
          } catch (e) {
            this.log.error(`authz push: transport ${JSON.stringify(nameOf(t))} failed: ${describeError(e)}`);
          }
        }),
      );
    } catch (e) {
      this.log.error(`authz push: routing a change failed: ${describeError(e)}`);
    }
  }

  private async audienceOf(change: AuthzChange, container: IContainer): Promise<Audience> {
    const tags: unknown = isObject(change) ? change.tags : undefined;
    if (!Array.isArray(tags) || tags.includes('*')) return EVERYONE;
    const audiences = await chain(container, ChangeAudience);
    if (audiences.length === 0) return EVERYONE;
    const answers = await Promise.all(
      audiences.map(async (a) => {
        try {
          return readAudience(await a.audience(change));
        } catch (e) {
          this.log.error(`authz push: audience ${JSON.stringify(nameOf(a))} failed, pushing to every session: ${describeError(e)}`);
          return EVERYONE;
        }
      }),
    );
    const principals: readonly string[] | '*' = answers.some((a) => a.principals === '*') ? '*' : Object.freeze([...new Set(answers.flatMap((a) => a.principals as readonly string[]))].sort());
    if (!answers.every((a) => a.objects !== undefined)) return { principals };
    const objects = new Map<string, ResourceRef>();
    for (const a of answers) for (const o of a.objects!) objects.set(resourceKey(o), o);
    return { principals, objects: [...objects.values()] };
  }
}
```

In `packages/authz/src/host/index.ts` append:

```ts
export * from './push.js';
```

- [ ] **Step 4: Start and stop the router from the root domain**

In `packages/authz/src/host/service.ts`:

After line 33 (`import { currentPrincipal, requestScope, runWithPrincipal } from './storage.js';`) add:

```ts
import { AccessChangeRouter } from './push.js';
```

In `interface Booted` (lines 51-66), after `readonly unsubscribe: (() => void) | undefined;` add:

```ts
  /** Root only: the AccessChangeRouter subscription. */
  readonly stopPush: (() => void) | undefined;
```

In `dispose()`, after the `try { s.unsubscribe?.(); } catch ...` block (lines 242-246) add:

```ts
    try {
      s.stopPush?.();
    } catch (e) {
      this.log.error(`Authz domain ${q(s.name)}: stopping the access push router failed: ${describeError(e)}`);
    }
```

In `boot()`, replace line 508 (`if (cache) usedCaches.add(cache);`) with:

```ts
    if (cache) usedCaches.add(cache);
    // Every domain's admin publishes to the bus root subscribes to, so one router at root pushes each change once.
    const stopPush = parent === undefined && bus ? ((await container.resolve(AccessChangeRouter)) as AccessChangeRouter).start(bus, container) : undefined;
```

and in the returned `Object.freeze({ ... })` (lines 510-523), after `unsubscribe: this.bootSubscription,` add:

```ts
      stopPush,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/authz && npm run compile && npx ts-mocha -p tsconfig.json --config .mocharc.host.json test/host/push.test.ts`
Expected: PASS, `11 passing`, `0 failing`.

- [ ] **Step 6: Run the host suite for regressions**

Run: `cd packages/authz && npx ts-mocha -p tsconfig.json --config .mocharc.host.json`
Expected: `0 failing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz/src/host/push.ts packages/authz/src/host/index.ts packages/authz/src/host/service.ts packages/authz/test/host/push.test.ts
git commit -m "feat(authz): AccessChangeRouter, change push routed by ChangeAudience to AccessPushTransports"
```

---

### Task 9: Lane verification

**Files:** none changed (fix-ups only, if a step fails).

- [ ] **Step 1: Whole package**

Run: `cd packages/authz && npm test`
Expected: three mocha runs (engine, host, admin), each ending with `0 failing`.

- [ ] **Step 2: Lint the new files**

Run: `cd packages/authz && npx eslint -c .eslintrc.cjs --ext .ts src/engine/plan.ts src/host/push.ts src/admin/list-guard.ts src/admin/forget.ts src/engine/validate.ts`
Expected: no errors (warnings from `tsdoc/syntax` on existing comments are acceptable).

- [ ] **Step 3: Dependants still pass**

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing`.

Run: `cd packages/authz-http && npm test`
Expected: `0 failing`.

- [ ] **Step 4: API snapshot unchanged**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: the check passes; this lane touched no snapshotted file.

- [ ] **Step 5: Commit any fix-ups**

```bash
git add -A packages/authz
git commit -m "chore(authz): lane L2 verification fixes"
```

(Skip when Steps 1-4 needed no change.)

---

## Resolved (formerly contract issues)

1. `ListPlanRequest` gains `actor?` and `env?`, and `AuthzService.accessPlan` takes `env?` (now in `00-overview.md`); Tasks 2 and 5 pass them as `check()` does (decision 10).
2. Two intersecting resource ceilings give `none` with `ceiling` (overview decision 9; decision 2 here).
3. `not_list_filterable` is added to the admin error-code comment by L0.
