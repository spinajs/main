# Lane L8: rbac model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane.

**Goal:** Give `RbacModel` wildcard subjects, nested subject sets through `MembershipStore`, deny roles, `listSupport` / `listPlan`, the `rbac.assignment` SQL compiler, the `rule.put` list guard and the `ChangeAudience` of RBAC changes.

**Architecture:** Checks keep the existing pipeline (`src/model/evaluate.ts`): the subject resolver adds `<type>:*`, `SetsExtension` adds the nested sets `MembershipStore.setsOf` returns, `collect` sets deny-role assignments apart (`state.denied`, never dropped by a ceiling) and a new `applyDenyRoles` step turns them into `role_denied` denies. Lists reuse the same gathered input: `listPlan` runs the pipeline up to `cap` for the type-level request `{ type }`, decides `$global` and type-level assignments in app, and describes scoped assignments as `rbac.assignment` terms (and `relation.owner` / `relation.self`), which `src/plan/assignment-sql.ts` renders against `SqlRowContext` (design §6.2). authz-rbac never imports authz-orm: the ancestor table name comes in `SqlRowContext.ancestorTable`.

**Tech Stack:** TypeScript (node16 modules), `@spinajs/di`, `@spinajs/orm` + `@spinajs/orm-sqlite` (tests), mocha + ts-mocha + chai 4.

**Depends on:**
- L0 merged (G0): `RoleDef.deny`, `MembershipStore` (`setsOf` returning `{ setKey, expiresAt? }[]`, `membersOf`), `SubjectKey` in `src/contracts.ts`; core `PlanTerm`, `PlanTermSql`, `SqlRowContext`, `SqlFragment`, `ListSupport`, `ListPlanRequest` (with `actor?`, `env?`), `ModelListPlan` (its `all` carries an optional `deny`), `SqlRowContext.relation(name)`, `ChangeAudience`, `AuthorizationModel.listSupport?` / `listPlan?`, `DEFAULT_DENY_PRIORITY.role_denied = 150`.
- L7 merged: `src/orm/**` gone, `AUTHZ_ASSIGNMENT_TABLE` exported from `src/stores/assignment-row.ts`. L7 leaves `src/model/native.ts` and `src/model/rules/native.ts` to this lane: Task 11 deletes them with the rest of the old type-level list path.
- L6 merged before Task 4 and Task 8: `subjectKeyOf(subject)` in `src/stores/columns.ts` (`user:42`, `team:7#member`, `user:*`; the id part escapes `%`→`%25`, `#`→`%23`, `*`→`%2A`, except that the subject `{ type, id: '*' }` is the wildcard and is written `type:*`; every subject key in this lane is built with it, never with core `principalKey`), `authz_assignment.subject_key`, `AUTHZ_SUBJECT_MEMBERSHIP_TABLE` (exported from `src/stores/index.ts`; if L6 put it in another module, import it from there — `grep -rn "export const AUTHZ_SUBJECT_MEMBERSHIP_TABLE" packages/authz-rbac/src`).
- L2 Task 7 merged before Task 9: `ListSupportGuard` exported from `@spinajs/authz` (`abstract checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void>`; refuse by throwing; `ListSupportValidator` passes an `AuthzAdminFailure` through).

**Blocks:** L9 (end-to-end lists, deny roles, wildcards, nested teams, push).

**Serves the teams lanes:** Task 13 (`authz.admin.guard.keepHolders`, e.g. one `team.owner` per team) is the guard rule the teams lanes L14/L15 configure (`docs/plans/2026-10-14-teams-design.md` §5, §10). It needs Tasks 4 and 5 and L6 merged.

## Global Constraints

- All code, comments, identifiers and commit messages in English; comments only where a reader would ask "why?".
- Match the surrounding code: `Object.freeze` on returned values, `AuthzConfigError` for misconfiguration, `AuthzAdminFailure(code, message, field?)` for refused admin commands, `@Singleton()` + `@Injectable(Token)` registrations.
- Tests: mocha + chai `expect`, files `test/<area>/<name>.test.ts`. One file: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/<path>.test.ts`. The package's `npm test` compiles first (`pretest`). After a core change (`packages/authz`), run `npm run compile` there first.
- `packages/authz-rbac/src/contracts.ts` belongs to L0; only Task 11 edits it (it deletes `RBAC_ASSIGNMENT_OP`, `RBAC_THRESHOLD_OP`, `RBAC_RESIDUALS`), with the API snapshot update and the RFC `docs/plans/authz-v3-rfc/RA8-1.md` in the same commit.
- Commit after every task.

## Decisions made in this lane

1. **Wildcards are subjects of the resolver.** `RbacSubjectResolver.subjects` adds `{ type, id: '*' }` for the principal and each companion, after the principals. So `forSubjects`, the assignment cache (key `user:*`) and the list subjects pick wildcard rows up with no store change. Admin input refuses a subject type `'*'` (so `*:*`) and a scope id `'*'` (a set `team:*#member`, a scope `invoice:*`); `link:*` is already refused as a link subject. A principal whose id is literally `*` is not added as a subject of its own: no assignment can name it apart from the wildcard (L6 writes `{ type, id: '*' }` as `type:*`), so it is reached through `type:*` only. `principalSubjectKey(p)` (Task 4) gives such a principal's own key, `type:%2A`, wherever a principal (not a subject) needs one.
2. **Deny grants follow no `implies`.** Denying `invoice:edit` does not deny `invoice:read` even when `edit` implies `read`; a deny names exactly what it removes. Deny roles may extend other deny roles.
3. **A deny role is validated at compile** (boot error texts in Task 2): no `relation`, `on`, `fields`, `requiresTag`, `grantedAt` on its grants; not `subjectSet`; not on a ladder; no `implies`; no edge (`extends`, ladder) between a deny and a permit role; a permit role cannot imply a deny role.
4. **Ceilings and rules never drop a deny assignment** (design §4.2): `collect` keeps deny rows outside `withinCeiling`, puts them in `state.denied`, and restrict/cap only read `live` / `scoped`. A deny through a set needs a live membership, never a membership role inside the ceiling.
5. **Nested sets.** Depth-1 sets still come from the principal's own rows (`RbacSubjectResolver.memberships`, which carries the via role and expiry for ceilings and `validUntil`); `MembershipStore.setsOf` adds the deeper ones with their membership expiry, which bounds the expiry of every assignment reached through them (so `validUntil` of votes and plans), exactly as a direct membership does. Under a ceiling a nested set grants nothing (a ceiling names the principal's roles; a nested path runs through set rows it cannot name); a deny through it still counts. `setsOf` is read once per request (a request-scope memo; the assignment cache already spans requests). `heldNow` (synchronous covers) ignores nested sets.
6. **`rbac.assignment` args** (owned here; shape of the names table): `{ subjects; membership; memberKeys; roles: { role; scopeTypes?; tag?; descendantsOnly?; relation? }[]; global }`. Meaning: a row matches when an assignment of one of `roles` held by one of `subjects` (or, with `membership`, by a set any of `memberKeys` belongs to, live) is live and lies at the row (not for `descendantsOnly`), at an ancestor, or (with `global`) at `$global`; `scopeTypes` limits the assignment's scope type; `tag` means the same assignment carries the tag; `relation` (`owner` / `self`, overview decision 15) ANDs that role's assignment with the row's relation column from `SqlRowContext.relation(name)` for the principals among `subjects` (no such column on the type: that role contributes FALSE). Permit terms use `global: false` (global assignments are decided in app); deny terms use `global: true` and render the design's single-`EXISTS` deny shape. Deny terms are positive: the plan's consumer negates `deny` terms (`AND NOT (...)`).
7. **Relations in lists.** A relation grant held through a `$global` or type-level assignment becomes a `relation.owner` / `relation.self` term with args `{ principals: { type; id }[] }` (the principal and its companions, raw type and id; L4 compiles it from authz-orm's registry columns). One held through a scoped assignment becomes an `rbac.assignment` role entry with `relation` (decision 6), compiled here. Without a type column the relation names `user` principals only (overview, `ResourceEntry.owner`).
8. **"All but denied"** is `{ kind: 'all', deny: [<deny term>] }` (`ModelListPlan.all` carries an optional `deny`).
9. **requiresTag in lists** follows the tag on the assignment that grants the role. When the principal's tag is carried by an assignment that does not itself reach the grant while some scoped holder lacks it, `listPlan` throws instead of approximating. `listSupport` refuses a grant with both `requiresTag` and `grantedAt`, a `requiresTag` that an implied role's declared tags also carry, and a relation together with either.
10. **Change audience returns no `objects`** (rbac cannot see `authz_resource_ancestor`): a change always means "refetch everything" for its principals (overview decision 16). `subject:<principal key>` and `link:<id>` narrow to that principal, `subject:<set key>` to the set's principal members through `MembershipStore.membersOf`, a wildcard key or any other tag to `'*'`.
11. **SQLite `now`** is bound as the local wall-clock text `SqlDatetimeValueConverter` writes (`YYYY-MM-DD HH:MM:SS.mmm`), so the text comparison with `expires_at` orders correctly; other dialects bind the `Date`.
12. **Rules and lists.** A rule that can match the permission on the type (`ruleCanMatch`: restrict and cap of the type, a threshold naming the permission) narrows checks, which a plan cannot follow; ignoring it would list more than the checks allow. So `listPlan` reads every live rule the model reads (the config store's `all()`, and the DB store whole through `AdminRuleStore.find`, cached per store `version()`), and throws when one matches, naming the rule and warning once per rule id; L2 turns the throw into `deny-all` `model_error` (fail closed, as L10 does for stored policies). A DB store that cannot be listed (not an `AdminRuleStore`) fails every list the same way. With that check done, the row-dependent marker `RulesExtension` sets for a DB store on every type-level request is dropped. `RbacRuleListGuard` (Task 9) keeps new rules off list permissions.
13. **The old type-level list path goes** (Task 11): `rbacAssignmentExtension`, the `native:rbac.assignment` / `native:rbac.threshold` residuals and their in-memory evaluators served authz-orm's removed compilers only. Type-level check votes keep `under` terms; lists use `listPlan`.

## Files

- Modify: `src/model/sets/resolver.ts` (L43-62 `subjects`), `src/model/sets/extension.ts` (whole `gather`, `applyMemberships`, `usableSubjects`), `src/model/model.ts` (options, `init`, `applies`, `sources`, `heldNow`, `configAssignments` L477-489, new `listSupport` / `listPlan`), `src/model/evaluate.ts` (`RbacInput`, `RbacState`, `collect` L181-201, `RBAC_STEPS.collect` L333-338, `liveAssignments` L400-404, `newState` L406-409, `RbacSources`), `src/model/grants.ts` (`GrantIndex`, `compileGrants`), `src/model/roles.ts` (`compileRoles`, `validateRole`), `src/model/service.ts` (`coversAt` L101-109, `coversRoles` L126-145), `src/model/index.ts`, `src/stores/schema.ts` (role L40-61, root properties), `src/stores/config-role-store.ts` (L19, L60-76), `src/admin/common.ts` (`readScope` L281, `readPrincipal` L294, after `surelyGrantsPermission`), `src/admin/guard.ts`, `src/admin/index.ts`, `src/host/register.ts`, `src/host/index.ts`, `src/index.ts`
- Create: `src/model/deny.ts`, `src/model/scope.ts` (Task 11), `src/model/sets/keys.ts`, `src/model/list/support.ts`, `src/model/list/plan.ts`, `src/model/list/index.ts`, `src/plan/args.ts`, `src/plan/assignment-sql.ts`, `src/plan/index.ts`, `src/admin/list-guard.ts`, `src/host/audience.ts`
- Create tests: `test/model/wildcards.test.ts`, `test/model/deny-roles.test.ts`, `test/sets/nested.test.ts`, `test/admin/guard-deny.rbac.test.ts`, `test/model/list-support.test.ts`, `test/plan/assignment-sql.test.ts`, `test/model/list-plan.test.ts`, `test/admin/rule-list-guard.test.ts`, `test/host/audience.test.ts`
- Modify tests: `test/sets/sets.test.ts` (L68, L73-75, L189, L222)
- Task 13: modify `src/admin/guard.ts` (`AdminGuardConfig`, `guardSwitches`, `Call`, `removals`), `src/stores/schema.ts` (`AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA`), `docs/authz/README.md`; create test `test/admin/guard-keep-holders.test.ts`
- Delete (Task 11): `src/model/native.ts`, `src/model/rules/native.ts`, `src/model/rules/args.ts`, `src/model/rules/bind.ts`, `test/model/native.test.ts`, `test/rules/native.test.ts`, `test/behaviour.native.test.ts`; create `docs/plans/authz-v3-rfc/RA8-1.md`

(All paths under `packages/authz-rbac/`.)

---

### Task 1: Wildcard subjects

**Files:**
- Modify: `src/model/sets/resolver.ts`, `src/model/model.ts` (`configAssignments`), `src/admin/common.ts` (`readScope`, `readPrincipal`)
- Modify test: `test/sets/sets.test.ts`
- Test: `test/model/wildcards.test.ts`

**Interfaces:**
- Produces: `WILDCARD_ID = '*'` (`src/model/sets/resolver.ts`); `RbacSubjectResolver.subjects(p)` returns `[principal, ...companions, group sets..., { type: principal.type, id: '*' }, { type: companion.type, id: '*' }...]`, each once.

- [ ] **Step 1: Write the failing test**

Create `test/model/wildcards.test.ts`:

```ts
import { AuthzAdminFailure, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacSubjectResolver } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';
import { readScope, readSubject } from '../../src/admin/common.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');
const svc = servicePrincipal('svc');

const role = (name: string, grants: readonly string[]): RoleDef => ({ name, extends: [], assignable: true, source: 'test', grants: grants.map((permission) => ({ permission })) });
const assignment = (id: string, subject: AssignmentSubject, roleName: string, scope: ResourceRef = GLOBAL): Assignment => ({ id, subject, role: roleName, scope, source: 'test' });

async function model(rows: readonly Assignment[]): Promise<RbacModel> {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'file:read', types: ['project', 'file'] }], 'test');
  registry.freeze();
  const m = new RbacModel({ roles: new MemoryRoleStore([role('viewer', ['file:read'])]), assignments: new MemoryAssignmentStore(rows), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  m.grantIndex();
  return m;
}

const scopes = new FakeScopeResolver({ types: ['project', 'file'], nodes: [{ ref: P1 }, { ref: f1, parent: P1 }] });
const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

describe('authz-rbac wildcard subjects (design §4.2)', () => {
  it('the resolver adds <type>:* for the principal and each companion, after the principals', () => {
    const p = servicePrincipal('svc', { companions: [alice] });
    expect(new RbacSubjectResolver().subjects(p)).to.deep.equal([{ type: 'service', id: 'svc' }, { type: 'user', id: 'alice' }, { type: 'service', id: '*' }, { type: 'user', id: '*' }]);
  });

  it('a principal whose id is * is no subject of its own, only its type wildcard', () => {
    expect(new RbacSubjectResolver().subjects(userPrincipal('*'))).to.deep.equal([{ type: 'user', id: '*' }]);
  });

  it('a role assigned to user:* holds for every user and for no other type', async () => {
    const m = await model([assignment('w1', { type: 'user', id: '*' }, 'viewer', P1)]);
    expect((await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('true');
    expect((await m.evaluate({ principal: svc, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('false');
  });

  it('admin input refuses a subject type * and a scope id *', () => {
    expect(readSubject({ type: 'user', id: '*' }, 'subject')).to.deep.equal({ type: 'user', id: '*' });
    for (const [v, field] of [
      [{ type: '*', id: '*' }, 'subject'],
      [{ type: '*', id: 'x' }, 'subject'],
      [{ set: { role: 'member', scope: { type: 'team', id: '*' } } }, 'subject.set.scope'],
    ] as const) {
      let caught: unknown;
      try {
        readSubject(v, 'subject');
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(v)).to.be.instanceOf(AuthzAdminFailure);
      expect((caught as AuthzAdminFailure).field).to.equal(field);
    }
    expect(() => readScope({ type: 'invoice', id: '*' }, 'scope')).to.throw(AuthzAdminFailure, "'*' is a wildcard of principal subjects only");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/wildcards.test.ts`
Expected: FAIL: the resolver case (no wildcards), the `user:*` case (`'false'` for alice) and the admin case (no refusal).

- [ ] **Step 3: Implement**

In `src/model/sets/resolver.ts` add after `DEFAULT_GROUP_PRINCIPAL`:

```ts
/** The id of a wildcard subject: `{ type: 'user', id: '*' }` stands for every principal of type `user`. */
export const WILDCARD_ID = '*';
```

and replace `subjects` (L51-62) with:

```ts
  subjects(p: Principal): readonly AssignmentSubject[] {
    const out = new Map<string, AssignmentSubject>();
    const add = (s: AssignmentSubject) => out.set(subjectKey(s), s);
    const everyone = [p, ...(p.companions ?? [])];
    for (const who of everyone) {
      // `{ type, id: '*' }` is the wildcard subject: a principal named '*' is reached through it alone.
      if (who.id !== WILDCARD_ID) add({ type: who.type, id: who.id });
      if (this.group && who.type === 'group') add({ set: { role: this.group.role, scope: { type: this.group.scopeType, id: who.id } } });
    }
    for (const who of everyone) add({ type: who.type, id: WILDCARD_ID });
    return [...out.values()];
  }
```

Update its doc comment's first sentence to: `The model's default SubjectResolver (design §6.1.3, §4.2): the principal, its companions, for a group principal its member set, and the wildcard of each of their types.`

In `src/model/model.ts` `configAssignments` (L482-483), replace `if ('set' in s) continue;` with:

```ts
    // Config roles belong to the principal itself; its wildcard would add them twice.
    if ('set' in s || s.id === WILDCARD_ID) continue;
```

and import `WILDCARD_ID` with `RbacSubjectResolver` (L14): `import { RbacSubjectResolver, WILDCARD_ID, groupPrincipalConfig } from './sets/resolver.js';`.

In `src/admin/common.ts`, `readScope` (L281) becomes:

```ts
export function readScope(v: unknown, field: string): ResourceRef {
  const ref = readRef(v, field);
  if (ref.type !== GLOBAL.type && ref.id === undefined) throw invalid(field, `${field} must be GLOBAL or name one resource (a type and an id)`);
  if (ref.id === '*') throw invalid(field, `${field} must name one resource; '*' is a wildcard of principal subjects only`);
  return ref.type === GLOBAL.type ? { type: GLOBAL.type } : ref;
}
```

and `readPrincipal` (L294) becomes:

```ts
export function readPrincipal(v: unknown, field: string): PrincipalRef {
  if (!isObject(v) || typeof v.type !== 'string' || v.type === '' || typeof v.id !== 'string' || v.id === '') throw invalid(field, `${field} must be a principal ref { type, id }`);
  if (v.type === '*') throw invalid(field, `${field} must name a principal type; '*:*' is refused, a wildcard is { type, id: '*' }`);
  return copyPrincipalRef(v as unknown as PrincipalRef);
}
```

- [ ] **Step 4: Update the resolver expectations of `test/sets/sets.test.ts`**

- L68: `.to.deep.equal([to(svc), to(alice), { type: 'service', id: '*' }, { type: 'user', id: '*' }]);`
- L73: `.to.deep.equal([to(g1), setOf('group.member', G1), { type: 'group', id: '*' }]);`
- L74: `.to.deep.equal([to(g1), setOf('team', { type: 'team', id: 'g1' }), { type: 'group', id: '*' }]);`
- L75: `.to.deep.equal([to(g1), { type: 'group', id: '*' }]);`
- L189: `expect(store.reads).to.deep.equal([['user:alice', 'user:*'], [subjectKey(setOf('org.member', O1))]]);`
- L222: `args: { v: 1, subjects: [setOf('org.member', O1), { type: 'user', id: '*' }, to(alice)], roles: ['viewer'] }` (canonical order: `%set:` < `user:*` < `user:alice`).

- [ ] **Step 5: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/wildcards.test.ts test/sets/sets.test.ts`
Expected: PASS, `0 failing`.

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`. Any other failure is a deep-equal on resolver subjects, a `native:rbac.assignment` args list or a store read list: add `{ type: <principal type>, id: '*' }` (or `'<type>:*'`) in its sorted position as in Step 4, and nothing else.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/model/sets/resolver.ts packages/authz-rbac/src/model/model.ts packages/authz-rbac/src/admin/common.ts packages/authz-rbac/test
git commit -m "feat(authz-rbac): wildcard subjects (<type>:*) for checks; admin refuses *:* and scope id *"
```

---

### Task 2: Deny role definitions

**Files:**
- Modify: `src/model/roles.ts`, `src/stores/schema.ts`, `src/stores/config-role-store.ts`
- Test: `test/model/deny-roles.test.ts` (created here; Task 3 appends)

**Interfaces:**
- Consumes: L0 `RoleDef.deny?: boolean`.
- Produces: `compileRoles` refuses the shapes of lane decision 3 with these texts (`<at>` is `Role '<name>' (source: <source>)`):
  - `<at>: deny must be true or false`
  - `<at> is a deny role; a deny role cannot be a subject set`
  - `<at> is a deny role; a deny role cannot be on a ladder`
  - `<at> is a deny role; a deny role cannot imply roles`
  - `<at>: deny grant '<permission>' has <key>; a deny role takes plain permissions or globs only`
  - `<at> is a deny role and extends permit role '<to>'; deny and permit roles do not mix` (`reaches (<via>)` instead of `extends` for a ladder edge)
  - `<at> extends deny role '<to>'; deny and permit roles do not mix`
  - `<at> implies deny role '<to>'; deny and permit roles do not mix`
  - config: `authz.rbac.roles.<name>.deny: must be true or false`

- [ ] **Step 1: Write the failing test**

Create `test/model/deny-roles.test.ts`:

```ts
import { AuthzConfigError } from '@spinajs/authz';
import * as chai from 'chai';
import 'mocha';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA, ConfigRoleStore, compileRoles } from '../../src/index.js';
import type { LadderDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string, grants: readonly (string | Record<string, unknown>)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) as RoleDef['grants'] });
const deny = (name: string, grants: readonly (string | Record<string, unknown>)[] = [], extra: Partial<RoleDef> = {}): RoleDef => role(name, grants, { ...extra, deny: true });

function refused(roles: readonly RoleDef[], ladders: readonly LadderDef[] = []): string {
  try {
    compileRoles(roles, ladders);
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzConfigError);
    return (e as Error).message;
  }
  throw new Error('compileRoles should refuse');
}

describe('authz-rbac deny roles (design §4.2)', () => {
  describe('compile', () => {
    it('accepts a deny role of plain permissions and globs, and one deny role extending another', () => {
      const g = compileRoles([deny('blocked', ['invoice:edit', 'invoice:*']), deny('frozen', [], { extends: ['blocked'] }), role('editor', ['invoice:edit'])]);
      expect(g.get('frozen')?.closure).to.deep.equal(['frozen', 'blocked']);
    });

    it('refuses deny that is not a boolean', () => {
      expect(refused([{ ...role('x'), deny: 'yes' } as unknown as RoleDef])).to.equal("Role 'x' (source: test): deny must be true or false");
    });

    it('refuses qualified deny grants', () => {
      for (const key of ['relation', 'on', 'fields', 'requiresTag', 'grantedAt']) {
        const value = key === 'on' ? [{ type: 'invoice' }] : key === 'fields' ? { read: ['*'] } : key === 'grantedAt' ? ['org'] : 'owner';
        expect(refused([deny('blocked', [{ permission: 'invoice:edit', [key]: value }])])).to.equal(`Role 'blocked' (source: test): deny grant 'invoice:edit' has ${key}; a deny role takes plain permissions or globs only`);
      }
    });

    it('refuses a deny role as a subject set, on a ladder or with implies', () => {
      expect(refused([deny('blocked', [], { subjectSet: true })])).to.equal("Role 'blocked' (source: test) is a deny role; a deny role cannot be a subject set");
      expect(refused([deny('blocked', [], { ladder: 'l' }), role('low', [], { ladder: 'l' })], [{ name: 'l', roles: ['low', 'blocked'] }])).to.equal("Role 'blocked' (source: test) is a deny role; a deny role cannot be on a ladder");
      expect(refused([deny('blocked', [], { implies: [{ role: 'blocked2', at: 'descendants' }] }), deny('blocked2')])).to.equal("Role 'blocked' (source: test) is a deny role; a deny role cannot imply roles");
    });

    it('refuses extends and implies between deny and permit roles', () => {
      expect(refused([deny('blocked', [], { extends: ['editor'] }), role('editor')])).to.equal("Role 'blocked' (source: test) is a deny role and extends permit role 'editor'; deny and permit roles do not mix");
      expect(refused([role('editor', [], { extends: ['blocked'] }), deny('blocked')])).to.equal("Role 'editor' (source: test) extends deny role 'blocked'; deny and permit roles do not mix");
      expect(refused([role('editor', [], { implies: [{ role: 'blocked', at: 'self-and-descendants' }] }), deny('blocked')])).to.equal("Role 'editor' (source: test) implies deny role 'blocked'; deny and permit roles do not mix");
    });
  });

  describe('config', () => {
    it('the schema takes deny: boolean', () => {
      const roleSchema = (AUTHZ_RBAC_CONFIGURATION_SCHEMA.properties.roles as { additionalProperties: { properties: Record<string, unknown> } }).additionalProperties;
      expect(roleSchema.properties.deny).to.deep.equal({ type: 'boolean' });
    });

    it('ConfigRoleStore passes deny through and refuses a non-boolean', async () => {
      const store = (roles: unknown) => new ConfigRoleStore({ get: <T>(path: string | string[]) => ((Array.isArray(path) && path[2] === 'roles' ? roles : undefined) as T) });
      const { roles } = await store({ blocked: { deny: true, grants: ['invoice:edit'] } }).load();
      expect(roles[0]).to.deep.include({ name: 'blocked', deny: true });
      let caught: unknown;
      try {
        await store({ blocked: { deny: 'yes', grants: [] } }).load();
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).to.equal('authz.rbac.roles.blocked.deny: must be true or false');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/deny-roles.test.ts`
Expected: FAIL: `compileRoles should refuse` in the refusal cases, the schema case (`undefined`), and `authz.rbac.roles.blocked.deny: is not a known key` in the config case.

- [ ] **Step 3: Implement the compile checks**

In `src/model/roles.ts`, in `validateRole` add before the closing brace:

```ts
  if (d.deny !== undefined && typeof d.deny !== 'boolean') throw new AuthzConfigError(`${at}: deny must be true or false`);
```

In `compileRoles`, after `refuseCycles(defs, edges);` add `refuseDenyMixing(defs, edges);`, and add the function after `refuseCycles`:

```ts
const DENY_GRANT_KEYS = ['relation', 'on', 'fields', 'requiresTag', 'grantedAt'] as const;

/** Design §4.2: a deny role subtracts plain permissions, and no edge passes grants between deny and permit roles. */
function refuseDenyMixing(defs: ReadonlyMap<string, RoleDef>, edges: ReadonlyMap<string, readonly OutEdge[]>): void {
  const isDeny = (name: string) => defs.get(name)?.deny === true;
  for (const [name, def] of defs) {
    const at = `Role '${name}' (source: ${def.source})`;
    if (isDeny(name)) {
      if (def.subjectSet === true) throw new AuthzConfigError(`${at} is a deny role; a deny role cannot be a subject set`);
      if (def.ladder !== undefined) throw new AuthzConfigError(`${at} is a deny role; a deny role cannot be on a ladder`);
      if (Array.isArray(def.implies) && def.implies.length > 0) throw new AuthzConfigError(`${at} is a deny role; a deny role cannot imply roles`);
      for (const g of def.grants) {
        if (typeof g !== 'object' || g === null) continue;
        const key = DENY_GRANT_KEYS.find((k) => (g as unknown as Record<string, unknown>)[k] !== undefined);
        if (key !== undefined) throw new AuthzConfigError(`${at}: deny grant '${g.permission}' has ${key}; a deny role takes plain permissions or globs only`);
      }
    }
    for (const { to, via } of edges.get(name)!) {
      if (isDeny(name) === isDeny(to)) continue;
      const how = via === 'extends' ? 'extends' : `reaches (${via})`;
      throw new AuthzConfigError(isDeny(name) ? `${at} is a deny role and ${how} permit role '${to}'; deny and permit roles do not mix` : `${at} ${how} deny role '${to}'; deny and permit roles do not mix`);
    }
    if (!isDeny(name) && Array.isArray(def.implies)) {
      for (const e of def.implies) if (typeof e?.role === 'string' && isDeny(e.role)) throw new AuthzConfigError(`${at} implies deny role '${e.role}'; deny and permit roles do not mix`);
    }
  }
}
```

(A deny role listed in a ladder but naming none is already refused by `ladderMembership`; one naming a ladder is refused above before the ladder edges are read, because `roleEdges` ran but `refuseDenyMixing` checks `def.ladder` first for each role in definition order — if a ladder edge error appears first in a test, it names the same role, which is fine.)

- [ ] **Step 4: Implement the config side**

In `src/stores/schema.ts`, add to the `role` closed object (after `subjectSet`):

```ts
  deny: { type: 'boolean' },
```

In `src/stores/config-role-store.ts`, L19 becomes:

```ts
const ROLE_KEYS = ['ladder', 'extends', 'grants', 'revoke', 'implies', 'subjectSet', 'deny', 'assignable', 'scopeTypes', 'description'];
```

and in `role()` after the `scopeTypes` refuse line add:

```ts
  refuse(rest.deny !== undefined && typeof rest.deny !== 'boolean', `${path}.deny`, 'must be true or false');
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/deny-roles.test.ts test/model/roles.test.ts`
Expected: PASS, `0 failing`. If the ladder case reports the ladder-edge text instead (`... is a deny role and reaches (ladder 'l') permit role 'low' ...`), the order in Step 3 is not as written: `def.ladder` must be checked before the edges of that role.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/model/roles.ts packages/authz-rbac/src/stores/schema.ts packages/authz-rbac/src/stores/config-role-store.ts packages/authz-rbac/test/model/deny-roles.test.ts
git commit -m "feat(authz-rbac): deny role definitions (deny: true) and their boot checks"
```

---

### Task 3: Deny roles in checks

**Files:**
- Create: `src/model/deny.ts`
- Modify: `src/model/grants.ts`, `src/model/evaluate.ts`, `src/model/model.ts` (`applies`), `src/model/service.ts`, `src/model/index.ts`
- Test: `test/model/deny-roles.test.ts` (append)

**Interfaces:**
- Produces:
  - `GrantIndex.denies(role: string, permission: Permission): boolean`, `GrantIndex.deniedPermissions(role: string): readonly Permission[]` (sorted), `GrantIndex.denied(permission: Permission): boolean`; `grants()` / `permissions()` / `granted()` never include deny roles.
  - `RbacState.denied: LiveAssignment[]`; `liveAssignments()` returns `{ live, scoped, denied }`.
  - `isDenyRole(roles: RoleGraph, role: string): boolean`, `roleDenied(roles: readonly string[]): DenyReason` (`{ code: 'role_denied', role: <first by code point>, priority: 150 }`), step `applyDenyRoles` (in `RBAC_STEPS.collect`, last), all in `src/model/deny.ts`.
  - `RbacModel.applies` is true when a permit role grants or a deny role denies the permission.
  - `RbacService.coversAt` is false when a live deny on the path of `at` denies a permission the wanted roles hand out.

- [ ] **Step 1: Append the failing tests**

Append to `test/model/deny-roles.test.ts` (add the imports to the top of the file: `import { DEFAULT_DENY_PRIORITY, FALSE, GLOBAL, PermissionRegistryImpl, SYSTEM, TRUE } from '@spinajs/authz';`, `import type { Assignment, EvaluationContext, ResourceRef } from '@spinajs/authz';`, `import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';`, and extend the src import with `MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacService, compileGrants, runRbacPipeline` and the type import with `RbacInput`):

```ts
const NOW = new Date('2026-10-14T12:00:00.000Z');
const F1: ResourceRef = { type: 'folder', id: 'f1' };
const F2: ResourceRef = { type: 'folder', id: 'f2' };
const I42: ResourceRef = { type: 'invoice', id: '42' };
const alice = userPrincipal('alice');
const ROLE_DENIED = { code: 'role_denied', role: 'blocked', priority: DEFAULT_DENY_PRIORITY.role_denied };
const ROLES = [role('editor', ['invoice:edit', 'invoice:read']), deny('blocked', ['invoice:edit'])];

function registry(): PermissionRegistryImpl {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'invoice:edit', types: ['invoice', 'folder'], implies: ['invoice:read'] },
      { name: 'invoice:read', types: ['invoice', 'folder'] },
      { name: 'invoice:delete', types: ['invoice', 'folder'] },
    ],
    'test',
  );
  r.freeze();
  return r;
}

const row = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test', ...extra });

function input(assignments: readonly Assignment[], permission: string, opts: { resource?: ResourceRef; path?: readonly ResourceRef[]; principal?: typeof alice; roles?: readonly RoleDef[] } = {}): RbacInput {
  const roles = compileRoles(opts.roles ?? ROLES);
  const resource = opts.resource ?? I42;
  return { request: { principal: opts.principal ?? alice, permission, resource }, now: NOW, path: opts.path ?? [I42, F1, GLOBAL], assignments, roles, grants: compileGrants(roles, registry()) };
}

describe('authz-rbac deny roles in checks', () => {
  it('the grant index keeps deny roles out of the permits and follows no implies', () => {
    const grants = compileGrants(compileRoles(ROLES), registry());
    expect(grants.grants('blocked', 'invoice:edit')).to.deep.equal([]);
    expect(grants.permissions('blocked')).to.deep.equal([]);
    expect(grants.denies('blocked', 'invoice:edit')).to.equal(true);
    expect(grants.denies('blocked', 'invoice:read')).to.equal(false);
    expect(grants.deniedPermissions('blocked')).to.deep.equal(['invoice:edit']);
    expect(grants.denied('invoice:edit')).to.equal(true);
    expect(compileGrants(compileRoles([deny('nodelete', ['invoice:delete'])]), registry()).granted('invoice:delete')).to.equal(false);
  });

  it('a deny at an ancestor beats a global permit, with role_denied', () => {
    const vote = runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:edit'));
    expect(vote.permitWhen).to.deep.equal(TRUE);
    expect(vote.denyWhen).to.deep.equal(TRUE);
    expect(vote.denies).to.deep.equal([{ when: TRUE, reason: ROLE_DENIED }]);
  });

  it('denies only what it names, only on its path', () => {
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:read')).denyWhen).to.deep.equal(FALSE);
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F2)], 'invoice:edit')).denyWhen).to.deep.equal(FALSE);
  });

  it('on a type-level request a scoped deny denies the rows under its scope', () => {
    const vote = runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:edit', { resource: { type: 'invoice' }, path: [{ type: 'invoice' }, GLOBAL] }));
    expect(vote.denyWhen).to.deep.equal({ op: 'under', scopes: [F1] });
  });

  it('a ceiling never drops a deny', () => {
    const vote = runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1)], 'invoice:edit', { principal: withCeiling(alice, { roles: ['editor'] }) }));
    expect(vote.denyWhen).to.deep.equal(TRUE);
  });

  it('an expired deny is gone, and a live one bounds validUntil', () => {
    const past = new Date(NOW.getTime() - 1);
    const soon = new Date(NOW.getTime() + 60_000);
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1, { expiresAt: past })], 'invoice:edit')).denyWhen).to.deep.equal(FALSE);
    expect(runRbacPipeline(input([row('e', 'editor'), row('b', 'blocked', F1, { expiresAt: soon })], 'invoice:edit')).validUntil).to.deep.equal(soon);
  });

  describe('through the model', () => {
    const scopes = new FakeScopeResolver({ types: ['folder', 'invoice'], nodes: [{ ref: F1 }, { ref: I42, parent: F1 }] });
    const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

    async function model(rows: readonly Assignment[], roles: readonly RoleDef[] = ROLES): Promise<RbacModel> {
      const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(rows), log: { warn: () => undefined } });
      await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
      m.grantIndex();
      return m;
    }

    it('applies routes a permission only a deny role names', async () => {
      const m = await model([], [deny('nodelete', ['invoice:delete'])]);
      expect(m.applies(registry().require('invoice:delete'), 'invoice')).to.equal(true);
    });

    it('RbacService.coversAt refuses what a live deny on the path removes', async () => {
      const m = await model([row('e', 'editor'), row('b', 'blocked', F1)]);
      const service = new RbacService(m);
      expect(await service.coversAt(alice, ['editor'], I42, ctx())).to.equal(false);
      expect(await service.coversAt(alice, ['editor'], { type: 'folder', id: 'other' }, fakeEvaluationContext({ now: NOW, scopeResolvers: [new FakeScopeResolver({ types: ['folder'], nodes: [{ ref: { type: 'folder', id: 'other' } }] })] }))).to.equal(true);
    });

    it('SYSTEM is not subject to deny roles: the engine allows it before any model runs', () => {
      // authorizer.ts answers SYSTEM with TRUE and no models (B09); a deny assignment cannot name SYSTEM's singleton either.
      expect(SYSTEM.type).to.be.a('string');
    });
  });
});
```

(The SYSTEM case only documents the engine rule; the engine-level proof is in Task 5's harness test.)

- [ ] **Step 2: Run to verify the new cases fail**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/deny-roles.test.ts`
Expected: FAIL: TSError `Property 'denies' does not exist on type 'GrantIndex'`.

- [ ] **Step 3: Grant index**

In `src/model/grants.ts`, add to `interface GrantIndex` (after `granted`):

```ts
  /** Deny roles only: whether `role` denies `permission` (its grants and those of the deny roles it extends, globs expanded, `implies` not followed). */
  denies(role: string, permission: Permission): boolean;
  /** Sorted; empty for a permit role. */
  deniedPermissions(role: string): readonly Permission[];
  /** Some deny role denies it. */
  denied(permission: Permission): boolean;
```

In `compileGrants` replace the first loop (`for (const name of graph.names) own.set(...)`) with:

```ts
  const ownDenied = new Map<string, readonly Permission[]>();
  for (const name of graph.names) {
    const def = graph.get(name)!.def;
    if (def.deny === true) {
      own.set(name, new Map());
      ownDenied.set(name, deniedOf(def, registry, notes));
    } else {
      own.set(name, ownGrants(def, registry, notes));
    }
  }
```

before `return Object.freeze({` add:

```ts
  const denials = new Map<string, readonly Permission[]>();
  const denied = new Set<Permission>();
  for (const name of graph.names) {
    if (graph.get(name)!.def.deny !== true) continue;
    const list = [...new Set(graph.get(name)!.closure.flatMap((r) => ownDenied.get(r) ?? []))].sort(compareCodePoints);
    denials.set(name, Object.freeze(list));
    for (const p of list) denied.add(p);
  }
```

and add to the returned object:

```ts
    denies: (role: string, permission: Permission) => denials.get(role)?.includes(permission) === true,
    deniedPermissions: (role: string) => denials.get(role) ?? NONE,
    denied: (permission: Permission) => denied.has(permission),
```

Add after `ownGrants`:

```ts
/** The registered permissions a deny role names, never what they imply (lane decision 2). */
function deniedOf(role: RoleDef, registry: PermissionRegistry, notes: Notes): readonly Permission[] {
  const at = `Role '${role.name}' (source: ${role.source})`;
  const out: Permission[] = [];
  for (const grant of role.grants) {
    validateGrant(grant, at);
    const direct = matchGrant(grant, registry, at);
    if (direct.length === 0) notes.unmatchedGlobs.push({ role: role.name, glob: grant.permission });
    out.push(...direct.map((d) => d.name));
  }
  return out;
}
```

Run `grep -rn "unmatchedGlobs:" packages/authz-rbac/test packages/authz-rbac/src`; any hand-built `GrantIndex` object literal outside `grants.ts` gets `denies: () => false, deniedPermissions: () => [], denied: () => false`.

- [ ] **Step 4: The deny step**

Create `src/model/deny.ts`:

```ts
import { DEFAULT_DENY_PRIORITY, TRUE } from '@spinajs/authz';
import type { DenyReason } from '@spinajs/authz';

import type { RbacStep } from './evaluate.js';
import { scopeMatcher } from './native.js';
import type { RoleGraph } from './roles.js';
import { underTerm } from './rows.js';

export const isDenyRole = (roles: RoleGraph, role: string): boolean => roles.get(role)?.def.deny === true;

export function roleDenied(roles: readonly string[]): DenyReason {
  return { code: 'role_denied', role: [...roles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0], priority: DEFAULT_DENY_PRIORITY.role_denied };
}

/**
 * Design §4.2: a live assignment of a deny role naming the permission denies it at its scope and below,
 * over every permit. On the path it denies the request (every row of a type-level one); off the path of a
 * type-level request it denies the rows under its scope.
 */
export const applyDenyRoles: RbacStep = (s) => {
  const covering = s.denied.filter((l) => s.input.grants.denies(l.role, s.permission));
  if (covering.length === 0) return;
  const type = s.input.request.resource.type;
  const onPath = scopeMatcher(type, s.input.path);
  const here = covering.filter((l) => onPath(l.scope));
  s.denies.push({ when: here.length > 0 ? TRUE : underTerm(covering, type), reason: roleDenied((here.length > 0 ? here : covering).map((l) => l.role)) });
  const ends = covering.flatMap((l) => (l.expiresAt ? [l.expiresAt.getTime()] : []));
  if (s.validUntil) ends.push(s.validUntil.getTime());
  if (ends.length > 0) s.validUntil = new Date(Math.min(...ends));
};
```

(`scopeMatcher` lives in `native.ts` as `collect` imports it; if it moved, import it from where `evaluate.ts` does.)

- [ ] **Step 5: The pipeline**

In `src/model/evaluate.ts`:

Add the import `import { applyDenyRoles, isDenyRole } from './deny.js';`.

In `interface RbacState`, after `scoped`, add:

```ts
  /** collect: assignments of deny roles, on the path and (type-level) below it; ceilings and rules never drop them (design §4.2). */
  denied: LiveAssignment[];
```

In `collect` (L181-201), replace the line computing `here` and the first `if` with:

```ts
    const here = onPath(a.scope);
    const denies = isDenyRole(roles, a.role);
    // Ceilings narrow permits only: a deny always counts.
    if ((!here && (!typeLevel || a.scope.id == null)) || !(denies || withinCeiling(s, a.role))) continue;
```

and the final push with:

```ts
    (denies ? s.denied : here ? s.live : s.scoped).push({ assignment: a, role: a.role, scope: a.scope, tags: a.tags ?? [], ...(expires !== undefined ? { expiresAt: new Date(expires) } : {}), bypass: new Set() });
```

`RBAC_STEPS.collect` (L333-338) becomes:

```ts
  collect: (s: RbacState) => {
    collect(s);
    applyMemberships(s);
    addImplied(s);
    rankAssignments(s);
    applyDenyRoles(s);
  },
```

`liveAssignments` (L400-404) returns the deny rows too:

```ts
export function liveAssignments(input: RbacInput, opts: { readonly ceiling?: boolean } = {}, steps: RbacSteps = RBAC_STEPS): { readonly live: readonly LiveAssignment[]; readonly scoped: readonly LiveAssignment[]; readonly denied: readonly LiveAssignment[] } {
  const state = newState(input, opts.ceiling !== false);
  for (const name of ['collect', 'restrict', 'cap'] as const) steps[name](state);
  return { live: state.live, scoped: state.scoped, denied: state.denied };
}
```

`newState` (L408): add `denied: [],` after `scoped: [],`.

In `src/model/sets/extension.ts`, `applyMemberships` also passes the deny rows through the memberships, without the ceiling (Task 4 rewrites this file; for now):

```ts
export const applyMemberships: RbacStep = (s) => {
  const memberships = s.input.memberships;
  if (!memberships) return;
  s.live = s.live.flatMap((l) => throughMembership(s, memberships, l, false));
  s.scoped = s.scoped.flatMap((l) => throughMembership(s, memberships, l, false));
  s.denied = s.denied.flatMap((l) => throughMembership(s, memberships, l, true));
};

function throughMembership(s: RbacState, memberships: SetMemberships, l: LiveAssignment, deny: boolean): LiveAssignment[] {
  const subject = l.assignment.subject;
  const entry = 'set' in subject ? memberships.get(subjectKey(subject)) : undefined;
  if (!entry) return [l];
  const usable = usableVia(s, entry.via, deny);
  if (usable.length === 0) return [];
  if (usable.some((m) => m.expiresAt === undefined)) return [l];
  const end = Math.max(...usable.map((m) => m.expiresAt!.getTime()));
  return l.expiresAt && l.expiresAt.getTime() <= end ? [l] : [{ ...l, expiresAt: new Date(end) }];
}

/** The live memberships among `via`, those whose role passes the ceiling unless `ignoreCeiling` (a deny). */
export function usableVia<T extends { readonly role: string; readonly expiresAt?: Date }>(s: RbacState, via: readonly T[], ignoreCeiling = false): T[] {
  const now = s.input.now.getTime();
  return via.filter((m) => (ignoreCeiling || withinCeiling(s, m.role)) && (m.expiresAt === undefined || m.expiresAt.getTime() > now));
}
```

and in `usableSubjects` replace `usableMemberships(s, entry.via)` with `usableVia(s, entry.via)` (delete the old `usableMemberships`).

In `src/model/model.ts`, `applies` becomes:

```ts
  applies(permission: PermissionDef, _type: ResourceType): boolean {
    const index = this.grantIndex();
    return index.granted(permission.name) || index.denied(permission.name);
  }
```

In `src/model/service.ts`, add `import type { Permission } from '@spinajs/authz';` to the type import of L2 (`import type { EvaluationContext, Permission, Principal, ResourceRef } from '@spinajs/authz';`), `import { scopeMatcher } from './native.js';`, and replace `coversAt`'s last two lines (L107-108) with:

```ts
    const input = await this.model.inputAt(principal, at, ctx);
    const { live, denied } = liveAssignments(input);
    const names = live.map((l) => effectiveRole(input.ladders, l));
    const index = this.model.grantIndex();
    const onPath = scopeMatcher(at.type, input.path);
    // An actor may not hand out what a deny removes from it (design §4.2).
    const removed = new Set(denied.filter((l) => onPath(l.scope)).flatMap((l) => index.deniedPermissions(l.role)));
    return this.coversRoles(names, wanted, limit, removed);
```

and `coversRoles` gets a fourth parameter `denied?: ReadonlySet<Permission>` with, right after `if (limit && !limit.allows(permission)) return false;`:

```ts
        if (denied?.has(permission)) return false;
```

Export the new module: in `src/model/index.ts` add `export * from './deny.js';` after `./ceiling.js`.

- [ ] **Step 6: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/deny-roles.test.ts`
Expected: PASS, `0 failing`.

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-rbac/src/model packages/authz-rbac/test/model/deny-roles.test.ts
git commit -m "feat(authz-rbac): deny role assignments deny with role_denied; ceilings never drop them"
```

---

### Task 4: Nested subject sets through `MembershipStore`

**Files:**
- Create: `src/model/sets/keys.ts`
- Modify: `src/model/sets/extension.ts`, `src/model/sets/index.ts`, `src/model/evaluate.ts` (`RbacInput`, `RbacSources`), `src/model/model.ts` (options, `sources`, `heldNow`), `src/host/register.ts`
- Test: `test/sets/nested.test.ts`

**Interfaces:**
- Consumes: L0 `MembershipStore` (`setsOf(memberKeys, at): Promise<readonly { setKey; expiresAt? }[]>`, `membersOf(setKey, at)`), L6 `subjectKeyOf`.
- Produces: `parseSetKey(key: string): SetSubject | undefined` (inverse of `subjectKeyOf` for sets), `principalSubjectKey(p: PrincipalRef): string` (a principal's own key; id `*` becomes `type:%2A`, never the wildcard), `memberKeysOf(subjects): string[]` (`src/model/sets/keys.ts`); `RbacModelOptions.membership?: MembershipStore`; `RbacSources.setsOf?(memberKeys, ctx): Promise<readonly { setKey: string; expiresAt?: Date }[]>`; `RbacInput.nestedSets?: ReadonlyMap<string, NestedSet>` (by `subjectKey`; `NestedSet = { subject: SetSubject; expiresAt?: Date }`, exported from `sets/extension.ts`); `usableSubjects` drops nested sets under a ceiling. `registerRbac` passes a registered `MembershipStore` to the model.

- [ ] **Step 1: Write the failing test**

Create `test/sets/nested.test.ts`:

```ts
import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, ResourceRef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MembershipStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, parseSetKey, principalSubjectKey, subjectKeyOf } from '../../src/index.js';
import type { RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const T1: ResourceRef = { type: 'team', id: 't1' };
const T2: ResourceRef = { type: 'team', id: 't2' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((permission) => ({ permission })) });
const setOf = (roleName: string, scope: ResourceRef): AssignmentSubject => ({ set: { role: roleName, scope } });
const row = (id: string, subject: AssignmentSubject, roleName: string, scope: ResourceRef = GLOBAL): Assignment => ({ id, subject, role: roleName, scope, source: 'test' });

const ROLES = [role('team.member', [], { subjectSet: true }), role('viewer', ['file:read']), role('blocked', ['file:read'], { deny: true })];
// alice is in t1 by her own row; t1's members are members of t2 (nested); t2's members view P1.
const ROWS = [row('m1', { type: 'user', id: 'alice' }, 'team.member', T1), row('n1', setOf('team.member', T1), 'team.member', T2), row('s1', setOf('team.member', T2), 'viewer', P1)];
const CLOSURE = { 'user:alice': ['team:t1#team.member', 'team:t2#team.member'] };

class FakeMembershipStore extends MembershipStore {
  readonly calls: string[][] = [];
  constructor(private readonly sets: Readonly<Record<string, readonly string[]>>, private readonly ends: Readonly<Record<string, Date>> = {}) {
    super();
  }
  async setsOf(memberKeys: readonly string[]): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    this.calls.push([...memberKeys]);
    const keys = [...new Set(memberKeys.flatMap((k) => this.sets[k] ?? []))];
    return keys.map((setKey) => (this.ends[setKey] ? { setKey, expiresAt: this.ends[setKey] } : { setKey }));
  }
  async membersOf(setKey: string): Promise<readonly string[]> {
    return Object.keys(this.sets).filter((k) => this.sets[k].includes(setKey));
  }
}

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'file:read', types: ['project', 'file'] }], 'test');
  r.freeze();
  return r;
}

const scopes = new FakeScopeResolver({ types: ['project', 'file', 'team'], nodes: [{ ref: P1 }, { ref: f1, parent: P1 }, { ref: T1 }, { ref: T2 }] });
const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] });

async function model(rows: readonly Assignment[], membership?: MembershipStore): Promise<RbacModel> {
  const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(rows), ...(membership ? { membership } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry() }));
  m.grantIndex();
  return m;
}

describe('authz-rbac nested subject sets (design §4.3)', () => {
  it('parseSetKey reads back what subjectKeyOf writes for a set, and nothing for a principal', () => {
    for (const set of [setOf('team.member', T1), setOf('a#b', { type: 'te:am', id: 'x#1*%' })]) expect(parseSetKey(subjectKeyOf(set))).to.deep.equal(set);
    expect(parseSetKey(subjectKeyOf({ type: 'user', id: 'alice' }))).to.equal(undefined);
    expect(parseSetKey('user:*')).to.equal(undefined);
  });

  it('principalSubjectKey never gives the wildcard', () => {
    expect(principalSubjectKey({ type: 'user', id: 'alice' })).to.equal(subjectKeyOf({ type: 'user', id: 'alice' }));
    expect(principalSubjectKey({ type: 'user', id: '*' })).to.equal('user:%2A');
    expect(subjectKeyOf({ type: 'user', id: '*' })).to.equal('user:*');
  });

  it('without a MembershipStore sets stay one level deep', async () => {
    const m = await model(ROWS);
    expect((await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('false');
  });

  it('a set reached through another set grants, cacheable, bounded by the nested membership', async () => {
    const soon = new Date(NOW.getTime() + 60_000);
    const store = new FakeMembershipStore(CLOSURE, { 'team:t2#team.member': soon });
    const m = await model(ROWS, store);
    const vote = await m.evaluate({ principal: alice, permission: 'file:read', resource: f1 }, ctx());
    expect(vote.permitWhen.op).to.equal('true');
    expect(vote.cacheable).to.equal(true);
    expect(vote.validUntil).to.deep.equal(soon);
    expect(store.calls).to.deep.equal([['user:alice', 'user:*']]);
  });

  it('under a ceiling a nested set grants nothing, but its deny still holds', async () => {
    const capped = withCeiling(alice, { roles: ['team.member', 'viewer'] });
    const m = await model(ROWS, new FakeMembershipStore(CLOSURE));
    expect((await m.evaluate({ principal: capped, permission: 'file:read', resource: f1 }, ctx())).permitWhen.op).to.equal('false');
    const d = await model([...ROWS, row('v1', { type: 'user', id: 'alice' }, 'viewer'), row('b1', setOf('team.member', T2), 'blocked', P1)], new FakeMembershipStore(CLOSURE));
    expect((await d.evaluate({ principal: capped, permission: 'file:read', resource: f1 }, ctx())).denyWhen.op).to.equal('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/sets/nested.test.ts`
Expected: FAIL: TSError `Module '"../../src/index.js"' has no exported member 'parseSetKey'` (and `membership` is not an option).

- [ ] **Step 3: Keys**

Create `src/model/sets/keys.ts`:

```ts
import type { AssignmentSubject, PrincipalRef } from '@spinajs/authz';

import { subjectKeyOf } from '../../stores/columns.js';
import { WILDCARD_ID } from './resolver.js';
import type { SetSubject } from './resolver.js';

// subjectKeyOf (L6): the type escapes '%' and ':', the id '%', '#' and '*' (the bare '*' id is the wildcard).
const unescapeType = (t: string): string => t.replace(/%3A/g, ':').replace(/%25/g, '%');
const unescapeId = (id: string): string => id.replace(/%23/g, '#').replace(/%2A/g, '*').replace(/%25/g, '%');

/** The set a `subjectKeyOf` set key (`type:id#role`) names; undefined for a principal key or a malformed one. */
export function parseSetKey(key: string): SetSubject | undefined {
  const colon = key.indexOf(':');
  // '#' is escaped in the id, so the first one after the type ends it; a role may hold '#'.
  const hash = colon < 0 ? -1 : key.indexOf('#', colon + 1);
  if (colon <= 0 || hash < 0 || hash === key.length - 1) return undefined;
  const id = key.slice(colon + 1, hash);
  if (id === '' || id === WILDCARD_ID) return undefined;
  return { set: { role: key.slice(hash + 1), scope: { type: unescapeType(key.slice(0, colon)), id: unescapeId(id) } } };
}

/** A principal's own key: never the wildcard, even for a principal whose id is '*'. */
export function principalSubjectKey(p: PrincipalRef): string {
  if (p.id !== WILDCARD_ID) return subjectKeyOf({ type: p.type, id: p.id });
  const wildcard = subjectKeyOf({ type: p.type, id: WILDCARD_ID });
  return `${wildcard.slice(0, -WILDCARD_ID.length)}%2A`;
}

/** The keys `MembershipStore.setsOf` takes for these subjects, each once, in order. */
export const memberKeysOf = (subjects: readonly AssignmentSubject[]): string[] => [...new Set(subjects.map(subjectKeyOf))];
```

Add `export * from './keys.js';` to `src/model/sets/index.ts`.

- [ ] **Step 4: Input, sources and the extension**

In `src/model/evaluate.ts`:
- `RbacInput`, after `memberships`: 

```ts
  /** Sets the principal reaches only through other sets (MembershipStore), by subjectKey, with the membership's expiry. */
  readonly nestedSets?: ReadonlyMap<string, NestedSet>;
```

  and add the type import `import type { NestedSet } from './sets/extension.js';`.
- `RbacSources`, after `load`:

```ts
  /** The sets the member keys belong to, transitively, with their membership expiry (MembershipStore.setsOf); absent: one level, from the principal's own rows. */
  readonly setsOf?: (memberKeys: readonly string[], ctx: EvaluationContext) => Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]>;
```

Replace `src/model/sets/extension.ts` from the top through `export const setsExtension ...` with:

```ts
import type { Assignment, AssignmentSubject, DecisionRequest, EvaluationContext } from '@spinajs/authz';

import { subjectKey } from '../assignments.js';
import { withinCeiling } from '../ceiling.js';
import type { LiveAssignment, RbacExtension, RbacExtensionFactory, RbacInput, RbacSources, RbacState, RbacStep } from '../evaluate.js';
import { memberKeysOf, parseSetKey } from './keys.js';
import { isSetResolver } from './resolver.js';
import type { SetSubject } from './resolver.js';

type Maybe<T> = T | PromiseLike<T>;

/** A set the principal reaches only through other sets, and when that membership ends. */
export interface NestedSet {
  readonly subject: SetSubject;
  readonly expiresAt?: Date;
}

/**
 * Subject sets (design §6.1.3, §4.3): after the principal's own rows are read, the sets they make it a member
 * of (one level, with the via role and expiry) and, with a MembershipStore, the sets it reaches through other
 * sets are read too, in one more store read, and join `subjects` and `assignments`. Only a resolver with
 * `memberships` (RbacSubjectResolver, the default) names them.
 */
export class SetsExtension implements RbacExtension {
  gather(_request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>> {
    const resolver = sources.subjects;
    if (!isSetResolver(resolver)) return {};
    const base = input.subjects ?? [];
    const baseKeys = new Set(base.map(subjectKey));
    const memberships = resolver.memberships(input.assignments, input.roles, input.now);
    const direct = [...memberships].filter(([key]) => !baseKeys.has(key)).map(([, m]) => m.subject);
    const finish = (found: readonly { readonly setKey: string; readonly expiresAt?: Date }[]): Maybe<Partial<RbacInput>> => {
      const nested = new Map<string, NestedSet>();
      for (const { setKey, expiresAt } of found) {
        const set = parseSetKey(setKey);
        if (!set) throw new Error(`rbac: the membership store returned ${JSON.stringify(setKey)}, which is no set key`);
        const key = subjectKey(set);
        if (!baseKeys.has(key) && !memberships.has(key)) nested.set(key, Object.freeze({ subject: set, ...(expiresAt ? { expiresAt } : {}) }));
      }
      const extra: Partial<RbacInput> = { ...(memberships.size > 0 ? { memberships } : {}), ...(nested.size > 0 ? { nestedSets: nested } : {}) };
      const sets: AssignmentSubject[] = [...direct, ...[...nested.values()].map((n) => n.subject)];
      if (sets.length === 0) return extra;
      const merge = (rows: readonly Assignment[]): Partial<RbacInput> => ({ ...extra, subjects: [...base, ...sets], assignments: [...input.assignments, ...rows] });
      const rows = sources.load ? sources.load(sets, ctx) : sources.assignments.forSubjects(sets, input.now);
      return isThenable(rows) ? Promise.resolve(rows).then(merge) : merge(rows);
    };
    if (!sources.setsOf) {
      const out = finish([]);
      return isThenable(out) ? Promise.resolve(out) : out;
    }
    return sources.setsOf(memberKeysOf(base), ctx).then(finish);
  }
}

export const setsExtension: RbacExtensionFactory = () => new SetsExtension();
```

Replace `applyMemberships`, `throughMembership` and `usableSubjects` (keep `usableVia` from Task 3 and `isThenable`) with:

```ts
/**
 * Step 1, right after collect: an assignment made to a set the principal joined through its own rows holds
 * only while one of those memberships does (its role inside the ceiling, unless the assignment is a deny),
 * and the latest one bounds its expiry. One made to a nested set holds without a ceiling only (lane L8
 * decision 5), bounded by that membership's expiry; a deny holds either way.
 */
export const applyMemberships: RbacStep = (s) => {
  if (!s.input.memberships && !s.input.nestedSets) return;
  s.live = s.live.flatMap((l) => throughMembership(s, l, false));
  s.scoped = s.scoped.flatMap((l) => throughMembership(s, l, false));
  s.denied = s.denied.flatMap((l) => throughMembership(s, l, true));
};

function throughMembership(s: RbacState, l: LiveAssignment, deny: boolean): LiveAssignment[] {
  const subject = l.assignment.subject;
  if (!('set' in subject)) return [l];
  const key = subjectKey(subject);
  const entry = s.input.memberships?.get(key);
  if (entry) {
    const usable = usableVia(s, entry.via, deny);
    if (usable.length === 0) return [];
    if (usable.some((m) => m.expiresAt === undefined)) return [l];
    const end = Math.max(...usable.map((m) => m.expiresAt!.getTime()));
    return l.expiresAt && l.expiresAt.getTime() <= end ? [l] : [{ ...l, expiresAt: new Date(end) }];
  }
  const nested = s.input.nestedSets?.get(key);
  if (!nested) return [l];
  if (!deny && s.ceilingRoles !== undefined) return [];
  const end = nested.expiresAt?.getTime();
  if (end === undefined || (l.expiresAt && l.expiresAt.getTime() <= end)) return [l];
  return end > s.input.now.getTime() ? [{ ...l, expiresAt: new Date(end) }] : [];
}

/** The subjects a list term may name: those of the input, without a set none of whose memberships holds now, nor a nested set under a ceiling. */
export function usableSubjects(s: RbacState): readonly AssignmentSubject[] | undefined {
  const { subjects, memberships, nestedSets } = s.input;
  if (!subjects || (!memberships && !nestedSets)) return subjects;
  return subjects.filter((subject) => {
    if (!('set' in subject)) return true;
    const key = subjectKey(subject);
    const entry = memberships?.get(key);
    if (entry) return usableVia(s, entry.via).length > 0;
    return !nestedSets?.has(key) || s.ceilingRoles === undefined;
  });
}
```

- [ ] **Step 5: The model and the host**

In `src/model/model.ts`:
- import `MembershipStore` as a type: `import type { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore, SubjectResolver } from '../contracts.js';`
- `RbacModelOptions`, after `links`:

```ts
  /** The closure of subject sets (design §4.3); absent: sets are one level deep. */
  readonly membership?: MembershipStore;
```

- `sources()` returns, after `load`:

```ts
      ...(this.opts.membership ? { setsOf: (keys: readonly string[], ctx: EvaluationContext) => this.setsOf(keys, ctx) } : {}),
```

- add the private method after `sources()`:

```ts
  /** One store read per request and member key list; the assignment cache is the cross-request cache. */
  private setsOf(memberKeys: readonly string[], ctx: EvaluationContext): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]> {
    const key = `${SETS_MEMO}${ctx.now.getTime()}:${JSON.stringify([...memberKeys].sort())}`;
    let read = ctx.cache.get(key) as Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]> | undefined;
    if (!read) {
      read = this.opts.membership!.setsOf(memberKeys, ctx.now);
      ctx.cache.set(key, read);
      read.catch(() => ctx.cache.delete(key));
    }
    return read;
  }
```

  with `const SETS_MEMO = '\u0000rbac:sets:';` next to `ROLES_PROBE`.
- in `heldNow`, the extended sources (L251) become `{ ...sources, load: peek, setsOf: undefined }` so a synchronous read never waits on the store.

In `src/host/register.ts`, import `MembershipStore` with the other ports (L5) and, after `const links = await store(LinkStore);`, add:

```ts
  // Registered by authz-rbac's storage lane, possibly in a parent container.
  const membership = container.hasRegistered(MembershipStore) ? ((await container.resolve(MembershipStore)) as MembershipStore) : undefined;
```

and in `options` add `...(membership ? { membership } : {}),` after `links`. (If L6 already passes `membership` here, keep L6's lines and skip this step.)

- [ ] **Step 6: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/sets/nested.test.ts test/sets/sets.test.ts`
Expected: PASS, `0 failing`.

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-rbac/src/model packages/authz-rbac/src/host/register.ts packages/authz-rbac/test/sets/nested.test.ts
git commit -m "feat(authz-rbac): nested subject sets through MembershipStore.setsOf"
```

---

### Task 5: `DefaultAdminGuard` and deny roles

**Files:**
- Modify: `src/admin/common.ts` (after `surelyGrantsPermission`), `src/admin/guard.ts`
- Test: `test/admin/guard-deny.rbac.test.ts`

**Interfaces:**
- Produces: `deniesPermission(roles: RoleIndex, role: string, permission: Permission): boolean`, `isDenyRoleDef(roles: RoleIndex, role: string): boolean` (`src/admin/common.ts`). Guard behaviour: granting a deny role (directly, or by joining a set that holds one) is never `escalation`; a command that gives a deny of `privilegedPermission` (assignment.grant, a later `assignment.setExpiry` of a deny row, `set.addMember` into a set holding one) counts as a removal: `self_lockout` when it reaches the actor (itself, its wildcard, a set it is a member of) at any scope, `last_holder` when at `$global` it takes the last holder's path. Deny roles never count as privileged holders. Revoking a deny row is no removal.

- [ ] **Step 1: Write the failing test**

Create `test/admin/guard-deny.rbac.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin, AuthzCommandResult, AuthzService, Principal } from '@spinajs/authz';

import { rbacAdminHarness } from './rbac-admin-harness.js';

const expect = chai.expect;
const { role, assignment } = fixtureDsl;

const people = Object.fromEntries(['root', 'erin', 'ops', 'dave'].map((id) => [id, userPrincipal(id)]));
const { root, erin, ops, dave } = people;
const P1 = { type: 'project', id: 'p1' };

// users:update is the default privilegedPermission.
const blocked = { ...role('blocked', ['users:update']), deny: true } as ReturnType<typeof role>;
const world = (holders: readonly string[]): World => ({
  now: new Date('2026-10-14T00:00:00.000Z'),
  permissions: [{ name: 'users:update' }, { name: 'authz:assignments.manage' }],
  principals: people,
  combine: fixtureDsl.combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('admin', ['users:update', 'authz:assignments.manage']), role('ops', ['authz:assignments.manage']), blocked],
    assignments: [...holders.map((h) => assignment(`a-${h}`, people[h], 'admin', GLOBAL)), assignment('o-ops', ops, 'ops', GLOBAL)],
  },
});

describe('DefaultAdminGuard and deny roles (design §4.2)', function () {
  this.timeout(30000);
  const harness = rbacAdminHarness();
  let session: HarnessSession;
  let admin: AuthzAdmin;
  let authz: AuthzService;

  before(async () => {
    await harness.beforeAll?.();
  });

  after(async () => {
    await harness.afterAll?.();
  });

  async function open(holders: readonly string[]): Promise<void> {
    session = await harness.setup(world(holders), { id: 'L8', part: 'guard', case: 'deny', title: 'deny roles', facets: ['engine', 'admin', 'rbac'] });
    admin = session.admin as AuthzAdmin;
    authz = session.authz as unknown as AuthzService;
  }

  afterEach(async () => {
    await session?.dispose();
  });

  const grant = (actor: Principal, subject: { type: string; id: string }, scope = GLOBAL) => admin.execute(actor, [{ kind: 'assignment.grant', subject, role: 'blocked', scope }]);
  const code = (results: readonly AuthzCommandResult[]) => (results[0].ok ? 'ok' : results[0].error.code);
  const holds = async (p: Principal) => {
    const d = await authz.check({ principal: p, permission: 'users:update', resource: GLOBAL });
    return d.allowed && d.residual.op === 'true';
  };

  it('granting a deny role is no escalation', async () => {
    await open(['root']);
    expect(code(await grant(ops, dave))).to.equal('ok');
  });

  it('a deny of the privileged permission to its last holder is last_holder, also through a wildcard', async () => {
    await open(['root']);
    expect(code(await grant(ops, root))).to.equal('last_holder');
    expect(code(await grant(ops, { type: 'user', id: '*' }))).to.equal('last_holder');
    expect(await holds(root)).to.equal(true);
  });

  it('a deny of the privileged permission to the actor itself is self_lockout, at any scope', async () => {
    await open(['root', 'erin']);
    expect(code(await grant(root, root))).to.equal('self_lockout');
    expect(code(await grant(root, root, P1))).to.equal('self_lockout');
  });

  it('with another holder left, the deny goes through and removes the permission', async () => {
    await open(['root', 'erin']);
    expect(code(await grant(ops, root))).to.equal('ok');
    expect(await holds(root)).to.equal(false);
    expect(await holds(erin)).to.equal(true);
  });

  it('SYSTEM is not subject to a deny', async () => {
    await open(['root', 'erin']);
    await grant(ops, { type: 'user', id: '*' });
    expect(await holds(SYSTEM)).to.equal(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/guard-deny.rbac.test.ts`
Expected: FAIL: `expected 'ok' to equal 'last_holder'` and `expected 'ok' to equal 'self_lockout'` (the guard does not see denies yet).

- [ ] **Step 3: Helpers in `common.ts`**

Add after `surelyGrantsPermission`:

```ts
export const isDenyRoleDef = (roles: RoleIndex, role: string): boolean => roles.roles.get(role)?.deny === true;

/** A deny role whose grants name `permission` (names or globs; a deny follows no `implies`). */
export function deniesPermission(roles: RoleIndex, role: string, permission: Permission): boolean {
  const def = roles.roles.get(role);
  return def?.deny === true && def.grants.some((g) => matchesAny(g.permission, [permission]));
}
```

- [ ] **Step 4: The guard**

In `src/admin/guard.ts`:

Import line 8 gains `deniesPermission, isDenyRoleDef, readPrincipal` (alphabetical with the others).

After `type SetRow = ...` add:

```ts
/** A deny of privilegedPermission a command gives `subject` at `scope` (design §4.2: the guard counts it as a revoke). */
interface Denial {
  readonly subject: AssignmentSubject;
  readonly scope: ResourceRef;
  /** null: it never ends. */
  readonly expiresAt: Date | null;
}
```

Replace `sameSubject` (L97) with:

```ts
const sameSubject = (s: AssignmentSubject, p: PrincipalRef): boolean => !isSetSubject(s) && (principalKey(s) === principalKey(p) || (s.id === '*' && s.type === p.type));
```

In `escalation`, the loop head becomes:

```ts
    for (const t of await this.granted(call, c)) {
      // A deny role only takes permissions away (design §4.2).
      if (isDenyRoleDef(call.roles, t.role)) continue;
```

In `removals`, replace from `const until = ...` through the end of the method with:

```ts
    const until = 'expiresAt' in c ? readExpiry(c.expiresAt) : undefined;
    const removed = [
      ...planned.revoke.filter((a) => isLive(a.expiresAt, ctx.now)),
      // Moving an expiry later takes nothing away; renewing a lapsed row is such a move.
      ...planned.expire.filter((a) => !(a.expiresAt != null && until != null && until.getTime() > a.expiresAt.getTime())),
    ];
    if (cfg.privilegedPermission === undefined) return;
    const denials = await this.denials(call, c, cfg.privilegedPermission);
    if (removed.length === 0 && denials.length === 0) return;
    const permissions = await grantingPermissions(ctx, cfg.privilegedPermission);
    const memo = new Map<string, boolean>();
    const privileged = (role: string): boolean => {
      if (!memo.has(role)) memo.set(role, roles.roles.has(role) && !isDenyRoleDef(roles, role) && grantsPermission(roles, role, permissions));
      return memo.get(role)!;
    };
    const paths: Paths = { permissions, privileged };
    if (cfg.preventSelfLockout && (await this.locksOut(call, paths, removed, denials))) throw refuse('self_lockout', `${principalKey(call.actor)} would lose ${quote(cfg.privilegedPermission)}`, idField(c));
    if (cfg.preventLastPrivilegedRemoval && (await this.lastHolder(call, paths, removed, denials.filter((d) => d.scope.type === GLOBAL.type)))) throw refuse('last_holder', `no principal would keep ${quote(cfg.privilegedPermission)} at GLOBAL`, idField(c));
  }

  /** The denies of `permission` a command gives: a grant of a deny role, a later expiry of a deny row, joining a set that holds one. */
  private async denials(call: Call, c: AuthzCommand, permission: Permission): Promise<Denial[]> {
    const denies = (role: string) => deniesPermission(call.roles, role, permission);
    switch (c.kind) {
      case 'assignment.grant': {
        const role = readId(c.role, 'role');
        return denies(role) ? [{ subject: c.subject as AssignmentSubject, scope: readScope(c.scope, 'scope'), expiresAt: readExpiry(c.expiresAt) ?? null }] : [];
      }
      case 'assignment.setExpiry': {
        const row = await (await assignmentStore(call.ctx)).byId(readId(c.id));
        if (!row || !denies(row.role) || !extendsExpiry(row.expiresAt, c.expiresAt)) return [];
        return [{ subject: row.subject, scope: row.scope, expiresAt: readExpiry(c.expiresAt) ?? null }];
      }
      case 'set.addMember': {
        const set = c.set as { role?: unknown; scope?: unknown };
        const member = readPrincipal(c.member, 'member');
        const joined = readExpiry(c.expiresAt) ?? null;
        const rows = await this.setRows(call, readId(set.role, 'set.role'), readScope(set.scope, 'set.scope'));
        return rows.filter((r) => denies(r.role)).map((r) => ({ subject: member, scope: r.scope, expiresAt: earliest(r.expiresAt ?? null, joined) }));
      }
      default:
        return [];
    }
  }
```

`locksOut` gets a fourth parameter and checks the denials last:

```ts
  private async locksOut(call: Call, paths: Paths, removed: readonly Assignment[], denials: readonly Denial[]): Promise<boolean> {
    for (const a of removed) {
      if (isSetSubject(a.subject)) {
        if (paths.privileged(a.role) && (await this.setMembers(call, a.subject.set, call.actor)).length > 0) return true;
        continue;
      }
      if (!sameSubject(a.subject, call.actor)) continue;
      if (paths.privileged(a.role)) return true;
      if ((await this.setRows(call, a.role, a.scope)).some((s) => paths.privileged(s.role))) return true;
    }
    for (const d of denials) if (await this.deniedTo(call, call.actor, d)) return true;
    return false;
  }
```

`lastHolder` gets a fourth parameter `denials: readonly Denial[]` (`$global` ones only); replace from `if (lost.length === 0) return false;` to the end of the method with:

```ts
    if (lost.length === 0 && denials.length === 0) return false;
    const ends = [...lost.map((r) => r.expiresAt ?? null), ...denials.map((d) => d.expiresAt)];
    const until = ends.some((e) => e === null) ? null : Math.max(...ends.map((e) => e!.getTime()));
    const lasts = (r: Assignment) => r.expiresAt == null || (until !== null && r.expiresAt.getTime() >= until);
    const sure = new Map<string, boolean>();
    const surely = (role: string): boolean => {
      if (!sure.has(role)) sure.set(role, surelyGrantsPermission(call.roles, role, paths.permissions, GLOBAL));
      return sure.get(role)!;
    };
    // A set member's live row carries the GLOBAL set row's role, so that role decides for both kinds of path. A wildcard row names no account.
    let holders = kept.filter(({ holder, global, rows }) => !isLinkSubject(holder) && holder.id !== '*' && surely(global.role) && rows.every(lasts)).map(({ holder }) => holder);
    if (denials.length > 0) {
      const left: PrincipalRef[] = [];
      for (const h of holders) if (!(await this.anyDenial(call, h, denials))) left.push(h);
      if (lost.length === 0 && left.length === holders.length) return false;
      holders = left;
    }
    return holders.length === 0 || !(await this.anyInService(call, holders));
  }

  private async anyDenial(call: Call, holder: PrincipalRef, denials: readonly Denial[]): Promise<boolean> {
    for (const d of denials) if (await this.deniedTo(call, holder, d)) return true;
    return false;
  }

  /** The deny reaches `who`: it names it, its wildcard, or a set `who` is a member of. */
  private async deniedTo(call: Call, who: PrincipalRef, d: Denial): Promise<boolean> {
    if (isSetSubject(d.subject)) return (await this.setMembers(call, d.subject.set, who)).length > 0;
    return sameSubject(d.subject, who);
  }
```

Add after `extendsExpiry` (module level):

```ts
/** The earlier of two expiries; null is "never". */
function earliest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/guard-deny.rbac.test.ts`
Expected: PASS, `5 passing`.

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json 'test/admin/guard*.test.ts'`
Expected: `0 failing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/admin/common.ts packages/authz-rbac/src/admin/guard.ts packages/authz-rbac/test/admin/guard-deny.rbac.test.ts
git commit -m "feat(authz-rbac): admin guard counts a deny of the privileged permission as a removal"
```

---

### Task 6: `listSupport`

**Files:**
- Create: `src/model/list/support.ts`, `src/model/list/index.ts`
- Modify: `src/model/model.ts`, `src/model/index.ts`
- Test: `test/model/list-support.test.ts`

**Interfaces:**
- Produces: `LIST_RELATIONS` (`owner`, `self`); `ruleCanMatch(rule: Pick<RuleDef, 'kind' | 'resourceTypes' | 'permissions'>, permission: Permission, type: ResourceType): boolean` (Task 9 uses it); `rbacListSupport(src: ListSupportSources, permission, type): ListSupport`; `RbacModel.listSupport(permission: PermissionDef, type: ResourceType): ListSupport`. Reasons end with `, so <permission> on "<type>" is not list-filterable`.

- [ ] **Step 1: Write the failing test**

Create `test/model/list-support.test.ts`:

```ts
import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, ruleCanMatch } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'doc:read', types: ['doc', 'project'], list: true }, { name: 'doc:write', types: ['doc'] }], 'test');
  r.freeze();
  return r;
}

async function support(roles: readonly RoleDef[], rules: readonly Omit<RuleDef, 'source'>[] = []) {
  const reg = registry();
  const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(), ...(rules.length > 0 ? { rules: new ConfigRuleStore(rules as RuleDef[]) } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
  m.grantIndex();
  return m.listSupport(reg.require('doc:read'), 'doc');
}

describe('authz-rbac listSupport (design §7)', () => {
  it('is true for plain, owner, self, grantedAt, requiresTag, type-only patterns and deny roles', async () => {
    expect(
      await support([
        role('viewer', ['doc:read']),
        role('owner', [{ permission: 'doc:read', relation: 'owner' }]),
        role('me', [{ permission: 'doc:read', relation: ['self'] }]),
        role('pm', [{ permission: 'doc:read', grantedAt: ['project'] }]),
        role('paid', [{ permission: 'doc:read', requiresTag: 'paid' }]),
        role('typed', [{ permission: 'doc:read', on: [{ type: 'doc' }] }]),
        { ...role('blocked', ['doc:read']), deny: true },
      ]),
    ).to.equal(true);
  });

  it('refuses another relation', async () => {
    expect(await support([role('team', [{ permission: 'doc:read', relation: 'team' }])])).to.deep.equal({ reason: "rbac role 'team' grant 'doc:read' (source: test) has the relation 'team'; lists support owner and self only (assign a role on the resource instead), so doc:read on \"doc\" is not list-filterable" });
  });

  it('refuses on patterns with an id', async () => {
    expect(await support([role('one', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'd1' }] }])])).to.deep.equal({ reason: "rbac role 'one' grant 'doc:read' (source: test) limits `on` by id; lists support type-only patterns, so doc:read on \"doc\" is not list-filterable" });
  });

  it('refuses requiresTag with grantedAt, and a relation with either', async () => {
    expect(((await support([role('x', [{ permission: 'doc:read', requiresTag: 't', grantedAt: ['project'] }])])) as { reason: string }).reason).to.contain('has both requiresTag and grantedAt');
    expect(((await support([role('x', [{ permission: 'doc:read', relation: 'owner', grantedAt: ['project'] }])])) as { reason: string }).reason).to.contain('joins a relation with requiresTag or grantedAt');
  });

  it('refuses a requiresTag an implied role also carries', async () => {
    const roles = [role('lead', [], { implies: [{ role: 'viewer', at: 'self-and-descendants', tags: ['paid'] }] }), role('viewer', []), role('paid', [{ permission: 'doc:read', requiresTag: 'paid' }])];
    expect(((await support(roles)) as { reason: string }).reason).to.contain("requires tag 'paid', which an implied role also carries");
  });

  it('refuses a config rule that can apply', async () => {
    const out = await support([role('viewer', ['doc:read'])], [{ id: 'strip', kind: 'cap', scope: GLOBAL, stripTags: true }]);
    expect((out as { reason: string }).reason).to.match(/^rbac rule 'strip' \(cap, source: .*\) can apply to it; lists cannot follow rules, so doc:read on "doc" is not list-filterable$/);
  });

  it('ruleCanMatch: restrict and cap match every permission of their types, a threshold its own permissions', () => {
    expect(ruleCanMatch({ kind: 'restrict' }, 'doc:read', 'doc')).to.equal(true);
    expect(ruleCanMatch({ kind: 'cap', resourceTypes: ['project'] }, 'doc:read', 'doc')).to.equal(false);
    expect(ruleCanMatch({ kind: 'threshold', permissions: ['doc:*'] }, 'doc:read', 'doc')).to.equal(true);
    expect(ruleCanMatch({ kind: 'threshold', permissions: ['doc:write'] }, 'doc:read', 'doc')).to.equal(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/list-support.test.ts`
Expected: FAIL: TSError `Module '"../../src/index.js"' has no exported member 'ruleCanMatch'`.

- [ ] **Step 3: Implement**

Create `src/model/list/support.ts`:

```ts
import { compilePermissionGlob } from '@spinajs/authz';
import type { ListSupport, Permission, ResourceType, RuleDef } from '@spinajs/authz';

import type { GrantIndex } from '../grants.js';
import type { ImpliesIndex } from '../ladder/implies.js';
import type { LadderIndex } from '../ladder/ladders.js';
import type { RoleGraph } from '../roles.js';

export const LIST_RELATIONS: ReadonlySet<string> = new Set(['owner', 'self']);

export interface ListSupportSources {
  readonly graph: RoleGraph;
  readonly grants: GrantIndex;
  readonly ladders?: LadderIndex;
  readonly implies?: ImpliesIndex;
  /** The in-memory rules; DB rules are refused when written (RbacRuleListGuard). */
  readonly rules: readonly RuleDef[];
}

/** Whether a rule can change the answer for `permission` on `type`: restrict and cap act on every permission, a threshold on its own. */
export function ruleCanMatch(rule: Pick<RuleDef, 'kind' | 'resourceTypes' | 'permissions'>, permission: Permission, type: ResourceType): boolean {
  if (rule.resourceTypes && !rule.resourceTypes.includes(type)) return false;
  if (rule.kind !== 'threshold') return true;
  return (rule.permissions ?? []).some((glob) => compilePermissionGlob(glob)(permission));
}

/** Design §7 for RBAC: why `permission` on `type` cannot be planned (lane L8 decisions 7 and 9), or true. */
export function rbacListSupport(src: ListSupportSources, permission: Permission, type: ResourceType): ListSupport {
  const refuse = (text: string): ListSupport => Object.freeze({ reason: `${text}, so ${permission} on ${JSON.stringify(type)} is not list-filterable` });
  for (const rule of src.rules) {
    if (ruleCanMatch(rule, permission, type)) return refuse(`rbac rule '${rule.id}' (${rule.kind}, source: ${rule.source}) can apply to it; lists cannot follow rules`);
  }
  const impliedTags = new Set<string>();
  if (src.implies) for (const name of src.graph.names) for (const e of src.implies.of(name)) for (const t of e.tags) impliedTags.add(t);
  for (const role of src.graph.names) {
    for (const g of src.grants.grants(role, permission)) {
      // Each grant is judged once, under the role that declares it.
      if (g.role !== role || (src.ladders && !src.ladders.appliesAt(g, type))) continue;
      const where = `rbac role '${role}' grant '${g.def.permission}' (source: ${src.graph.get(role)!.def.source})`;
      const other = g.relations?.find((r) => !LIST_RELATIONS.has(r));
      if (other !== undefined) return refuse(`${where} has the relation '${other}'; lists support owner and self only (assign a role on the resource instead)`);
      if (g.patterns?.some((p) => p.id !== undefined)) return refuse(`${where} limits \`on\` by id; lists support type-only patterns`);
      if (g.requiresTag !== undefined && g.grantedAt !== undefined) return refuse(`${where} has both requiresTag and grantedAt`);
      if (g.relations && (g.requiresTag !== undefined || g.grantedAt !== undefined)) return refuse(`${where} joins a relation with requiresTag or grantedAt`);
      if (g.requiresTag !== undefined && impliedTags.has(g.requiresTag)) return refuse(`${where} requires tag '${g.requiresTag}', which an implied role also carries`);
    }
  }
  return true;
}
```

Create `src/model/list/index.ts`:

```ts
export * from './support.js';
```

Add `export * from './list/index.js';` to `src/model/index.ts`.

In `src/model/model.ts` import `ListSupport` in the type import of L2, `import { rbacListSupport } from './list/support.js';`, and add after `applies`:

```ts
  /** Design §7, at boot (rule 12) and per call: whether lists of `permission` on `type` can be planned. */
  listSupport(permission: PermissionDef, type: ResourceType): ListSupport {
    const { graph } = this.state();
    const grants = this.grantIndex();
    const { ladders, implies } = rbacTables(this.extensions, graph, grants);
    const { config } = ruleStoreParts(this.opts.rules);
    return rbacListSupport({ graph, grants, ...(ladders ? { ladders } : {}), ...(implies ? { implies } : {}), rules: config?.all() ?? [] }, permission.name, type);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/list-support.test.ts`
Expected: PASS, `7 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-rbac/src/model/list packages/authz-rbac/src/model/model.ts packages/authz-rbac/src/model/index.ts packages/authz-rbac/test/model/list-support.test.ts
git commit -m "feat(authz-rbac): listSupport (design §7)"
```

---

### Task 7: `rbac.assignment` SQL

**Files:**
- Create: `src/plan/args.ts`, `src/plan/assignment-sql.ts`, `src/plan/index.ts`
- Modify: `src/index.ts`
- Test: `test/plan/assignment-sql.test.ts`

**Interfaces:**
- Consumes: L0 `PlanTermSql`, `SqlRowContext` (`type`, `rowId`, `rowColumn`, `ancestorTable` — already quoted for the dialect, inlined as is, never quoted again — `relation(name)`, `now`, `dialect`), `SqlFragment`; `parsePrincipalSubjectKey` (Task 4, added below); `AUTHZ_ASSIGNMENT_TABLE` (L7), `AUTHZ_SUBJECT_MEMBERSHIP_TABLE` (L6), column `authz_assignment.subject_key` (L6).
- Produces: `RBAC_ASSIGNMENT_PLAN_OP = 'rbac.assignment'`, `RbacPlanRole` (with `relation?: 'owner' | 'self'`), `RbacAssignmentPlanArgs`, `rbacPlanArgs(args)` (canonical), `parseRbacPlanArgs(args: unknown)` (throws on any other shape), `rbacAssignmentSql(args, row): SqlFragment`, `sqliteDateTime(d: Date): string`, `parsePrincipalSubjectKey(key): PrincipalRef | undefined` (`src/model/sets/keys.ts`), and the DI-registered compiler `RbacAssignmentSql` (`@Injectable(PlanTermSql)`).

- [ ] **Step 1: Write the failing test**

Create `test/plan/assignment-sql.test.ts`:

```ts
import { PlanTermSql } from '@spinajs/authz';
import type { SqlFragment, SqlRowContext } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';

import { RbacAssignmentSql, parsePrincipalSubjectKey, parseRbacPlanArgs, rbacAssignmentSql, rbacPlanArgs, sqliteDateTime } from '../../src/index.js';
import type { RbacAssignmentPlanArgs } from '../../src/index.js';
import { bootDb, rawQuery } from '../support/db.js';
import type { TestDb } from '../support/db.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const OWNER = { column: 'owner_id' };
const row = (dialect: SqlRowContext['dialect'] = 'postgres', relation: SqlRowContext['relation'] = (name) => (name === 'owner' ? OWNER : undefined)): SqlRowContext => ({ type: 'task', rowId: 'CAST(t.id AS TEXT)', rowColumn: (c) => `t.${c}`, ancestorTable: 'authz_resource_ancestor', relation, now: NOW, dialect });
const args = (over: Partial<RbacAssignmentPlanArgs> = {}): RbacAssignmentPlanArgs => rbacPlanArgs({ subjects: ['user:alice'], membership: false, memberKeys: [], roles: [{ role: 'editor' }], global: false, ...over });

const LIVE = (a: string) => `(${a}.expires_at IS NULL OR ${a}.expires_at > ?)`;
const DIRECT = `EXISTS (SELECT 1 FROM authz_assignment authz_s WHERE authz_s.scope_type = ? AND authz_s.scope_id = CAST(t.id AS TEXT) AND authz_s.subject_key IN (?) AND ${LIVE('authz_s')} AND (authz_s.role IN (?)))`;
const ABOVE = `EXISTS (SELECT 1 FROM authz_resource_ancestor authz_a JOIN authz_assignment authz_s ON authz_s.scope_type = authz_a.ancestor_type AND authz_s.scope_id = authz_a.ancestor_id WHERE authz_a.resource_type = ? AND authz_a.resource_id = CAST(t.id AS TEXT) AND authz_s.subject_key IN (?) AND ${LIVE('authz_s')} AND (authz_s.role IN (?)))`;

describe('authz-rbac plan SQL (design §6.2)', () => {
  describe('args', () => {
    it('canonical: sorted, deduplicated, frozen', () => {
      const a = rbacPlanArgs({ subjects: ['user:b', 'user:a', 'user:b'], membership: false, memberKeys: [], roles: [{ role: 'z' }, { role: 'a', scopeTypes: ['project', 'org'] }, { role: 'z' }], global: false });
      expect(a).to.deep.equal({ subjects: ['user:a', 'user:b'], membership: false, memberKeys: [], roles: [{ role: 'a', scopeTypes: ['org', 'project'] }, { role: 'z' }], global: false });
      expect(Object.isFrozen(a.roles)).to.equal(true);
    });

    it('parse refuses unknown keys and wrong types', () => {
      expect(() => parseRbacPlanArgs({ ...args(), extra: 1 })).to.throw('rbac.assignment: unknown args key(s) extra');
      expect(() => parseRbacPlanArgs({ ...args(), roles: [{ role: 'x', when: 1 }] })).to.throw('rbac.assignment: roles[0] has unknown key(s) when');
      expect(() => parseRbacPlanArgs({ ...args(), membership: 'yes' })).to.throw('rbac.assignment: membership must be a boolean');
      expect(parseRbacPlanArgs(JSON.parse(JSON.stringify(args())))).to.deep.equal(args());
    });
  });

  describe('rendering', () => {
    it('permit: the direct and the ancestor branch', () => {
      const out = rbacAssignmentSql(args(), row());
      expect(out.sql).to.equal(`(${DIRECT} OR ${ABOVE})`);
      expect(out.bindings).to.deep.equal(['task', 'user:alice', NOW, 'editor', 'task', 'user:alice', NOW, 'editor']);
    });

    it('descendantsOnly leaves the direct branch out; qualifiers group per role', () => {
      const out = rbacAssignmentSql(args({ roles: [{ role: 'lead', descendantsOnly: true }, { role: 'pm', scopeTypes: ['project'] }, { role: 'paid', tag: 'gold' }] }), row('sqlite'));
      expect(out.sql).to.contain("authz_s.scope_type IN (?)");
      expect(out.sql).to.contain('instr(authz_s.tags, ?) > 0');
      expect(out.bindings).to.include(',gold,');
      expect(out.sql.split('EXISTS (SELECT 1 FROM authz_assignment authz_s WHERE')[1]).to.not.contain("'lead'");
    });

    it('dialects differ only in the tag test and the now binding', () => {
      const tagged = (dialect: SqlRowContext['dialect']) => rbacAssignmentSql(args({ roles: [{ role: 'paid', tag: 'gold' }] }), row(dialect)).sql;
      expect(tagged('postgres')).to.contain('strpos(authz_s.tags, ?) > 0');
      expect(tagged('mysql')).to.contain('LOCATE(?, authz_s.tags) > 0');
      expect(tagged('mssql')).to.contain('CHARINDEX(?, authz_s.tags) > 0');
      expect(rbacAssignmentSql(args(), row('sqlite')).bindings[2]).to.equal(sqliteDateTime(NOW));
    });

    it('deny: the single EXISTS shape of design §6.2 with the membership sub-query', () => {
      const out = rbacAssignmentSql(args({ subjects: ['user:alice'], membership: true, memberKeys: ['user:alice'], roles: [{ role: 'blocked' }], global: true }), row('postgres'));
      expect(out.sql).to.equal(
        'EXISTS (SELECT 1 FROM authz_assignment authz_d WHERE (authz_d.subject_key IN (?) OR authz_d.subject_key IN (SELECT authz_m.set_key FROM authz_subject_membership authz_m WHERE authz_m.member_key IN (?) AND (authz_m.expires_at IS NULL OR authz_m.expires_at > ?))) AND authz_d.role IN (?) AND (authz_d.expires_at IS NULL OR authz_d.expires_at > ?) AND ((authz_d.scope_type = ? AND authz_d.scope_id = CAST(t.id AS TEXT)) OR EXISTS (SELECT 1 FROM authz_resource_ancestor authz_a WHERE authz_a.resource_type = ? AND authz_a.resource_id = CAST(t.id AS TEXT) AND authz_a.ancestor_type = authz_d.scope_type AND authz_a.ancestor_id = authz_d.scope_id) OR authz_d.scope_type = ?))',
      );
      expect(out.bindings).to.deep.equal(['user:alice', 'user:alice', NOW, 'blocked', NOW, 'task', 'task', '$global']);
    });

    it('no role or no subject is FALSE', () => {
      expect(rbacAssignmentSql(args({ roles: [] }), row()).sql).to.equal('(1 = 0)');
      expect(rbacAssignmentSql(args({ subjects: [] }), row()).sql).to.equal('(1 = 0)');
    });

    it('a relation ANDs the role with the relation column of the principals among the subjects', () => {
      const owned = args({ subjects: ['user:*', 'user:alice', 'team:t1#member'], roles: [{ role: 'member', relation: 'owner' }] });
      const plain = rbacAssignmentSql(owned, row());
      expect(plain.sql).to.contain('(authz_s.role = ? AND t.owner_id IN (?))');
      expect(plain.bindings).to.include.members(['member', 'alice']);
      const typed = rbacAssignmentSql(owned, row('postgres', () => ({ column: 'owner_id', typeColumn: 'owner_type' })));
      expect(typed.sql).to.contain('(authz_s.role = ? AND ((t.owner_type = ? AND t.owner_id = ?)))');
      expect(rbacAssignmentSql(owned, row('postgres', () => undefined)).sql).to.equal('(1 = 0)');
      expect(parsePrincipalSubjectKey('user:%2A')).to.deep.equal({ type: 'user', id: '*' });
      expect(parsePrincipalSubjectKey('user:*')).to.equal(undefined);
      expect(parsePrincipalSubjectKey('team:t1#member')).to.equal(undefined);
    });

    it('is registered as PlanTermSql', async () => {
      const ops = ((await DI.resolve(Array.ofType(PlanTermSql))) as PlanTermSql[]).map((c) => c.op);
      expect(ops).to.include('rbac.assignment');
      expect(new RbacAssignmentSql().op).to.equal('rbac.assignment');
    });
  });

  describe('on SQLite', function () {
    this.timeout(30000);
    let db: TestDb;
    const run = (sql: string, bindings: readonly unknown[] = []) => rawQuery(db.driver, sql, [...bindings], QueryContext.Schema);
    const ids = async (where: SqlFragment): Promise<number[]> => ((await rawQuery(db.driver, `SELECT t.id FROM task t WHERE ${where.sql} ORDER BY t.id`, [...where.bindings])) as { id: number }[]).map((r) => r.id);
    const past = sqliteDateTime(new Date(NOW.getTime() - 3_600_000));
    const sqlite = row('sqlite');
    const permit = (over: Partial<RbacAssignmentPlanArgs>) => rbacAssignmentSql(args(over), sqlite);

    before(async function () {
      db = await bootDb(this, 'sqlite', 'l8-plan-sql', { migrate: false });
      await run('CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT, owner_id TEXT)');
      await run("CREATE TABLE authz_assignment (id TEXT PRIMARY KEY, subject_key TEXT NOT NULL, role TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', expires_at TEXT)");
      await run('CREATE TABLE authz_subject_membership (member_key TEXT NOT NULL, set_key TEXT NOT NULL, depth INTEGER NOT NULL, expires_at TEXT, PRIMARY KEY (member_key, set_key))');
      await run('CREATE TABLE authz_resource_ancestor (resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, ancestor_type TEXT NOT NULL, ancestor_id TEXT NOT NULL, depth INTEGER NOT NULL, PRIMARY KEY (resource_type, resource_id, ancestor_type, ancestor_id))');
      for (const [id, owner] of [[1, 'alice'], [2, null], [3, null], [4, null], [5, 'bob']] as const) await run('INSERT INTO task (id, title, owner_id) VALUES (?, ?, ?)', [id, `t${id}`, owner]);
      const up = [
        ['1', 'project', 'p1', 1],
        ['1', 'org', 'o1', 2],
        ['2', 'project', 'p2', 1],
        ['2', 'org', 'o1', 2],
        ['3', 'project', 'p3', 1],
        ['5', 'project', 'p1', 1],
      ];
      for (const [id, type, anc, depth] of up) await run('INSERT INTO authz_resource_ancestor VALUES (?, ?, ?, ?, ?)', ['task', id, type, anc, depth]);
      const rows = [
        ['a1', 'user:alice', 'editor', 'project', 'p1', '', null],
        ['a2', 'team:t1#member', 'editor', 'task', '3', '', null],
        ['a3', 'user:alice', 'editor', 'task', '4', '', past],
        ['a4', 'user:alice', 'billing', 'project', 'p2', ',paid,', null],
        ['a5', 'user:alice', 'blocked', 'org', 'o1', '', null],
        ['a6', 'user:bob', 'editor', 'project', 'p3', '', null],
        ['a7', 'user:alice', 'member', 'project', 'p1', '', null],
      ];
      for (const r of rows) await run('INSERT INTO authz_assignment VALUES (?, ?, ?, ?, ?, ?, ?)', r);
      await run('INSERT INTO authz_subject_membership VALUES (?, ?, ?, ?)', ['user:alice', 'team:t1#member', 1, null]);
    });

    after(async () => {
      await db?.dispose();
    });

    it('explicit subjects: direct and ancestor grants, expiry honoured', async () => {
      expect(await ids(permit({ subjects: ['team:t1#member', 'user:alice'] }))).to.deep.equal([1, 3, 5]);
    });

    it('the membership sub-query finds the same sets', async () => {
      expect(await ids(permit({ subjects: ['user:alice'], membership: true, memberKeys: ['user:alice'] }))).to.deep.equal([1, 3, 5]);
    });

    it('descendantsOnly, scopeTypes and tag', async () => {
      expect(await ids(permit({ subjects: ['team:t1#member', 'user:alice'], roles: [{ role: 'editor', descendantsOnly: true }] }))).to.deep.equal([1, 5]);
      expect(await ids(permit({ subjects: ['team:t1#member', 'user:alice'], roles: [{ role: 'editor', scopeTypes: ['task'] }] }))).to.deep.equal([3]);
      expect(await ids(permit({ roles: [{ role: 'billing', tag: 'paid' }] }))).to.deep.equal([2]);
      expect(await ids(permit({ roles: [{ role: 'billing', tag: 'other' }] }))).to.deep.equal([]);
    });

    it('a relation entry keeps the rows under the assignment that the principal owns', async () => {
      expect(await ids(permit({ roles: [{ role: 'member', relation: 'owner' }] }))).to.deep.equal([1]);
    });

    it('a deny term removes the rows under its scope', async () => {
      const allowed = permit({ subjects: ['team:t1#member', 'user:alice'] });
      const denied = rbacAssignmentSql(args({ roles: [{ role: 'blocked' }], global: true }), sqlite);
      expect(await ids(denied)).to.deep.equal([1, 2, 5]);
      expect(await ids({ sql: `${allowed.sql} AND NOT ${denied.sql}`, bindings: [...allowed.bindings, ...denied.bindings] })).to.deep.equal([3]);
    });

    it('an expired membership drops its sets', async () => {
      await run('UPDATE authz_subject_membership SET expires_at = ?', [past]);
      try {
        expect(await ids(permit({ subjects: ['user:alice'], membership: true, memberKeys: ['user:alice'] }))).to.deep.equal([1, 5]);
      } finally {
        await run('UPDATE authz_subject_membership SET expires_at = NULL');
      }
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/plan/assignment-sql.test.ts`
Expected: FAIL: TSError `Module '"../../src/index.js"' has no exported member 'rbacPlanArgs'`.

- [ ] **Step 3: Args**

Create `src/plan/args.ts`:

```ts
/** The term of design §6.2 (lane L8 decision 6). */
export const RBAC_ASSIGNMENT_PLAN_OP = 'rbac.assignment';

export interface RbacPlanRole {
  readonly role: string;
  /** Only assignments made at these scope types count (grantedAt, the role's scopeTypes). */
  readonly scopeTypes?: readonly string[];
  /** The counting assignment itself carries this tag (requiresTag). */
  readonly tag?: string;
  /** At the row's ancestors only, never at the row (implies with at: 'descendants'). */
  readonly descendantsOnly?: boolean;
  /** And the row's owner (self) is one of the principals among `subjects` (a relation grant held at a scope). */
  readonly relation?: 'owner' | 'self';
}

export interface RbacAssignmentPlanArgs {
  /** subjectKeyOf keys whose assignments count. */
  readonly subjects: readonly string[];
  /** Also the sets `memberKeys` belong to, read from authz_subject_membership in the query. */
  readonly membership: boolean;
  readonly memberKeys: readonly string[];
  readonly roles: readonly RbacPlanRole[];
  /** Assignments at $global count too. */
  readonly global: boolean;
}

const ARG_KEYS = ['subjects', 'membership', 'memberKeys', 'roles', 'global'];
const ROLE_KEYS = ['role', 'scopeTypes', 'tag', 'descendantsOnly', 'relation'];

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (list: readonly string[]): readonly string[] => Object.freeze([...new Set(list)].sort(byCodePoint));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Canonical args: equal plans are equal JSON (cache keys, statement caches). */
export function rbacPlanArgs(a: RbacAssignmentPlanArgs): RbacAssignmentPlanArgs {
  const roles = new Map<string, RbacPlanRole>();
  for (const r of a.roles) {
    const role: RbacPlanRole = Object.freeze({ role: r.role, ...(r.scopeTypes ? { scopeTypes: sorted(r.scopeTypes) } : {}), ...(r.tag !== undefined ? { tag: r.tag } : {}), ...(r.descendantsOnly ? { descendantsOnly: true } : {}), ...(r.relation ? { relation: r.relation } : {}) });
    roles.set(JSON.stringify(role), role);
  }
  const list = [...roles].sort(([x], [y]) => byCodePoint(x, y)).map(([, r]) => r);
  return Object.freeze({ subjects: sorted(a.subjects), membership: a.membership, memberKeys: sorted(a.memberKeys), roles: Object.freeze(list), global: a.global });
}

/** @throws Error naming the problem, for anything but the exact shape: a compiler must not guess at args it does not know. */
export function parseRbacPlanArgs(args: unknown): RbacAssignmentPlanArgs {
  const fail = (problem: string): never => {
    throw new Error(`${RBAC_ASSIGNMENT_PLAN_OP}: ${problem}`);
  };
  if (!isObject(args)) return fail('args must be an object');
  const unknown = Object.keys(args).filter((k) => !ARG_KEYS.includes(k));
  if (unknown.length > 0) fail(`unknown args key(s) ${unknown.join(', ')}`);
  const names = (v: unknown, what: string): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '') ? (v as string[]) : fail(`${what} must be an array of non-empty strings`));
  if (typeof args.membership !== 'boolean') fail('membership must be a boolean');
  if (typeof args.global !== 'boolean') fail('global must be a boolean');
  if (!Array.isArray(args.roles)) fail('roles must be an array');
  const roles = (args.roles as unknown[]).map((r, i): RbacPlanRole => {
    if (!isObject(r)) return fail(`roles[${i}] must be an object`);
    const extra = Object.keys(r).filter((k) => !ROLE_KEYS.includes(k));
    if (extra.length > 0) fail(`roles[${i}] has unknown key(s) ${extra.join(', ')}`);
    const { role, scopeTypes, tag, descendantsOnly, relation } = r;
    if (typeof role !== 'string' || role === '') fail(`roles[${i}].role must be a role name`);
    if (tag !== undefined && (typeof tag !== 'string' || tag === '' || tag.includes(','))) fail(`roles[${i}].tag must be a tag`);
    if (descendantsOnly !== undefined && descendantsOnly !== true) fail(`roles[${i}].descendantsOnly must be true when present`);
    if (relation !== undefined && relation !== 'owner' && relation !== 'self') fail(`roles[${i}].relation must be 'owner' or 'self'`);
    return { role: role as string, ...(scopeTypes !== undefined ? { scopeTypes: names(scopeTypes, `roles[${i}].scopeTypes`) } : {}), ...(tag !== undefined ? { tag: tag as string } : {}), ...(descendantsOnly ? { descendantsOnly: true } : {}), ...(relation !== undefined ? { relation: relation as 'owner' | 'self' } : {}) };
  });
  return rbacPlanArgs({ subjects: names(args.subjects, 'subjects'), membership: args.membership as boolean, memberKeys: names(args.memberKeys, 'memberKeys'), roles, global: args.global as boolean });
}
```

- [ ] **Step 4: SQL**

Create `src/plan/assignment-sql.ts`:

```ts
import { PlanTermSql } from '@spinajs/authz';
import type { PrincipalRef, SqlFragment, SqlRowContext } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { parsePrincipalSubjectKey } from '../model/sets/keys.js';
import { AUTHZ_ASSIGNMENT_TABLE } from '../stores/assignment-row.js';
import { AUTHZ_SUBJECT_MEMBERSHIP_TABLE } from '../stores/index.js';
import { RBAC_ASSIGNMENT_PLAN_OP, parseRbacPlanArgs } from './args.js';
import type { RbacAssignmentPlanArgs, RbacPlanRole } from './args.js';

const GLOBAL_TYPE = '$global';
const FALSE_SQL: SqlFragment = Object.freeze({ sql: '(1 = 0)', bindings: Object.freeze([]) });

const raw = (sql: string): SqlFragment => ({ sql, bindings: [] });
const isFragment = (v: unknown): v is SqlFragment => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && typeof (v as SqlFragment).sql === 'string' && Array.isArray((v as SqlFragment).bindings);

/** A fragment is inlined, an array becomes `?, ?, …` (never empty here), anything else one `?`. */
function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = strings[0];
  const bindings: unknown[] = [];
  values.forEach((v, i) => {
    if (isFragment(v)) {
      text += v.sql;
      bindings.push(...v.bindings);
    } else if (Array.isArray(v)) {
      text += v.map(() => '?').join(', ');
      bindings.push(...v);
    } else {
      text += '?';
      bindings.push(v);
    }
    text += strings[i + 1];
  });
  return { sql: text, bindings };
}

const join = (separator: string, list: readonly SqlFragment[]): SqlFragment => ({ sql: list.map((f) => f.sql).join(separator), bindings: list.flatMap((f) => f.bindings) });

/** As SqlDatetimeValueConverter writes a datetime on SQLite (local wall clock, no zone): text order is time order. */
export function sqliteDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const nowOf = (row: SqlRowContext): unknown => (row.dialect === 'sqlite' ? sqliteDateTime(row.now) : row.now);
const live = (alias: string, now: unknown): SqlFragment => sql`(${raw(alias)}.expires_at IS NULL OR ${raw(alias)}.expires_at > ${now})`;

function contains(dialect: SqlRowContext['dialect'], haystack: SqlFragment, needle: string): SqlFragment {
  switch (dialect) {
    case 'sqlite':
      return sql`instr(${haystack}, ${needle}) > 0`;
    case 'postgres':
      return sql`strpos(${haystack}, ${needle}) > 0`;
    case 'mysql':
      return sql`LOCATE(${needle}, ${haystack}) > 0`;
    case 'mssql':
      return sql`CHARINDEX(${needle}, ${haystack}) > 0`;
  }
}

/** design §6.2 `<holder>`: the subject keys, or with `membership` also the live sets of `memberKeys`. */
function holder(alias: string, args: RbacAssignmentPlanArgs, now: unknown): SqlFragment {
  const key = raw(`${alias}.subject_key`);
  const own = args.subjects.length > 0 ? sql`${key} IN (${args.subjects})` : undefined;
  if (!args.membership || args.memberKeys.length === 0) return own ?? FALSE_SQL;
  const sets = sql`${key} IN (SELECT authz_m.set_key FROM ${raw(AUTHZ_SUBJECT_MEMBERSHIP_TABLE)} authz_m WHERE authz_m.member_key IN (${args.memberKeys}) AND ${live('authz_m', now)})`;
  return own ? sql`(${own} OR ${sets})` : sets;
}

const qualified = (r: RbacPlanRole): boolean => r.scopeTypes !== undefined || r.tag !== undefined || r.relation !== undefined;

/** The principals among the holder keys (wildcards and sets name nobody in particular). */
function principalsOf(args: RbacAssignmentPlanArgs): PrincipalRef[] {
  const out = new Map<string, PrincipalRef>();
  for (const key of [...args.subjects, ...args.memberKeys]) {
    const p = parsePrincipalSubjectKey(key);
    if (p) out.set(key, p);
  }
  return [...out.values()];
}

/** The row's relation holds for one of `principals`; undefined (FALSE) when the type has no such relation or no principal fits it. */
function relationSql(row: SqlRowContext, name: 'owner' | 'self', principals: readonly PrincipalRef[]): SqlFragment | undefined {
  const columns = row.relation(name);
  if (!columns) return undefined;
  const column = raw(row.rowColumn(columns.column));
  if (columns.typeColumn) {
    if (principals.length === 0) return undefined;
    const typeColumn = raw(row.rowColumn(columns.typeColumn));
    return sql`(${join(' OR ', principals.map((p) => sql`(${typeColumn} = ${p.type} AND ${column} = ${p.id})`))})`;
  }
  // Without a type column the relation names user principals only (overview, ResourceEntry.owner).
  const ids = [...new Set(principals.filter((p) => p.type === 'user').map((p) => p.id))];
  return ids.length === 0 ? undefined : sql`${column} IN (${ids})`;
}

/** The roles that count in one branch: plain ones in one IN list, qualified ones each with their conditions. */
function roleClause(alias: string, roles: readonly RbacPlanRole[], branch: 'direct' | 'ancestor' | 'global', row: SqlRowContext, principals: readonly PrincipalRef[]): SqlFragment | undefined {
  const usable = roles.filter((r) => !(branch === 'direct' && r.descendantsOnly) && (r.scopeTypes === undefined || r.scopeTypes.length > 0));
  const plain = [...new Set(usable.filter((r) => !qualified(r)).map((r) => r.role))];
  const parts: SqlFragment[] = plain.length > 0 ? [sql`${raw(alias)}.role IN (${plain})`] : [];
  for (const r of usable.filter(qualified)) {
    const conditions = [sql`${raw(alias)}.role = ${r.role}`];
    if (r.scopeTypes) conditions.push(sql`${raw(alias)}.scope_type IN (${r.scopeTypes})`);
    if (r.tag !== undefined) conditions.push(contains(row.dialect, raw(`${alias}.tags`), `,${r.tag},`));
    if (r.relation !== undefined) {
      const relation = relationSql(row, r.relation, principals);
      if (!relation) continue;
      conditions.push(relation);
    }
    parts.push(sql`(${join(' AND ', conditions)})`);
  }
  return parts.length === 0 ? undefined : sql`(${join(' OR ', parts)})`;
}

/** The deny form of design §6.2 (one sub-query); positive here, the plan's consumer negates deny terms. */
function denyShape(args: RbacAssignmentPlanArgs, row: SqlRowContext, now: unknown): SqlFragment {
  const id = raw(row.rowId);
  const roles = [...new Set(args.roles.map((r) => r.role))];
  return sql`EXISTS (SELECT 1 FROM ${raw(AUTHZ_ASSIGNMENT_TABLE)} authz_d WHERE ${holder('authz_d', args, now)} AND authz_d.role IN (${roles}) AND ${live('authz_d', now)} AND ((authz_d.scope_type = ${row.type} AND authz_d.scope_id = ${id}) OR EXISTS (SELECT 1 FROM ${raw(row.ancestorTable)} authz_a WHERE authz_a.resource_type = ${row.type} AND authz_a.resource_id = ${id} AND authz_a.ancestor_type = authz_d.scope_type AND authz_a.ancestor_id = authz_d.scope_id) OR authz_d.scope_type = ${GLOBAL_TYPE}))`;
}

/** The row matches args (lane L8 decision 6): a live assignment of one of the roles, held by the holders, at the row, an ancestor or (global) $global. */
export function rbacAssignmentSql(args: RbacAssignmentPlanArgs, row: SqlRowContext): SqlFragment {
  if (args.roles.length === 0 || (args.subjects.length === 0 && !(args.membership && args.memberKeys.length > 0))) return FALSE_SQL;
  const now = nowOf(row);
  if (args.global && args.roles.every((r) => !qualified(r) && !r.descendantsOnly)) return denyShape(args, row, now);
  const table = raw(AUTHZ_ASSIGNMENT_TABLE);
  const id = raw(row.rowId);
  const principals = principalsOf(args);
  const branches: SqlFragment[] = [];
  const direct = roleClause('authz_s', args.roles, 'direct', row, principals);
  if (direct) branches.push(sql`EXISTS (SELECT 1 FROM ${table} authz_s WHERE authz_s.scope_type = ${row.type} AND authz_s.scope_id = ${id} AND ${holder('authz_s', args, now)} AND ${live('authz_s', now)} AND ${direct})`);
  const above = roleClause('authz_s', args.roles, 'ancestor', row, principals);
  if (above) branches.push(sql`EXISTS (SELECT 1 FROM ${raw(row.ancestorTable)} authz_a JOIN ${table} authz_s ON authz_s.scope_type = authz_a.ancestor_type AND authz_s.scope_id = authz_a.ancestor_id WHERE authz_a.resource_type = ${row.type} AND authz_a.resource_id = ${id} AND ${holder('authz_s', args, now)} AND ${live('authz_s', now)} AND ${above})`);
  const global = args.global ? roleClause('authz_s', args.roles, 'global', row, principals) : undefined;
  if (global) branches.push(sql`EXISTS (SELECT 1 FROM ${table} authz_s WHERE authz_s.scope_type = ${GLOBAL_TYPE} AND ${holder('authz_s', args, now)} AND ${live('authz_s', now)} AND ${global})`);
  return branches.length === 0 ? FALSE_SQL : sql`(${join(' OR ', branches)})`;
}

@Singleton()
@Injectable(PlanTermSql)
export class RbacAssignmentSql extends PlanTermSql {
  readonly op = RBAC_ASSIGNMENT_PLAN_OP;

  toSql(args: unknown, row: SqlRowContext): SqlFragment {
    return Object.freeze(rbacAssignmentSql(parseRbacPlanArgs(args), row));
  }
}

```

Add to `src/model/sets/keys.ts` (Task 4), after `principalSubjectKey`:

```ts
/** The principal a `subjectKeyOf` principal key names; undefined for a set key or a wildcard. */
export function parsePrincipalSubjectKey(key: string): PrincipalRef | undefined {
  const colon = key.indexOf(':');
  if (colon <= 0) return undefined;
  const id = key.slice(colon + 1);
  if (id === '' || id === WILDCARD_ID || id.includes('#')) return undefined;
  return { type: unescapeType(key.slice(0, colon)), id: unescapeId(id) };
}
```

Create `src/plan/index.ts`:

```ts
export * from './args.js';
export * from './assignment-sql.js';
```

In `src/index.ts` add `export * from './plan/index.js';` after `./model/index.js`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/plan/assignment-sql.test.ts`
Expected: PASS, `17 passing`.

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/plan packages/authz-rbac/src/model/sets/keys.ts packages/authz-rbac/src/index.ts packages/authz-rbac/test/plan/assignment-sql.test.ts
git commit -m "feat(authz-rbac): rbac.assignment PlanTermSql compiler"
```

---

### Task 8: `listPlan`

**Files:**
- Create: `src/model/list/plan.ts`
- Modify: `src/model/list/index.ts`, `src/model/model.ts` (`Loaded`, `init`, new `listPlan`), `src/stores/schema.ts` (root `maxPlanSubjects`)
- Test: `test/model/list-plan.test.ts`

**Interfaces:**
- Consumes: Task 3 (`state.denied`, `roleDenied`, `GrantIndex.denies`), Task 4 (`usableVia`, `input.nestedSets`), Task 7 (`rbacPlanArgs`, `RBAC_ASSIGNMENT_PLAN_OP`, `RbacPlanRole.relation`), `reachableGrants` (`ladder/steps.ts`), `rbacState(input, 'cap')` (`evaluate.ts`), L6 `subjectKeyOf`.
- Produces: `DEFAULT_MAX_PLAN_SUBJECTS = 500`, `RELATION_OWNER_OP = 'relation.owner'`, `RELATION_SELF_OP = 'relation.self'`, `RelationPlanArgs = { principals: readonly { type: string; id: string }[] }` (principal and companions), `rbacListPlan(state: RbacState, opts: { maxSubjects: number }): ModelListPlan`, `RbacModel.listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan>`, config `authz.rbac.maxPlanSubjects` (integer ≥ 1, default 500).

- [ ] **Step 1: Write the failing test**

Create `test/model/list-plan.test.ts`:

```ts
import { DEFAULT_DENY_PRIORITY, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, EvaluationContext, Principal, ResourceRef } from '@spinajs/authz';
import { fakeEvaluationContext, fakeModelInitContext, userPrincipal, withCeiling } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { MembershipStore, MemoryAssignmentStore, MemoryRoleStore, MemoryRuleStore, RbacModel, RuleStore } from '../../src/index.js';
import type { GrantDef, RoleDef, RuleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const alice = userPrincipal('alice');
const ALICE = ['user:*', 'user:alice'];

const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const ROLES = [
  role('viewer', ['doc:read']),
  role('editor', ['doc:read']),
  role('pm', [{ permission: 'doc:read', grantedAt: ['project'] }]),
  role('billing', [{ permission: 'doc:read', requiresTag: 'paid' }]),
  role('member', [{ permission: 'doc:read', relation: 'owner' }]),
  role('lead', [], { implies: [{ role: 'viewer', at: 'descendants' }] }),
  role('org.member', [], { subjectSet: true }),
  { ...role('blocked', ['doc:read']), deny: true },
];
const row = (id: string, roleName: string, scope: ResourceRef = GLOBAL, extra: Partial<Assignment> = {}, subject: AssignmentSubject = { type: 'user', id: 'alice' }): Assignment => ({ id, subject, role: roleName, scope, source: 'test', ...extra });

class Closure extends MembershipStore {
  constructor(private readonly sets: Readonly<Record<string, readonly string[]>>) {
    super();
  }
  async setsOf(keys: readonly string[]): Promise<readonly { setKey: string; expiresAt?: Date }[]> {
    return [...new Set(keys.flatMap((k) => this.sets[k] ?? []))].map((setKey) => ({ setKey }));
  }
  async membersOf(): Promise<readonly string[]> {
    return [];
  }
}

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'doc:read', types: ['doc', 'project', 'org'], list: true }], 'test');
  r.freeze();
  return r;
}

const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW });

class EmptyDbRules extends RuleStore {
  readonly name = 'EmptyDbRules';
  async forPath(): Promise<readonly RuleDef[]> {
    return [];
  }
  async version(): Promise<string> {
    return '1';
  }
}

async function plan(rows: readonly Assignment[], opts: { principal?: Principal; config?: Record<string, unknown>; membership?: MembershipStore; rules?: RuleStore } = {}) {
  const reg = registry();
  const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore(rows), ...(opts.membership ? { membership: opts.membership } : {}), ...(opts.rules ? { rules: opts.rules } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg, config: opts.config ?? {} }));
  m.grantIndex();
  return m.listPlan({ principal: opts.principal ?? alice, permission: reg.require('doc:read'), type: 'doc', env: { now: NOW } }, ctx());
}

const assignmentTerm = (roles: readonly object[], over: Record<string, unknown> = {}) => ({ op: 'rbac.assignment', args: { subjects: ALICE, membership: false, memberKeys: [], roles, global: false, ...over } });

describe('authz-rbac listPlan (design §6.2)', () => {
  it('abstains when nothing could grant it', async () => {
    expect(await plan([])).to.deep.equal({ kind: 'abstain' });
  });

  it('a $global grant lists every row, bounded by its expiry', async () => {
    expect(await plan([row('v', 'viewer')])).to.deep.equal({ kind: 'all' });
    const soon = new Date(NOW.getTime() + 60_000);
    expect(await plan([row('v', 'viewer', GLOBAL, { expiresAt: soon })])).to.deep.equal({ kind: 'all', validUntil: soon });
  });

  it('a scoped grant becomes an rbac.assignment term of the roles held', async () => {
    expect(await plan([row('v', 'viewer', P1), row('e', 'editor', P2)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'editor' }, { role: 'viewer' }])], deny: [] });
  });

  it('carries grantedAt, requiresTag and implies at descendants', async () => {
    expect(await plan([row('p', 'pm', P1)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'pm', scopeTypes: ['project'] }])], deny: [] });
    expect(await plan([row('b', 'billing', P1, { tags: ['paid'] })])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'billing', tag: 'paid' }])], deny: [] });
    expect(await plan([row('l', 'lead', O1)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'lead', descendantsOnly: true }])], deny: [] });
  });

  it('a $global deny is deny-all; a scoped deny rides on all', async () => {
    expect(await plan([row('v', 'viewer'), row('b', 'blocked')])).to.deep.equal({ kind: 'deny-all', reason: { code: 'role_denied', role: 'blocked', priority: DEFAULT_DENY_PRIORITY.role_denied } });
    expect(await plan([row('v', 'viewer'), row('b', 'blocked', P2)])).to.deep.equal({ kind: 'all', deny: [assignmentTerm([{ role: 'blocked' }], { global: true })] });
  });

  it('owner from a $global role is a relation.owner term; from a scoped one a role entry with relation', async () => {
    expect(await plan([row('m', 'member')])).to.deep.equal({ kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [{ type: 'user', id: 'alice' }] } }], deny: [] });
    expect(await plan([row('m', 'member', P1)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'member', relation: 'owner' }])], deny: [] });
    expect(await plan([row('m', 'member', P1), row('v', 'viewer', P2)])).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'member', relation: 'owner' }, { role: 'viewer' }])], deny: [] });
  });

  it('a DB rule store without a matching rule does not block the list', async () => {
    const stored = new MemoryRuleStore({ rules: [{ id: 'other', kind: 'cap', scope: GLOBAL, resourceTypes: ['project'], stripTags: true, source: 'db' }] });
    expect(await plan([row('v', 'viewer', P1)], { rules: stored })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }])], deny: [] });
  });

  it('a stored rule that can match fails the list closed and is logged once', async () => {
    const warned: string[] = [];
    const reg = registry();
    const stored = new MemoryRuleStore({ rules: [{ id: 'old-cap', kind: 'cap', scope: { type: 'project', id: 'p1' }, stripTags: true, source: 'db' }] });
    const m = new RbacModel({ roles: new MemoryRoleStore(ROLES), assignments: new MemoryAssignmentStore([row('v', 'viewer', P1)]), rules: stored, log: { warn: (msg) => warned.push(msg) } });
    await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
    m.grantIndex();
    for (let i = 0; i < 2; i++) {
      let caught: unknown;
      try {
        await m.listPlan({ principal: alice, permission: reg.require('doc:read'), type: 'doc', env: { now: NOW } }, ctx());
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).to.contain("rule 'old-cap' (cap, source: db) can apply to doc:read on \"doc\"");
    }
    expect(warned.filter((msg) => msg.includes("'old-cap'"))).to.have.length(1);
    const expired = new MemoryRuleStore({ rules: [{ id: 'gone', kind: 'cap', scope: GLOBAL, stripTags: true, expiresAt: new Date(NOW.getTime() - 1), source: 'db' }] });
    expect((await plan([row('v', 'viewer')], { rules: expired })).kind).to.equal('all');
  });

  it('a rule store that cannot list its rules fails every list closed', async () => {
    let caught: unknown;
    try {
      await plan([row('v', 'viewer', P1)], { rules: new EmptyDbRules() });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).to.contain("rule store 'EmptyDbRules' cannot list its rules");
  });

  it('a ceiling keeps its roles only, never drops a deny', async () => {
    const capped = withCeiling(alice, { roles: ['viewer'] });
    expect(await plan([row('v', 'viewer', P1), row('e', 'editor', P2), row('b', 'blocked', O1)], { principal: capped })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }])], deny: [assignmentTerm([{ role: 'blocked' }], { global: true })] });
  });

  it('sets are explicit subjects until maxPlanSubjects, then the term reads the membership table', async () => {
    const rows = [row('m', 'org.member', O1), row('s', 'viewer', P1, {}, { set: { role: 'org.member', scope: O1 } })];
    expect(await plan(rows)).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }], { subjects: ['org:o1#org.member', ...ALICE] })], deny: [] });
    expect(await plan(rows, { config: { maxPlanSubjects: 2 } })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }], { membership: true, memberKeys: ALICE })], deny: [] });
    const nested = [row('n', 'viewer', P1, {}, { set: { role: 'org.member', scope: { type: 'org', id: 'o2' } } })];
    expect(await plan(nested, { membership: new Closure({ 'user:alice': ['org:o2#org.member'] }) })).to.deep.equal({ kind: 'terms', permit: [assignmentTerm([{ role: 'viewer' }], { subjects: ['org:o2#org.member', ...ALICE] })], deny: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/list-plan.test.ts`
Expected: FAIL: TSError `Property 'listPlan' does not exist on type 'RbacModel'`.

- [ ] **Step 3: The plan builder**

Create `src/model/list/plan.ts`:

```ts
import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { AssignmentSubject, ModelListPlan, PlanTerm, Principal, ResourceType } from '@spinajs/authz';

import { RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs } from '../../plan/args.js';
import type { RbacAssignmentPlanArgs, RbacPlanRole } from '../../plan/args.js';
import { subjectKeyOf } from '../../stores/columns.js';
import { subjectKey } from '../assignments.js';
import { roleDenied } from '../deny.js';
import type { LiveAssignment, RbacState } from '../evaluate.js';
import type { CompiledGrant } from '../grants.js';
import { reachableGrants } from '../ladder/steps.js';
import { usableVia } from '../sets/extension.js';
import { principalSubjectKey } from '../sets/keys.js';
import { WILDCARD_ID } from '../sets/resolver.js';

export const DEFAULT_MAX_PLAN_SUBJECTS = 500;
export const RELATION_OWNER_OP = 'relation.owner';
export const RELATION_SELF_OP = 'relation.self';

/** relation.owner / relation.self (overview names table): the row's owner (self) is one of these principals; L4 compiles it. */
export interface RelationPlanArgs {
  readonly principals: readonly { readonly type: string; readonly id: string }[];
}

type Holders = Pick<RbacAssignmentPlanArgs, 'subjects' | 'membership' | 'memberKeys'>;

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unique = (list: readonly string[]): string[] => [...new Set(list)];
const everywhere = (l: LiveAssignment, type: ResourceType): boolean => l.scope.type === GLOBAL.type || (l.scope.type === type && l.scope.id == null);

/**
 * The list plan of design §6.2 from the state after `cap` of the type-level request `{ type }`: `live` holds
 * the $global and type-level assignments (decided here), `scoped` the others (rbac.assignment terms),
 * `denied` the deny rows. Lane L8 decisions 6-9.
 * @throws Error where a list cannot be planned exactly (rules, a tag carried apart); L2 makes it deny-all model_error
 */
export function rbacListPlan(s: RbacState, opts: { readonly maxSubjects: number }): ModelListPlan {
  const { input, permission } = s;
  const type = input.request.resource.type;
  if ((input.rules?.length ?? 0) > 0 || (input.rowDependentRules?.length ?? 0) > 0) throw new Error(`rbac: rules apply to ${permission} on ${JSON.stringify(type)}, so it is not list-filterable`);
  const ends: number[] = [];
  const bound = (until: Date | undefined) => {
    if (until) ends.push(until.getTime());
  };
  const finish = (plan: ModelListPlan): ModelListPlan => Object.freeze(ends.length > 0 && plan.kind !== 'abstain' ? { ...plan, validUntil: new Date(Math.min(...ends)) } : plan);

  const denying = s.denied.filter((l) => input.grants.denies(l.role, permission));
  const denyAll = denying.filter((l) => everywhere(l, type));
  if (denyAll.length > 0) {
    for (const l of denyAll) bound(l.expiresAt);
    return finish({ kind: 'deny-all', reason: Object.freeze(roleDenied(denyAll.map((l) => l.role))) });
  }

  const entries = new Map<string, RbacPlanRole>();
  const add = (l: LiveAssignment, extra: { readonly scopeTypes?: readonly string[]; readonly tag?: string; readonly relation?: 'owner' | 'self' } = {}) => {
    const scopeTypes = intersect(input.roles.get(l.assignment.role)?.scopeTypes, extra.scopeTypes);
    if (scopeTypes && scopeTypes.length === 0) return;
    const entry: RbacPlanRole = { role: l.assignment.role, ...(scopeTypes ? { scopeTypes } : {}), ...(extra.tag !== undefined ? { tag: extra.tag } : {}), ...(l.onlyBelow ? { descendantsOnly: true } : {}), ...(extra.relation ? { relation: extra.relation } : {}) };
    entries.set(JSON.stringify(entry), entry);
  };
  const relations = new Set<'owner' | 'self'>();
  let all = false;
  const liveTags = new Set(s.live.flatMap((l) => l.tags));

  for (const l of s.live) {
    for (const g of reachableGrants(s, l)) {
      if (!admits(g, type) || (g.grantedAt && !g.grantedAt.includes(l.scope.type))) continue;
      bound(l.expiresAt);
      if (g.requiresTag !== undefined && !liveTags.has(g.requiresTag)) {
        if (g.relations) throw new Error(`rbac: role '${g.role}' grants ${permission} with a relation and tag '${g.requiresTag}', which a list cannot join`);
        // Held everywhere; the rows are those under an assignment carrying the tag.
        for (const c of s.scoped) if (!c.impliedBy && c.tags.includes(g.requiresTag)) add(c, { tag: g.requiresTag });
        continue;
      }
      if (!g.relations) {
        all = true;
        continue;
      }
      for (const r of g.relations) {
        if (r !== 'owner' && r !== 'self') throw new Error(`rbac: role '${g.role}' grants ${permission} with the relation '${r}', which lists do not support`);
        relations.add(r);
      }
    }
  }

  for (const l of s.scoped) {
    for (const g of reachableGrants(s, l)) {
      if (!admits(g, type) || (g.grantedAt && !g.grantedAt.includes(l.scope.type))) continue;
      if (g.relations) {
        // listSupport refuses a relation with requiresTag or grantedAt, so the relation is the only qualifier.
        for (const r of g.relations) {
          if (r !== 'owner' && r !== 'self') throw new Error(`rbac: role '${g.role}' grants ${permission} with the relation '${r}' at ${resourceKey(l.scope)}, which lists do not support`);
          add(l, { relation: r });
        }
        continue;
      }
      const tag = g.requiresTag;
      if (tag === undefined || liveTags.has(tag)) add(l, g.grantedAt ? { scopeTypes: g.grantedAt } : {});
      else if (l.impliedBy && l.tags.includes(tag)) add(l);
      else if (!l.impliedBy && l.tags.includes(tag)) add(l, { tag });
      else if (s.scoped.some((c) => c.tags.includes(tag) && !reachableGrants(s, c).includes(g))) throw new Error(`rbac: tag '${tag}' that ${permission} requires is carried apart from role '${g.role}'; lists follow a tag only on the assignment that grants the role`);
    }
  }

  if (!all && entries.size === 0 && relations.size === 0) return Object.freeze({ kind: 'abstain' });
  const denyRoles = unique(denying.map((l) => l.role)).sort(byCodePoint);
  const deny: PlanTerm[] = denyRoles.length === 0 ? [] : [term(RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs({ ...holders(s, true, opts.maxSubjects), roles: denyRoles.map((role) => ({ role })), global: true }))];
  if (all) return finish(deny.length === 0 ? { kind: 'all' } : { kind: 'all', deny: Object.freeze(deny) });
  const permit: PlanTerm[] = [
    ...(entries.size > 0 ? [term(RBAC_ASSIGNMENT_PLAN_OP, rbacPlanArgs({ ...holders(s, false, opts.maxSubjects, bound), roles: [...entries.values()], global: false }))] : []),
    ...[...relations].sort(byCodePoint).map((r) => term(r === 'owner' ? RELATION_OWNER_OP : RELATION_SELF_OP, relationArgs(input.request.principal))),
  ];
  return finish({ kind: 'terms', permit: Object.freeze(permit), deny: Object.freeze(deny) });
}

const term = (op: string, args: unknown): PlanTerm => Object.freeze({ op, args });

/** The principal and its companions, each once, as the relation resolvers of checks see them. */
function relationArgs(principal: Principal): RelationPlanArgs {
  const seen = new Map<string, { readonly type: string; readonly id: string }>();
  for (const p of [principal, ...(principal.companions ?? [])]) seen.set(JSON.stringify([p.type, p.id]), Object.freeze({ type: p.type, id: p.id }));
  return Object.freeze({ principals: Object.freeze([...seen.values()]) });
}

/** A type-only pattern admits its own type; an `on` id is refused by listSupport and here. */
function admits(g: CompiledGrant, type: ResourceType): boolean {
  if (!g.patterns) return true;
  if (g.patterns.some((p) => p.id !== undefined)) throw new Error(`rbac: role '${g.role}' limits ${g.permission} with \`on\` ids, so it is not list-filterable`);
  return g.patterns.some((p) => p.type === type);
}

function intersect(a: readonly string[] | undefined, b: readonly string[] | undefined): readonly string[] | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((t) => b.includes(t));
}

/**
 * The holders of a term: explicit keys while they are few (their membership expiry bounds the plan), else the
 * membership sub-query (decision 2 of the overview). Permits leave out sets no usable membership reaches and,
 * under a ceiling, nested sets; denies keep every live set.
 */
function holders(s: RbacState, deny: boolean, max: number, bound?: (until: Date | undefined) => void): Holders {
  const { subjects = [], memberships, nestedSets } = s.input;
  const base: AssignmentSubject[] = [];
  const sets: AssignmentSubject[] = [];
  const ends: (Date | undefined)[] = [];
  for (const subject of subjects) {
    const key = subjectKey(subject);
    const entry = 'set' in subject ? memberships?.get(key) : undefined;
    const nested = 'set' in subject ? nestedSets?.get(key) : undefined;
    if (entry) {
      const usable = usableVia(s, entry.via, deny);
      if (usable.length === 0) continue;
      sets.push(subject);
      ends.push(usable.every((m) => m.expiresAt) ? new Date(Math.max(...usable.map((m) => m.expiresAt!.getTime()))) : undefined);
    } else if (nested) {
      if (!deny && s.ceilingRoles !== undefined) continue;
      sets.push(subject);
      ends.push(nested.expiresAt);
    } else {
      base.push(subject);
    }
  }
  // The resolver never yields a principal whose id is '*' (lane decision 1), so `{ type, id: '*' }` here is the wildcard.
  const baseKeys = unique(base.map((b) => ('set' in b || b.id === WILDCARD_ID ? subjectKeyOf(b) : principalSubjectKey(b))));
  const explicit = unique([...baseKeys, ...sets.map(subjectKeyOf)]);
  if (explicit.length <= max) {
    if (bound) for (const end of ends) bound(end);
    return { subjects: explicit, membership: false, memberKeys: [] };
  }
  if (!deny && s.ceilingRoles !== undefined) throw new Error(`rbac: ${explicit.length} subjects exceed authz.rbac.maxPlanSubjects (${max}) under a ceiling`);
  if (baseKeys.length > max) throw new Error(`rbac: ${baseKeys.length} subjects exceed authz.rbac.maxPlanSubjects (${max})`);
  return { subjects: baseKeys, membership: true, memberKeys: baseKeys };
}
```

Add `export * from './plan.js';` to `src/model/list/index.ts`.

- [ ] **Step 4: The model and the config**

In `src/stores/schema.ts` import `DEFAULT_MAX_PLAN_SUBJECTS` from `'../model/list/plan.js'` and add to the root `properties` (after `serviceRoles`):

```ts
    // Above this many subject keys a list term reads authz_subject_membership in the query (MSSQL's 2100 parameters).
    maxPlanSubjects: { type: 'integer', minimum: 1, default: DEFAULT_MAX_PLAN_SUBJECTS },
```

In `src/model/model.ts`:
- type imports gain `ListPlanRequest`, `ModelListPlan`; value import `import { DEFAULT_MAX_PLAN_SUBJECTS, rbacListPlan } from './list/plan.js';` and `rbacState` from `./evaluate.js` (extend L6's import).
- `interface Loaded` gains `readonly maxPlanSubjects: number;`
- in `init`, before `this.loaded = {`:

```ts
    const maxPlanSubjects = ctx.config<number>('maxPlanSubjects', DEFAULT_MAX_PLAN_SUBJECTS);
    // An unvalidated configuration still gets here.
    if (!Number.isInteger(maxPlanSubjects) || maxPlanSubjects < 1) throw new AuthzConfigError('authz.rbac.maxPlanSubjects must be a positive integer');
```

  and add `maxPlanSubjects` to the `this.loaded = { ... }` object.
- import `isDbRulesMarker` with `ruleStoreParts` (L8): `import { isDbRulesMarker, ruleStoreParts } from './rules/extension.js';`; also `import { ruleCanMatch } from './list/support.js';`, `import { AdminRuleStore } from '../admin/ports.js';`, the types `Permission`, `RuleDef` (core) and `RuleStore` (`../contracts.js`, already imported as a type: make it a value import only if tsc asks).
- fields, next to `warnedAssignments`:

```ts
  private readonly warnedListRules = new Set<string>();
  private storedRulesAt?: { readonly version: string; readonly rules: readonly RuleDef[] };
```

  and `const STORED_RULES_PAGE = 500;` next to `SETS_MEMO`.

In `src/model/rules/extension.ts`, in `activate`, replace ``if (this.db) rowDependent.push(`* (${this.db.name})`);`` with `if (this.db) rowDependent.push(dbRulesMarker(this.db.name));`, and add at module level after `DB_RULES_KEY`:

```ts
/** The row-dependent entry `activate` adds for a rule store it cannot read whole from a type-level path. */
export const dbRulesMarker = (store: string): string => `* (${store})`;
export const isDbRulesMarker = (id: string): boolean => id.startsWith('* (') && id.endsWith(')');
```

- add after `listSupport`:

```ts
  /** Design §6.2: the gathered input of the type-level request `{ type }`, through `cap`, as a list plan (rbacListPlan). */
  async listPlan(req: ListPlanRequest, ctx: EvaluationContext): Promise<ModelListPlan> {
    await this.freshRoles();
    const request: DecisionRequest = { principal: req.principal, ...(req.actor ? { actor: req.actor } : {}), permission: req.permission.name, resource: { type: req.type }, ...(req.env ? { env: req.env } : {}) };
    await this.refuseListRules(req.permission.name, req.type, ctx.now);
    const read = await readRbacInput(request, ctx, this.sources());
    // Every stored rule was checked above (lane decision 12); the DB store's marker is not a rule.
    const input = { ...read, rowDependentRules: (read.rowDependentRules ?? []).filter((id) => !isDbRulesMarker(id)) };
    return rbacListPlan(rbacState(input, 'cap'), { maxSubjects: this.state().maxPlanSubjects });
  }

  /**
   * Lane decision 12: a live rule, config or stored, that can match `permission` on `type` narrows checks a
   * plan cannot follow, so the list fails closed. Rules stored before the permission became `list: true`
   * are found here; RbacRuleListGuard refuses new ones.
   * @throws Error naming the rule (L2 makes it deny-all model_error)
   */
  private async refuseListRules(permission: Permission, type: ResourceType, now: Date): Promise<void> {
    const { config, db } = ruleStoreParts(this.opts.rules);
    const rules = [...(config?.all() ?? []), ...(db ? await this.storedRules(db) : [])];
    const live = (r: RuleDef) => r.expiresAt == null || r.expiresAt.getTime() > now.getTime();
    const blocking = rules.find((r) => live(r) && ruleCanMatch(r, permission, type));
    if (!blocking) return;
    const text = `rbac: rule '${blocking.id}' (${blocking.kind}, source: ${blocking.source}) can apply to ${permission} on ${JSON.stringify(type)}, so lists of it are refused; delete or narrow the rule`;
    if (!this.warnedListRules.has(blocking.id)) {
      this.warnedListRules.add(blocking.id);
      this.log.warn(text);
    }
    throw new Error(text);
  }

  /** The DB rule store whole, read again only when its version moves. */
  private async storedRules(db: RuleStore): Promise<readonly RuleDef[]> {
    if (!(db instanceof AdminRuleStore)) throw new Error(`rbac: rule store '${db.name}' cannot list its rules, so no list can be planned (a stored rule could narrow it)`);
    const version = await db.version();
    if (this.storedRulesAt?.version === version) return this.storedRulesAt.rules;
    const rules: RuleDef[] = [];
    for (let offset = 0; ; ) {
      const { items, total } = await db.find({}, { limit: STORED_RULES_PAGE, offset });
      rules.push(...items);
      offset += items.length;
      if (items.length === 0 || offset >= total) break;
    }
    this.storedRulesAt = { version, rules };
    return rules;
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/model/list-plan.test.ts`
Expected: PASS, `11 passing`.

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing` (a config-schema snapshot test, if any, now also lists `maxPlanSubjects: 500` in the filled defaults: add it there).

- [ ] **Step 6: Commit**

```bash
git add packages/authz-rbac/src/model packages/authz-rbac/src/stores/schema.ts packages/authz-rbac/test/model/list-plan.test.ts
git commit -m "feat(authz-rbac): listPlan with rbac.assignment, relation and deny terms"
```

---

### Task 9: `ListSupportGuard` for `rule.put`

**Files:**
- Create: `src/admin/list-guard.ts`
- Modify: `src/admin/index.ts`
- Test: `test/admin/rule-list-guard.test.ts`

**Interfaces:**
- Consumes: L2 Task 7 `ListSupportGuard`; `permissionRegistry(ctx)` (`src/admin/common.ts`); `ruleCanMatch` (Task 6).
- Produces: `RbacRuleListGuard` (`@Singleton() @Injectable(ListSupportGuard)`), refusing with `AuthzAdminFailure('not_list_filterable', "rbac rule '<id>' (<kind>) can apply to <permission> on \"<type>\", which is list: true; lists cannot follow rules", 'rule')`.

- [ ] **Step 1: Write the failing test**

Create `test/admin/rule-list-guard.test.ts`:

```ts
import { AuthzAdminFailure, AuthzConfigError, GLOBAL, ListSupportGuard, PermissionRegistryImpl } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, AuthzService } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { MemoryAssignmentStore, MemoryRoleStore, RbacModel, RbacRuleListGuard } from '../../src/index.js';

const expect = chai.expect;

async function context(): Promise<AdminContext> {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc'], list: true }, { name: 'doc:write', types: ['doc'] }, { name: 'job:read', types: ['job'], list: true }], 'test');
  registry.freeze();
  const model = new RbacModel({ roles: new MemoryRoleStore([]), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return { domain: 'root', now: new Date('2026-10-14T12:00:00.000Z'), authz: { models: () => [model] } as unknown as AuthzService };
}

const put = (rule: Record<string, unknown>): AuthzCommand => ({ kind: 'rule.put', rule: { scope: GLOBAL, ...rule } as never });

async function refusal(p: Promise<unknown>): Promise<AuthzAdminFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(AuthzAdminFailure);
    return e as AuthzAdminFailure;
  }
  throw new Error('expected a refusal');
}

describe('authz-rbac RbacRuleListGuard (design §7)', () => {
  it('is registered as a ListSupportGuard', async () => {
    expect(((await DI.resolve(Array.ofType(ListSupportGuard))) as ListSupportGuard[]).some((g) => g instanceof RbacRuleListGuard)).to.equal(true);
  });

  it('refuses a cap or restrict on a type with a list permission', async () => {
    const e = await refusal(new RbacRuleListGuard().checkCommand(put({ id: 'strip', kind: 'cap', stripTags: true }), await context()));
    expect(e).to.deep.include({ code: 'not_list_filterable', field: 'rule' });
    expect(e.message).to.equal("rbac rule 'strip' (cap) can apply to doc:read on \"doc\", which is list: true; lists cannot follow rules");
  });

  it('accepts a rule that cannot reach a list permission', async () => {
    const guard = new RbacRuleListGuard();
    await guard.checkCommand(put({ id: 't', kind: 'threshold', permissions: ['doc:write'], minRole: 'x' }), await context());
    await guard.checkCommand(put({ id: 'r', kind: 'restrict', resourceTypes: ['folder'], allow: [] }), await context());
    await guard.checkCommand({ kind: 'policy.put', policy: { id: 'p', effect: 'permit', permissions: ['doc:read'] } }, await context());
  });

  it('a domain without a permission registry is a configuration error', async () => {
    const ctx = { ...(await context()), authz: { models: () => [] } as unknown as AuthzService };
    let caught: unknown;
    try {
      await new RbacRuleListGuard().checkCommand(put({ id: 'strip', kind: 'cap', stripTags: true }), ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught).to.not.be.instanceOf(AuthzAdminFailure);
    expect(caught === undefined || caught instanceof AuthzConfigError || /registry|container/i.test((caught as Error).message)).to.equal(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz && npm run compile && cd ../authz-rbac && npx ts-mocha -p tsconfig.json test/admin/rule-list-guard.test.ts`
Expected: FAIL: TSError `Module '"../../src/index.js"' has no exported member 'RbacRuleListGuard'`.

- [ ] **Step 3: Implement**

Create `src/admin/list-guard.ts`:

```ts
import { AuthzAdminFailure, AuthzConfigError, ListSupportGuard } from '@spinajs/authz';
import type { AdminContext, AuthzCommand, RuleDef } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { ruleCanMatch } from '../model/list/support.js';
import { permissionRegistry, quote } from './common.js';

/** Design §7 at write time: a stored rule may never reach a `list: true` permission. */
@Singleton()
@Injectable(ListSupportGuard)
export class RbacRuleListGuard extends ListSupportGuard {
  async checkCommand(c: AuthzCommand, ctx: AdminContext): Promise<void> {
    if (c.kind !== 'rule.put') return;
    const rule = c.rule as Pick<RuleDef, 'id' | 'kind' | 'resourceTypes' | 'permissions'>;
    const registry = await permissionRegistry(ctx);
    if (!registry) throw new AuthzConfigError(`Authz domain ${quote(ctx.domain)}: RbacRuleListGuard needs the permission registry to find the list permissions`);
    for (const def of [...registry.all()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!def.list) continue;
      const type = def.types.find((t) => ruleCanMatch(rule, def.name, t));
      if (type !== undefined) throw new AuthzAdminFailure('not_list_filterable', `rbac rule '${rule.id}' (${rule.kind}) can apply to ${def.name} on ${JSON.stringify(type)}, which is list: true; lists cannot follow rules`, 'rule');
    }
  }
}
```

Add `export * from './list-guard.js';` to `src/admin/index.ts` (after `./guard.js`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/rule-list-guard.test.ts`
Expected: PASS, `4 passing`. (`permissionRegistry` falls back to `adminContainer(ctx)` when no model exposes a registry; with the fake context that throws, which is the configuration error the last case expects.)

- [ ] **Step 5: Commit**

```bash
git add packages/authz-rbac/src/admin/list-guard.ts packages/authz-rbac/src/admin/index.ts packages/authz-rbac/test/admin/rule-list-guard.test.ts
git commit -m "feat(authz-rbac): refuse rule.put that can reach a list permission"
```

---

### Task 10: `RbacChangeAudience`

**Files:**
- Create: `src/host/audience.ts`
- Modify: `src/host/index.ts`
- Test: `test/host/audience.test.ts`

**Interfaces:**
- Consumes: L0 `ChangeAudience`, `AuthzChange`; `MembershipStore.membersOf`; `parseSetKey` (Task 4). L2 router convention: an audience answers `{ principals, objects? }`; `objects` absent means "refetch everything".
- Produces: `RbacChangeAudience` (`@Singleton() @Injectable(ChangeAudience) @Inject(Container)`): `subject:<principal key>` → that key; `link:<id>` → `link:<id>`; `subject:<set key>` → the set's principal members (`membersOf`), `'*'` without a registered `MembershipStore` or when a member is a wildcard; `subject:<type>:*` and every other tag → `'*'`. Never `objects`. A change without tags → `{ principals: [], objects: [] }`.

- [ ] **Step 1: Write the failing test**

Create `test/host/audience.test.ts`:

```ts
import type { AuthzChange } from '@spinajs/authz';
import { ChangeAudience } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { MembershipStore, RbacChangeAudience } from '../../src/index.js';

const expect = chai.expect;

class Members extends MembershipStore {
  constructor(private readonly members: Readonly<Record<string, readonly string[]>>) {
    super();
  }
  async setsOf(): Promise<readonly string[]> {
    return [];
  }
  async membersOf(setKey: string): Promise<readonly string[]> {
    return this.members[setKey] ?? [];
  }
}

const container = (store?: MembershipStore): IContainer => ({ hasRegistered: () => store !== undefined, resolve: async () => store }) as unknown as IContainer;
const change = (...tags: string[]): AuthzChange => ({ tags, at: new Date('2026-10-14T12:00:00.000Z') });

describe('authz-rbac RbacChangeAudience (design §10.4)', () => {
  const store = new Members({ 'team:t1#member': ['user:alice', 'team:t2#member', 'user:bob'], 'team:all#member': ['user:*'] });
  const audience = new RbacChangeAudience(container(store));

  it('is registered as a ChangeAudience', async () => {
    expect(((await DI.resolve(Array.ofType(ChangeAudience))) as ChangeAudience[]).some((a) => a instanceof RbacChangeAudience)).to.equal(true);
  });

  it('narrows subject and link tags to their principals, without objects', async () => {
    expect(await audience.audience(change('subject:user:bob', 'subject:user:alice', 'link:l1', 'subject:link:l1'))).to.deep.equal({ principals: ['link:l1', 'user:alice', 'user:bob'] });
  });

  it('a set subject goes to its principal members', async () => {
    expect(await audience.audience(change('subject:team:t1#member'))).to.deep.equal({ principals: ['user:alice', 'user:bob'] });
  });

  it('wildcards, roles, rules, policies and scopes go to everyone', async () => {
    for (const tag of ['subject:user:*', 'subject:team:all#member', 'role:viewer', 'rule:r1', 'policy:p1', 'scope:project:p1', 'model:rbac']) {
      expect(await audience.audience(change('subject:user:alice', tag)), tag).to.deep.equal({ principals: '*' });
    }
  });

  it('without a MembershipStore a set subject goes to everyone; no tags concern nobody', async () => {
    expect(await new RbacChangeAudience(container()).audience(change('subject:team:t1#member'))).to.deep.equal({ principals: '*' });
    expect(await audience.audience(change())).to.deep.equal({ principals: [], objects: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/host/audience.test.ts`
Expected: FAIL: TSError `Module '"../../src/index.js"' has no exported member 'RbacChangeAudience'`.

- [ ] **Step 3: Implement**

Create `src/host/audience.ts`:

```ts
import { ChangeAudience } from '@spinajs/authz';
import type { AuthzChange, ResourceRef } from '@spinajs/authz';
import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { MembershipStore } from '../contracts.js';
import { parseSetKey } from '../model/sets/keys.js';

type Answer = { readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] };

const EVERYONE: Answer = Object.freeze({ principals: '*' });
const NOBODY: Answer = Object.freeze({ principals: Object.freeze([]), objects: Object.freeze([]) });

const isWildcardKey = (key: string): boolean => key.endsWith(':*') && parseSetKey(key) === undefined;

/**
 * Who an RBAC change reaches (design §10.4, lane L8 decision 10). No `objects`: whether a changed scope has
 * descendants is in authz-orm's ancestor table, which this package does not read, so clients refetch.
 */
@Singleton()
@Injectable(ChangeAudience)
@Inject(Container)
export class RbacChangeAudience extends ChangeAudience {
  constructor(private readonly container: IContainer) {
    super();
  }

  async audience(change: AuthzChange): Promise<Answer> {
    if (change.tags.length === 0) return NOBODY;
    const out = new Set<string>();
    for (const tag of change.tags) {
      const keys = await this.principalsOf(tag, change.at);
      if (keys === '*') return EVERYONE;
      for (const k of keys) out.add(k);
    }
    return Object.freeze({ principals: Object.freeze([...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) });
  }

  private async principalsOf(tag: string, at: Date): Promise<readonly string[] | '*'> {
    if (tag.startsWith('link:')) return [`link:${tag.slice('link:'.length)}`];
    if (!tag.startsWith('subject:')) return '*';
    const key = tag.slice('subject:'.length);
    if (parseSetKey(key)) return this.members(key, at);
    return isWildcardKey(key) ? '*' : [key];
  }

  private async members(setKey: string, at: Date): Promise<readonly string[] | '*'> {
    if (!this.container.hasRegistered(MembershipStore)) return '*';
    const store = (await this.container.resolve(MembershipStore)) as MembershipStore;
    const members = await store.membersOf(setKey, at);
    if (members.some(isWildcardKey)) return '*';
    return members.filter((k) => parseSetKey(k) === undefined);
  }
}
```

Add `export * from './audience.js';` to `src/host/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/host/audience.test.ts`
Expected: PASS, `5 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-rbac/src/host/audience.ts packages/authz-rbac/src/host/index.ts packages/authz-rbac/test/host/audience.test.ts
git commit -m "feat(authz-rbac): RbacChangeAudience routes RBAC changes to the principals they reach"
```

---

### Task 11: Delete the old type-level list path

**Files:**
- Create: `src/model/scope.ts`, `docs/plans/authz-v3-rfc/RA8-1.md` (repo root)
- Delete: `src/model/native.ts`, `src/model/rules/native.ts`, `src/model/rules/args.ts`, `src/model/rules/bind.ts`, `test/model/native.test.ts`, `test/rules/native.test.ts`, `test/behaviour.native.test.ts`
- Modify: `src/contracts.ts` (L1-2, L84-87), `src/model/evaluate.ts`, `src/model/deny.ts`, `src/model/service.ts`, `src/model/sets/extension.ts`, `src/model/rules/extension.ts`, `src/model/rules/index.ts` (L5-7), `src/model/rules/steps.ts` (L30), `src/model/rows.ts` (L17-18), `src/model/index.ts` (L5), `scripts/api-snapshot.json` (generated)
- Modify tests: `test/admin/rbac-admin-harness.ts` (L7, L55), `test/sets/sets.test.ts`, `test/behaviour.l1b.test.ts`, `test/behaviour.model.test.ts`, `test/contracts.test.ts` (L260-274), `test/integration/stores.db.test.ts`, `test/ladder/checks.test.ts`, `test/ladder/implies.test.ts`, `test/model/evaluate.test.ts` (L790-835), `test/model/intersect.test.ts`, `test/model/model.test.ts` (L7, L71), `test/rules/conformance.test.ts`, `test/rules/properties.test.ts`, `test/token/extension.test.ts`

**Interfaces:**
- Removes (lane decision 13): `RBAC_ASSIGNMENT_OP`, `RBAC_THRESHOLD_OP`, `RBAC_RESIDUALS` (`src/contracts.ts`, snapshotted), `rbacAssignmentExtension`, `RbacAssignmentFilter`, `rbacAssignmentArgs`, `parseRbacAssignmentArgs`, `heldAssignments`, `copySubject`, `readSubject` (of `native.ts`), `RbacAssignmentArgs`, `RbacArgsSubject`, `MAX_ARGS_SUBJECTS`, `MAX_ARGS_ROLES`, `RbacListEvaluator`, `RbacThresholdFilter`, `nativeListVote`, `NativeListInput`, `RULES_EXTENSION_KIND`, every export of `rules/args.ts` and `rules/bind.ts`, `NativeNeedsV2`, `RbacInput.scopedResidual`, `RbacInput.native`, `RbacExtension.listsRules`, `usableSubjects`.
- Moves: `scopeMatcher(type, path)` to `src/model/scope.ts` (exported from the package root as before).
- Keeps: type-level check votes with `under` terms (`underTerm`), `RbacExtension.residuals` / `nativeFilters` (generic hooks).

- [ ] **Step 1: Delete the native contract test first (failing build as the red step)**

Delete `test/model/native.test.ts`, `test/rules/native.test.ts`, `test/behaviour.native.test.ts`, then in `test/contracts.test.ts` delete the two cases at L260-274 (`RBAC_ASSIGNMENT_OP and RBAC_THRESHOLD_OP ...` and `RBAC_RESIDUALS is the frozen §6.1.4 list`) and add in their place:

```ts
  it('the native list ops are gone (RFC RA8-1)', () => {
    const exported = root as Record<string, unknown>;
    expect(exported.RBAC_ASSIGNMENT_OP).to.equal(undefined);
    expect(exported.RBAC_THRESHOLD_OP).to.equal(undefined);
    expect(exported.RBAC_RESIDUALS).to.equal(undefined);
    expect(exported.rbacAssignmentExtension).to.equal(undefined);
  });
```

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/contracts.test.ts`
Expected: FAIL in `the native list ops are gone`.

- [ ] **Step 2: Move `scopeMatcher`**

Create `src/model/scope.ts`:

```ts
import { GLOBAL, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';

/**
 * Whether an assignment scope applies to a resource of `type` with this path: GLOBAL, a node of the
 * path by key, or the type-only scope of `type` itself. A type-only scope of another type reaches
 * nothing: the engine reads a type-only `under` scope differently, so no row filter may depend on one.
 */
export function scopeMatcher(type: ResourceType, path: readonly ResourceRef[]): (scope: ResourceRef) => boolean {
  const keys = new Set([...path, GLOBAL, { type }].map(resourceKey));
  return (scope) => keys.has(resourceKey(scope));
}
```

Change the imports `import { scopeMatcher } from './native.js';` in `src/model/deny.ts` and `src/model/service.ts` to `import { scopeMatcher } from './scope.js';`. In `src/model/index.ts` replace `export * from './native.js';` with `export * from './scope.js';`.

- [ ] **Step 3: `evaluate.ts`**

- Delete the imports `import { RBAC_ASSIGNMENT_OP } from '../contracts.js';`, `import { nativeListVote } from './rules/native.js';`, `import type { NativeListInput } from './rules/native.js';`; replace `import { rbacAssignmentArgs, scopeMatcher } from './native.js';` with `import { scopeMatcher } from './scope.js';`; the sets import becomes `import { applyMemberships, setsExtension } from './sets/extension.js';`.
- In the header comment, in the type-level bullet delete `, or \`native:rbac.assignment\``, and delete from `A scoped grant with \`requiresTag\`` to the end of that bullet; replace the last bullet (`- With a list extension ...`) with:

```ts
 * - Lists do not use type-level votes: RbacModel.listPlan builds its terms from the state after `cap`.
```

- In `RbacInput` delete the members `scopedResidual` and `native` with their doc comments.
- In `residualWith` delete the lines `if (c.rows) nativeCannotCarry(s);` and `if (checks.some((c) => c.rows.op !== 'true' && c.rows.op !== 'false')) nativeCannotCarry(s);`.
- Delete `nativeCannotCarry`, `mayBeAssignedAt`, `nativeVote` and `NativeNeedsV2` (with their comments), and replace `scopedRows` and `runRbacPipeline` with:

```ts
/** The rows below the holders' scopes (underTerm). */
function scopedRows(s: RbacState, holders: readonly LiveAssignment[]): ResourceFilter {
  return underTerm(holders, s.input.request.resource.type);
}
```

```ts
/** Runs the steps over the gathered input, synchronously. */
export function runRbacPipeline(input: RbacInput, steps: RbacSteps = RBAC_STEPS): Vote {
  return toVote(rbacState(input, 'residual', steps));
}
```

- In `newState` replace `cacheable: input.native?.cacheable !== false` with `cacheable: true`.
- In `interface RbacExtension` delete `listsRules` with its doc comment.

- [ ] **Step 4: Rules, sets, rows and the contracts**

`src/model/rules/extension.ts`:
- `gather` becomes:

```ts
  gather(request: DecisionRequest, ctx: EvaluationContext, input: RbacInput, _sources: RbacSources): Partial<RbacInput> | Promise<Partial<RbacInput>> {
    const { config, db } = this;
    if (!config && !db) return {};
    const own = config ? config.rulesOn(input.path, input.now) : [];
    return db ? this.dbRulesOn(input.path, input.now, ctx).then((stored) => this.activate([...own, ...stored], request, ctx, input)) : this.activate(own, request, ctx, input);
  }
```

- delete `readonly kind = RULES_EXTENSION_KIND;`, the fields `bindings`, `listings`, `compiledWith`, `extensions`, the `listing` getter, `listInput`, `boundSet`, the line `this.compiledWith = { graph, grants };` in `compile`, and at module level `Listing`, `BoundSet`, `MAX_BOUND_PRINCIPALS`, `usable`; update the class doc comment's "and are bound into list terms; DB rules are read per path, and per row in lists (`dbRules`)" to "; DB rules are read per path".
- run `npx tsc -p tsconfig.json --noEmit` and delete each import it reports unused (expected: `BoundRule`, `bindRule`, `Binding`, `RULES_EXTENSION_KIND`, `thresholdReason`, `rbacTables`, `DenyReason`).

`src/model/rules/index.ts`: delete L5-7 (the `./args.js` and `./native.js` re-exports).

`src/model/rules/steps.ts` L30: the `RuleRowsError` message becomes

```ts
    super(`rbac: rule(s) ${ids.map((id) => `'${id}'`).join(', ')} may apply differently to each row of '${type}', which a type-level vote cannot express; check rows one by one, lists of it are refused (listSupport)${detail ? ` (${detail})` : ''}`);
```

`src/model/rows.ts` L17-18 become:

```ts
  // Failing closed beats an unbounded residual; lists of the type go through listPlan.
  if (scopes.size + below.size > MAX_UNDER_SCOPES) throw new Error(`rbac: ${scopes.size + below.size} assignment scopes exceed the ${MAX_UNDER_SCOPES} an under term may hold; list the type with .accessible()`);
```

`src/model/sets/extension.ts`: delete `usableSubjects` with its doc comment.

Delete `src/model/native.ts`, `src/model/rules/native.ts`, `src/model/rules/args.ts`, `src/model/rules/bind.ts`.

`src/contracts.ts`: delete L84-87 (the comment and the three constants), delete L1 `import { CORE_FILTER_OPS } from '@spinajs/authz';`, and remove `FilterOp, ` from the type import of L2.

- [ ] **Step 5: Compile**

Run: `cd packages/authz-rbac && npx tsc -p tsconfig.json --noEmit`
Expected: errors only in `test/` files (Step 6).

- [ ] **Step 6: Tests that used the removed path**

- `test/admin/rbac-admin-harness.ts`: L7 drops `rbacAssignmentExtension`; L55 becomes `const model = new RbacModel({ ...options, extensions: createRbacExtensions(options) });`.
- `test/sets/sets.test.ts`: drop `RBAC_ASSIGNMENT_OP` and `rbacAssignmentExtension` from the import, the `native` option of `model()` (its parameter and the spread), and the case `native:rbac.assignment names the usable sets among the subjects`.
- `test/model/model.test.ts`: drop `RBAC_RESIDUALS` from the import and replace L71 with `for (const op of m.capabilities.residuals) expect(CORE_FILTER_OPS).to.include(op);` (import `CORE_FILTER_OPS` from `@spinajs/authz`).
- `test/model/evaluate.test.ts`: delete the three cases at L790-835 that pass `rbacAssignmentExtension` (`with rbacAssignmentExtension the term is ...`, `rbacAssignmentExtension with types ...`, and the `ON_GLOBAL` case using it) and the import.
- `test/ladder/checks.test.ts`, `test/ladder/implies.test.ts`, `test/token/extension.test.ts`, `test/behaviour.model.test.ts`, `test/integration/stores.db.test.ts`, `test/rules/conformance.test.ts`: delete every `it` / `describe` / `runBehaviour` that builds `rbacAssignmentExtension` or asserts a `native:rbac.*` residual (`checks.test.ts` L71: drop the `native` option of its model helper and the cases passing it; `implies.test.ts` L193-199; `token/extension.test.ts` L343-370 and the `RBAC_ASSIGNMENT_OP` uses at L38 and L126 — L38 becomes `compiles: [...CORE_FILTER_OPS]`, and the helper at L126 drops its native branch; `behaviour.model.test.ts` L51 becomes `compiles: [...CORE_FILTER_OPS]`, and the `B06.rbac-native` run at L299 and the fixture at L149-157 go; `stores.db.test.ts` L282's `B06.l2-store-e2e` run and the helpers at L92 and L113 go; `rules/conformance.test.ts` drops the `lists` variant at L112), then the imports they leave unused.
- `test/behaviour.l1b.test.ts`, `test/rules/properties.test.ts`, `test/model/intersect.test.ts` build every case with `rbacAssignmentExtension(…, { rules: true })`: replace the extensions with `createRbacExtensions(…)` and run the file. A case that now fails only because a type-level vote throws `RuleRowsError` or answers `under` instead of a native term tested the removed list path: delete it (list behaviour with rules is refused by `listSupport` now, and L9's end-to-end suite covers lists). Delete a file whose cases all go.
- Any assertion on the old `MAX_UNDER_SCOPES` or `RuleRowsError` texts (`use rbacAssignmentExtension ...`) takes the new texts of Step 4.

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 7: API snapshot and RFC**

Create `docs/plans/authz-v3-rfc/RA8-1.md`:

```markdown
# RFC RA8-1: remove the native RBAC list ops from `@spinajs/authz-rbac`

Status: APPLIED by lane L8 (resource access plan, task 11).

## Change

`packages/authz-rbac/src/contracts.ts` no longer exports `RBAC_ASSIGNMENT_OP`, `RBAC_THRESHOLD_OP` and
`RBAC_RESIDUALS`. With them go `rbacAssignmentExtension` and the in-memory evaluators of
`native:rbac.assignment` and `native:rbac.threshold`.

## Why

They existed for the query-rewriting list path of `@spinajs/authz-orm`, whose SQL compilers lane L7
deleted (design 2026-10-14 §4.4, §9). Lists now use `RbacModel.listPlan` and the `rbac.assignment`
`PlanTermSql` compiler. Type-level check votes keep `under` terms.

## Migration

3.0 is unreleased; no shim. An app that passed `rbacAssignmentExtension` drops it and lists with
`.accessible()`.
```

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --update && node scripts/api-snapshot.mjs --check`
Expected: the update rewrites the `authz-rbac` entry of `scripts/api-snapshot.json` without the three constants; the check passes.

Run: `cd packages/authz-testing && npm test`
Expected: `0 failing` (the kit names the ops as strings and imports none of them).

- [ ] **Step 8: Commit**

```bash
git add -A packages/authz-rbac scripts/api-snapshot.json docs/plans/authz-v3-rfc/RA8-1.md
git commit -m "refactor(authz-rbac): remove the native type-level list path (RFC RA8-1)"
```

---

### Task 12: Lane verification

**Files:** none (fix-ups only).

- [ ] **Step 1: Package**

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing` (Postgres suites skip themselves without the server).

- [ ] **Step 2: Lint the new files**

Run: `cd packages/authz-rbac && npx eslint -c .eslintrc.cjs --ext .ts src/model/deny.ts src/model/scope.ts src/model/sets src/model/list src/model/rules src/model/evaluate.ts src/plan src/admin/list-guard.ts src/admin/guard.ts src/host/audience.ts`
Expected: no errors.

- [ ] **Step 3: Dependants**

Run: `cd packages/authz-testing && npm test` — Expected: `0 failing`.
Run: `cd packages/authz-http && npm test` — Expected: `0 failing`.

- [ ] **Step 4: API snapshot**

Run (repo root): `npm run build && node scripts/api-snapshot.mjs --check`
Expected: passes (Task 11 updated the snapshot with RFC RA8-1).

- [ ] **Step 5: Nothing of the old list path is left**

Run (repo root): `grep -rnE "RBAC_ASSIGNMENT_OP|RBAC_THRESHOLD_OP|RBAC_RESIDUALS|rbacAssignmentExtension|RbacAssignmentFilter|RbacListEvaluator|nativeListVote|NativeNeedsV2|listsRules|scopedResidual|native:rbac" packages/*/src packages/*/test --include=*.ts`
Expected: only `packages/authz-testing/src/behaviour/world.ts` (the kit's own string list of RBAC ops for its fake adapters; L5/L9 own it).

- [ ] **Step 6: Commit any fix-ups**

```bash
git add -A packages/authz-rbac
git commit -m "chore(authz-rbac): lane L8 verification fixes"
```

---

### Task 13: `authz.admin.guard.keepHolders` (teams lanes L14/L15)

Teams design §5: `keepHolders: [{ role: 'team.owner', scopeType: 'team' }]` keeps one owner per team. `DefaultAdminGuard` refuses (`last_holder`) a command that takes a holder of `role` from a scope of `scopeType` when no live holder would be left there: a principal row (not a share link, not a wildcard), or a set row whose set still has a live account member, read through `MembershipStore`.

- **Which scopes are checked:** only the scopes the command takes a path from. A removed row holding `role` (itself, through `extends` or as a higher role of its ladder) at a `scopeType` scope counts. So does a removed row that makes its subject a member of a set (or of a set above it, `MembershipStore.setsOf`) holding `role` at such a scope. A team that never had an owner is not refused for unrelated removals.
- **Batches:** the guard runs before each command, inside the batch transaction (`packages/authz/src/admin/admin.ts`, phase B), so it sees the batch's earlier writes but not its later ones. A transfer must grant the new holder first and revoke after, which is the order of `TeamService.transferOwnership` (teams design §7). Revoke-then-grant is refused at the revoke. A check at the end of the batch would need a new hook on the frozen `AdminGuard` contract (L0, RFC).
- **SYSTEM:** `DefaultAuthzAdmin.run` calls the guard only when `actor !== SYSTEM`, so SYSTEM skips this rule like every other guard rule.
- **Role validation answer (teams design §4):** a `subjectSet: true` role may be a ladder role. `validateRole` and `compileRoles` (`src/model/roles.ts`) and the ladder checks (`src/model/ladder/ladders.ts`) do not refuse it, and Task 2's `refuseDenyMixing` refuses `subjectSet` and ladders only for deny roles. The last test case compiles the teams roles to pin this.

**Files:**
- Modify: `packages/authz-rbac/src/admin/guard.ts`, `src/stores/schema.ts`, `docs/authz/README.md`
- Test: `packages/authz-rbac/test/admin/guard-keep-holders.test.ts`

**Interfaces:**
- Consumes: `MembershipStore` (`membersOf`, `setsOf`), `computeClosures`, `readMaxSetDepth` (L6 `src/membership/closure.ts`), `membershipEdges` (L6 `src/admin/membership.ts`), `subjectKeyOf` (L6), `parseSetKey` (Task 4), `removals` as Task 5 left it, `roleClosure`, `optionalStore`, `LINK_TYPE` (`src/admin/common.ts`).
- Produces: `KeepHolder { role: string; scopeType: string }`; `AdminGuardConfig.keepHolders: readonly KeepHolder[]` (`guardSwitches` reads `authz.admin.guard.keepHolders`, absent = `[]`, a malformed value is `AuthzConfigError` `<reader>: authz.admin.guard.keepHolders must be an array of { role, scopeType }`); `AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA` (`$configurationModule: 'authz.admin.guard'`, validates `keepHolders` only); refusal `last_holder` with message `<scope> would keep no holder of "<role>" (authz.admin.guard.keepHolders)`, field `id` when the command has one; a `keepHolders` role no RoleStore defines is an `AuthzConfigError` at the first guarded removal.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-rbac/test/admin/guard-keep-holders.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError, PermissionRegistryImpl, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { bootConfiguration, fakeModelInitContext, userPrincipal, violationPaths } from '@spinajs/authz-testing';

import { AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA, AdminMembershipStore, MembershipStore, MemoryAssignmentStore, MemoryMembershipStore, MemoryRoleStore, RbacModel, guardSwitches } from '../../src/index.js';
import type { Assignment, AssignmentSubject, LadderDef, RoleDef } from '../../src/index.js';
import { START, StaticRoleStore, failure, installHost, instance, ok, rbacDomain, rejection, resetHost, uninstallHost } from './support.js';
import type { RbacDomain } from './support.js';

const expect = chai.expect;

const role = (name: string, extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], grants: [], assignable: true, source: 'test', ...extra });
// Teams design §4: team.member is a subject set and the lowest role of the team ladder.
const TEAM_ROLES: RoleDef[] = [
  role('team.member', { subjectSet: true, scopeTypes: ['team'], ladder: 'team', grants: [{ permission: 'team:read' }] }),
  role('team.admin', { scopeTypes: ['team'], ladder: 'team', extends: ['team.member'] }),
  role('team.owner', { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'] }),
  role('group.member', { subjectSet: true, scopeTypes: ['group'] }),
];
const TEAM_LADDERS: LadderDef[] = [{ name: 'team', roles: ['team.member', 'team.admin', 'team.owner'] }];
const KEEP_OWNERS = [{ role: 'team.owner', scopeType: 'team' }];

const alice = userPrincipal('alice');
const user = (id: string): PrincipalRef => ({ type: 'user', id });
const ANN = user('ann');
const BOB = user('bob');
const DAVE = user('dave');
const team = (id: string): ResourceRef => ({ type: 'team', id });
const group = (id: string): ResourceRef => ({ type: 'group', id });
const T1 = team('t1');
const groupSet = (id: string): AssignmentSubject => ({ set: { role: 'group.member', scope: group(id) } });
const OWNER_ANN: Assignment = { id: 'own-ann', subject: ANN, role: 'team.owner', scope: T1, tags: [], expiresAt: null, source: 'test' };

const revoke = (id: string): AuthzCommand => ({ kind: 'assignment.revoke', id });
const grantOwner = (subject: AssignmentSubject): AuthzCommand => ({ kind: 'assignment.grant', subject, role: 'team.owner', scope: T1 });
const join = (u: PrincipalRef, g: string): AuthzCommand => ({ kind: 'set.addMember', set: { role: 'group.member', scope: group(g) }, member: u });
const leave = (u: PrincipalRef, g: string): AuthzCommand => ({ kind: 'set.removeMember', set: { role: 'group.member', scope: group(g) }, member: u });
const nest = (inner: string, outer: string): AuthzCommand => ({ kind: 'assignment.grant', subject: groupSet(inner), role: 'group.member', scope: group(outer) });

describe('authz.admin.guard.keepHolders (teams design §5)', () => {
  const base = { preventSelfLockout: false, preventLastPrivilegedRemoval: false };

  it('guardSwitches reads keepHolders: absent is none, a malformed value is refused', () => {
    expect(guardSwitches(base, 'here').keepHolders).to.deep.equal([]);
    expect(guardSwitches({ ...base, keepHolders: KEEP_OWNERS }, 'here').keepHolders).to.deep.equal(KEEP_OWNERS);
    for (const bad of [{ role: 'team.owner' }, [{ role: 'team.owner' }], [{ role: '', scopeType: 'team' }], [{ role: 'team.owner', scopeType: 'team', at: 'x' }]]) {
      expect(() => guardSwitches({ ...base, keepHolders: bad }, 'here'), JSON.stringify(bad)).to.throw(AuthzConfigError, /^here: authz\.admin\.guard\.keepHolders must be an array of \{ role, scopeType \}/);
    }
  });

  it('the authz-rbac guard schema checks keepHolders', async () => {
    const boot = (keepHolders: unknown) => bootConfiguration({ authz: { admin: { guard: { privilegedPermission: 'users:update', keepHolders } } } }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA]);
    const booted = await boot(KEEP_OWNERS);
    expect(booted.configuration.get(['authz', 'admin', 'guard', 'keepHolders'])).to.deep.equal(KEEP_OWNERS);
    await booted.child.dispose();
    for (const bad of [{ role: 'team.owner' }, [{ role: 'team.owner' }], [{ role: 'team.owner', scopeType: 'team', at: 'x' }]]) {
      expect((await violationPaths(boot(bad))).some((p) => p.startsWith('authz.admin.guard.keepHolders')), JSON.stringify(bad)).to.equal(true);
    }
  });

  it('compiles the teams roles: a subjectSet role may be a ladder role (teams design §4)', async () => {
    const registry = new PermissionRegistryImpl();
    registry.register([{ name: 'team:read', types: ['team'] }], 'test');
    registry.freeze();
    const model = new RbacModel({ roles: new MemoryRoleStore(TEAM_ROLES, TEAM_LADDERS), assignments: new MemoryAssignmentStore(), log: { warn: () => undefined } });
    await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
    expect(model.grantIndex().granted('team:read')).to.equal(true);
  });

  describe('in an admin batch', function () {
    this.timeout(20000);
    let d: RbacDomain;

    before(async () => {
      await installHost();
    });
    after(async () => {
      await uninstallHost();
    });
    beforeEach(async () => {
      await resetHost();
    });

    // Only keepHolders on: the other guard rules have their own suites.
    async function domain(keepHolders: unknown = KEEP_OWNERS): Promise<RbacDomain> {
      const m = new MemoryMembershipStore();
      d = await rbacDomain('test', {
        roleStores: [new StaticRoleStore('teams', TEAM_ROLES, TEAM_LADDERS)],
        assignments: [OWNER_ANN],
        admin: { backend: 'TestBackend', guard: { service: 'DefaultAdminGuard', protectSystemRole: true, preventEscalation: false, preventSelfLockout: false, preventLastPrivilegedRemoval: false, keepHolders } },
        permissions: { 'authz:assignments.manage': { types: ['org', 'project', 'file', 'group', 'team'] } },
        register: (c) => {
          c.register(instance(m)).as(MembershipStore);
          c.register(instance(m)).as(AdminMembershipStore);
        },
      });
      return d;
    }

    const owners = async () => (await d.assignments.find({ scope: T1, role: 'team.owner', at: START })).items.filter((a) => !('set' in a.subject)).map((a) => (a.subject as PrincipalRef).id).sort();

    it('refuses to revoke, demote or revokeWhere the last owner of a team (last_holder)', async () => {
      await domain();
      expect(failure(await d.admin.execute(alice, [revoke('own-ann')]))).to.deep.equal({ at: 0, code: 'last_holder', field: 'id' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: ANN, role: 'team.admin', scope: T1, replaceLadder: true }]))).to.include({ at: 0, code: 'last_holder' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: T1, subject: ANN }]))).to.include({ at: 0, code: 'last_holder' });
      expect(await owners()).to.deep.equal(['ann']);
    });

    it('with a second owner the revoke goes through', async () => {
      await domain();
      ok(await d.admin.execute(alice, [grantOwner(BOB)]));
      ok(await d.admin.execute(alice, [revoke('own-ann')]));
      expect(await owners()).to.deep.equal(['bob']);
    });

    it('an owner held only through a group holds while the group keeps a live member', async () => {
      await domain();
      ok(await d.admin.execute(alice, [join(DAVE, 'g1'), grantOwner(groupSet('g1'))]));
      ok(await d.admin.execute(alice, [revoke('own-ann')]));
      expect(failure(await d.admin.execute(alice, [leave(DAVE, 'g1')]))).to.include({ at: 0, code: 'last_holder' });
      // A member through a nested group keeps g1 live, so dave may leave.
      ok(await d.admin.execute(alice, [join(BOB, 'g2'), nest('g2', 'g1')]));
      ok(await d.admin.execute(alice, [leave(DAVE, 'g1')]));
      expect(failure(await d.admin.execute(alice, [leave(BOB, 'g2')]))).to.include({ at: 0, code: 'last_holder' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: group('g1'), subject: groupSet('g2'), role: 'group.member' }]))).to.include({ at: 0, code: 'last_holder' });
      expect(failure(await d.admin.execute(alice, [{ kind: 'assignment.revokeWhere', scope: T1, subject: groupSet('g1'), role: 'team.owner' }]))).to.include({ at: 0, code: 'last_holder' });
    });

    it('a transfer in one batch goes through when the grant comes first', async () => {
      await domain();
      ok(await d.admin.execute(alice, [grantOwner(BOB), revoke('own-ann')]));
      expect(await owners()).to.deep.equal(['bob']);
      const [bobRow] = (await d.assignments.find({ scope: T1, subject: BOB, at: START })).items;
      expect(failure(await d.admin.execute(alice, [revoke(bobRow.id), grantOwner(ANN)]))).to.deep.equal({ at: 0, code: 'last_holder', field: 'id' });
      expect(await owners()).to.deep.equal(['bob']);
    });

    it('SYSTEM skips it, like every guard rule', async () => {
      await domain();
      ok(await d.admin.execute(SYSTEM, [revoke('own-ann')]));
      expect(await owners()).to.deep.equal([]);
    });

    it('does not check scopes the command takes no holder path from', async () => {
      await domain();
      ok(await d.admin.execute(alice, [{ kind: 'assignment.grant', subject: BOB, role: 'team.member', scope: team('t2') }, join(BOB, 'g1')]));
      const rows = (await d.assignments.find({ subject: BOB, at: START })).items;
      ok(await d.admin.execute(alice, rows.map((r) => revoke(r.id))));
    });

    it('a keepHolders role no RoleStore defines is a configuration error', async () => {
      await domain([{ role: 'team.boss', scopeType: 'team' }]);
      const err = await rejection(d.admin.execute(alice, [revoke('own-ann')]));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.match(/authz\.admin\.guard\.keepHolders names role "team\.boss", which no RoleStore defines/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/guard-keep-holders.test.ts`
Expected: FAIL: TSError `Module '"../../src/index.js"' has no exported member 'AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA'`.

- [ ] **Step 3: The schema**

In `packages/authz-rbac/src/stores/schema.ts`, append after `registerConfigurationSchemaAtImport(AUTHZ_RBAC_CONFIGURATION_SCHEMA);`:

```ts
// DefaultAdminGuard lives here, so this package validates the guard key only it reads. The core schema leaves
// authz.admin.guard open, and authz-rbac's default config (src/config/admin.ts) always sets that section.
export const AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-rbac-guard.configuration.schema.json',
  $configurationModule: 'authz.admin.guard',
  description: 'DefaultAdminGuard rules of authz-rbac (authz.admin.guard.keepHolders)',
  type: 'object',
  properties: {
    keepHolders: { type: 'array', items: closed({ role: roleName, scopeType: name }, ['role', 'scopeType']) },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_RBAC_GUARD_CONFIGURATION_SCHEMA);
```

(`src/stores/index.ts` already re-exports `./schema.js`.)

- [ ] **Step 4: Config and helpers in `src/admin/guard.ts`**

1. Imports: add `import { MembershipStore } from '../contracts.js';`, `import { computeClosures, readMaxSetDepth } from '../membership/closure.js';`, `import { parseSetKey } from '../model/sets/keys.js';`, `import { subjectKeyOf } from '../stores/columns.js';`, `import { membershipEdges } from './membership.js';`, and add `LINK_TYPE, optionalStore, roleClosure` to the `./common.js` import (alphabetical with the others).

2. Add before `AdminGuardConfig`:

```ts
/** authz.admin.guard.keepHolders entry: every scope of `scopeType` keeps a live holder of `role`. */
export interface KeepHolder {
  readonly role: string;
  readonly scopeType: string;
}
```

and to `AdminGuardConfig`, after `preventLastPrivilegedRemoval`:

```ts
  readonly keepHolders: readonly KeepHolder[];
```

3. In `guardSwitches`, the return becomes:

```ts
  return { ...cfg, privilegedPermission: isPermission(raw.privilegedPermission) ? raw.privilegedPermission : undefined, keepHolders: readKeepHolders(raw.keepHolders, reader) };
```

and add after `guardSwitches`:

```ts
function readKeepHolders(v: unknown, reader: string): readonly KeepHolder[] {
  if (v === undefined || v === null) return Object.freeze([]);
  const entry = (e: unknown): e is KeepHolder => isPlainObject(e) && typeof e.role === 'string' && e.role !== '' && typeof e.scopeType === 'string' && e.scopeType !== '' && Object.keys(e).every((k) => k === 'role' || k === 'scopeType');
  if (!Array.isArray(v) || !v.every(entry)) throw new AuthzConfigError(`${reader}: authz.admin.guard.keepHolders must be an array of { role, scopeType }, got ${JSON.stringify(v)}`);
  return Object.freeze(v.map((e) => Object.freeze({ role: e.role, scopeType: e.scopeType })));
}
```

4. `interface Call` gains, after `ranks`:

```ts
  /** authz.rbac.maxSetDepth, for recomputing set memberships without a command's rows. */
  readonly maxSetDepth: number;
```

and in `check`, the `call` line becomes:

```ts
    const call: Call = { actor, ctx, cfg, roles, sets, ranks: new Map(), maxSetDepth: readMaxSetDepth(configuration.get(['authz', 'rbac', 'maxSetDepth'])) };
```

5. After `type SetRow = …` add:

```ts
type SetOf = Extract<AssignmentSubject, { set: unknown }>;
```

and after `sameSubject`:

```ts
/** `role` gives `wanted`: itself, through extends, or as a higher role of its ladder. */
const givesRole = (roles: RoleIndex, role: string, wanted: string): boolean => roleClosure(roles, role, 'none').defs.some((d) => d.name === wanted);
/** A principal subject that is an account: not a share link, not a wildcard. */
const isAccount = (s: AssignmentSubject): boolean => !isSetSubject(s) && !isLinkSubject(s) && s.id !== '*';
const isAccountKey = (key: string): boolean => parseSetKey(key) === undefined && !key.startsWith(`${LINK_TYPE}:`) && !key.endsWith(':*');
```

- [ ] **Step 5: The rule**

In `removals` (as Task 5 left it), between the `const removed = [ … ];` statement and `if (cfg.privilegedPermission === undefined) return;`, insert:

```ts
    if (cfg.keepHolders.length > 0 && removed.length > 0) await this.keepHolders(call, c, removed);
```

Add before `private async facts(ctx: AdminContext)`:

```ts
  // ---- keep holders ----

  /** authz.admin.guard.keepHolders (teams design §5): every scope the command takes a holder path from keeps a holder. */
  private async keepHolders(call: Call, c: AuthzCommand, removed: readonly Assignment[]): Promise<void> {
    const gone = new Set(removed.map((a) => a.id));
    for (const rule of call.cfg.keepHolders) {
      if (!call.roles.roles.has(rule.role)) throw new AuthzConfigError(`Authz domain ${quote(call.ctx.domain)}: authz.admin.guard.keepHolders names role ${quote(rule.role)}, which no RoleStore defines`);
      for (const scope of await this.heldScopes(call, rule, removed)) {
        if (!(await this.keepsHolder(call, rule.role, scope, gone))) throw refuse('last_holder', `${quote(scope)} would keep no holder of ${quote(rule.role)} (authz.admin.guard.keepHolders)`, idField(c));
      }
    }
  }

  /** Scopes of `rule.scopeType` where a removed row gives `rule.role`, or where a set it leads into (or one above that) holds it. */
  private async heldScopes(call: Call, rule: KeepHolder, removed: readonly Assignment[]): Promise<ResourceRef[]> {
    const store = await assignmentStore(call.ctx);
    const out = new Map<string, ResourceRef>();
    const add = (a: Assignment) => {
      if (a.scope.type === rule.scopeType && givesRole(call.roles, a.role, rule.role)) out.set(resourceKey(a.scope), a.scope);
    };
    const sets = new Map<string, SetOf>();
    for (const a of removed) {
      add(a);
      for (const role of call.sets(a.role)) {
        const set: SetOf = { set: { role, scope: a.scope } };
        sets.set(subjectKeyOf(set), set);
      }
    }
    for (const set of await this.setsAbove(call, sets)) {
      for (const a of (await store.find({ subject: set, at: call.ctx.now })).items) add(a);
    }
    return [...out.values()];
  }

  /** The sets and every set they belong to (MembershipStore.setsOf); without a MembershipStore sets are one level deep. */
  private async setsAbove(call: Call, sets: ReadonlyMap<string, SetOf>): Promise<SetOf[]> {
    const out = new Map(sets);
    const memberships = sets.size > 0 ? await optionalStore(call.ctx, MembershipStore) : undefined;
    if (memberships) {
      for (const { setKey } of await memberships.setsOf([...sets.keys()], call.ctx.now)) {
        const set = parseSetKey(setKey);
        if (set) out.set(setKey, set);
      }
    }
    return [...out.values()];
  }

  /** Without the rows in `gone`, a live row at `scope` gives `role` to an account, or to a set with a live account member. */
  private async keepsHolder(call: Call, role: string, scope: ResourceRef, gone: ReadonlySet<string>): Promise<boolean> {
    const store = await assignmentStore(call.ctx);
    const rows = (await store.find({ scope, at: call.ctx.now })).items.filter((a) => !gone.has(a.id) && honoured(call.roles, a) && givesRole(call.roles, a.role, role));
    for (const a of rows) {
      if (isSetSubject(a.subject) ? await this.keepsMember(call, a.subject, gone) : isAccount(a.subject)) return true;
    }
    return false;
  }

  private async keepsMember(call: Call, set: SetOf, gone: ReadonlySet<string>): Promise<boolean> {
    const memberships = await optionalStore(call.ctx, MembershipStore);
    if (!memberships) return (await this.setMembers(call, set.set)).some((m) => !gone.has(m.id) && isAccount(m.subject));
    const setKey = subjectKeyOf(set);
    const accounts = (await memberships.membersOf(setKey, call.ctx.now)).filter(isAccountKey);
    if (accounts.length === 0) return false;
    // The closure table still holds this command's rows (the handler refreshes it after the guard): walk again without them.
    const assignments = await assignmentStore(call.ctx);
    const edges = async (keys: readonly string[]) => membershipEdges(call.roles, (await assignments.forSubjectKeys(keys, call.ctx.now)).filter((a) => !gone.has(a.id)));
    const after = await computeClosures(accounts, edges, call.maxSetDepth);
    return accounts.some((k) => (after.get(k) ?? []).some((r) => r.setKey === setKey));
  }
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json test/admin/guard-keep-holders.test.ts`
Expected: PASS, `10 passing`.

Run: `cd packages/authz-rbac && npx ts-mocha -p tsconfig.json 'test/admin/guard*.test.ts'`
Expected: `0 failing` (`guard-config.test.ts` uses `deep.include`, so the new `keepHolders: []` key does not disturb it).

Run: `cd packages/authz-rbac && npm test`
Expected: `0 failing`.

- [ ] **Step 7: Document it**

In `docs/authz/README.md`, in the guard list (after the `last_holder` bullet for the privileged permission), add:

```md
- removing the last holder of a role at a scope type listed in `keepHolders` (`last_holder`): a revoke,
  a ladder demotion, or the last live member leaving a group or team set that holds the role. The guard
  runs before each command, so a transfer grants the new holder first and revokes the old one after,
  in one batch;
```

and in the config block after `preventLastPrivilegedRemoval: true,`:

```ts
      keepHolders: [{ role: 'team.owner', scopeType: 'team' }],   // default: none
```

- [ ] **Step 8: Commit**

```bash
git add packages/authz-rbac/src/admin/guard.ts packages/authz-rbac/src/stores/schema.ts packages/authz-rbac/test/admin/guard-keep-holders.test.ts docs/authz/README.md
git commit -m "feat(authz-rbac): authz.admin.guard.keepHolders keeps a live holder of a role per scope (teams design §5)"
```

---

## Contract issues found

Resolved in `00-overview.md` and applied above: `MembershipStore.setsOf` returns `{ setKey, expiresAt? }` (decision 5); relation grants held at a scope are `rbac.assignment` role entries with `relation`, compiled with `SqlRowContext.relation` (overview decision 15, lane decision 7); `ModelListPlan.all` carries `deny` (decision 8); `relation.owner` / `relation.self` replace `relation.column`; L6 tags set changes `subject:<setKey>`, which `RbacChangeAudience` expands through `membersOf`; the native list path and its contract constants go in Task 11 (RFC RA8-1).

Open:

1. **RBAC change pushes carry no `objects`** (overview decision 16, accepted): rbac cannot read `authz_resource_ancestor`, so clients refetch everything on an RBAC change.
