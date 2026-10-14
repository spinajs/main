# Lane L3: authz-orm core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` first: its Global Constraints, frozen contracts and names table bind every step here.

**Goal:** Replace the query-rewriting `@spinajs/authz-orm` with a small package: `@AccessResource` / `@Parent` / `@Owner` / `@Self` declarations, an `OrmResourceAdapter` that checks single objects through the `authz_resource_ancestor` closure table, a write-only query middleware that keeps that table right (and cleans up authz data of deleted rows), `reparent`, two CLI commands and the runtime guard of design §8.

**Architecture:** The registry (`src/registry.ts`) holds what the decorators declare. The adapter reads `authz_resource_ancestor` (one indexed read per batch) and loads rows as `SYSTEM`. `AncestorMiddleware` uses lane L1's `afterQueryExecution` / `transactional` hooks: it recomputes the closure of every node an insert, a `@Parent` update or a delete touches (pure algorithm in `src/ancestors/closure.ts`, IO in `src/ancestors/store.ts`), and on delete runs `forgetScopesInTx` (L2) in the statement's transaction and publishes `AuthzChange` after the commit. `AccessGuardMiddleware` only reads builders: a select of an `@AccessResource` model without `.accessible()` (L4), `.unscoped()` (L4) or `SYSTEM` is an error in env `test` and a warning in `development`.

**Tech Stack:** TypeScript (node16 ESM + CJS), `@spinajs/orm` (+ sqlite, postgres drivers in tests), `@spinajs/authz`, `@spinajs/cli`, mocha + chai + sinon.

**Depends on:** G0 (L0 contracts merged), L7 merged (it deletes `authz-rbac/src/orm/**`, the last importer of `@spinajs/authz-orm/native`; Task 1 removes that subpath). Task 5 also needs L1 (ORM hooks: `afterQueryExecution`, `transactional`, `driver.afterCommit`) and L2 Task 6 (`forgetScopesInTx`) merged.

**Blocks:** L4 (needs Task 1: registry, `marker.ts`, `host.ts`), L5 (starts when Tasks 1–3 are merged; until L5 lands, `authz-queue`, `configuration-http` and the `authz-testing` canvas-c6 tests do not compile against the new API), L9.

## Global Constraints

- All code, comments, docs, identifiers and commit messages in English. Comments only where a reader would ask "why?".
- Versions: `@spinajs/authz*` `3.0.0-alpha.0`, other `@spinajs/*` `2.0.549`.
- Tests: mocha + chai `expect`, `test/<area>/<name>.test.ts`. One file: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/<path>.test.ts`. Package: `cd packages/authz-orm && npm test`.
- Postgres tests run when `TestDb.postgresReachable()` (port `ORM_TEST_POSTGRES_PORT`, default 15432) and skip otherwise, as `test/audit.test.ts` does.
- A change to `packages/authz-orm/src/api.ts` needs `npm run build` (root), `node scripts/api-snapshot.mjs --update` and an RFC in the same commit (`docs/plans/authz-v3-rfc/RA3-1.md`, Task 1).
- 3.0 is unreleased: no compatibility shims for the removed API.
- Commit after every task with a conventional message.

## Files

| File | Responsibility | Task |
|---|---|---|
| `packages/authz-orm/src/api.ts` | frozen signatures (stubs), snapshotted | 1 |
| `packages/authz-orm/src/registry.ts` | `@AccessResource` registrations, `entryOf`, `classesOf`, … | 1 |
| `packages/authz-orm/src/decorators.ts` | `AccessResource`, `Parent`, `Owner`, `Self`, `registerAccessResource` | 1 |
| `packages/authz-orm/src/marker.ts` | access marks on builders (`.accessible()` / `.unscoped()`; L4 sets, Task 8 reads) | 1 |
| `packages/authz-orm/src/host.ts` | `authz.orm.domain`, domain container/config, audit, log | 1 |
| `packages/authz-orm/src/schema.ts` | `authz.orm.*` config schema | 1 |
| `packages/authz-orm/src/index.ts` | package root | 1, 3, 5, 6, 8 |
| `packages/authz-orm/src/ancestors/table.ts` | table name, row type, chunking | 2 |
| `packages/authz-orm/src/ancestors/AuthzResourceAncestor_2026_10_14_00_00_00.ts` | migration | 2 |
| `packages/authz-orm/src/ancestors/index.ts` | barrel | 2, 4, 6 |
| `packages/authz-orm/src/ids.ts` | primary keys, id text, id lookup values | 3 |
| `packages/authz-orm/src/rows.ts` | rows by ref, as SYSTEM | 3 |
| `packages/authz-orm/src/ancestors/read.ts` | `readAncestors`, `whereRefs` | 3 |
| `packages/authz-orm/src/relations.ts` | `owner` / `self` resolvers | 3 |
| `packages/authz-orm/src/adapter.ts` | `OrmResourceAdapter` | 3 |
| `packages/authz-orm/src/ancestors/closure.ts` | pure closure computation | 4 |
| `packages/authz-orm/src/ancestors/store.ts` | descendants, parents, replace rows | 4 |
| `packages/authz-orm/src/ancestors/rebuild.ts` | `rebuildFrom`, `rebuildNodes`, `removeNodes` | 4 |
| `packages/authz-orm/src/ancestors/commit.ts` | `afterCommit` | 5 |
| `packages/authz-orm/src/ancestors/targets.ts` | ids an update/delete reaches, ids an insert wrote | 5 |
| `packages/authz-orm/src/ancestors/cleanup.ts` | delete clean-up steps 3–4 | 5 |
| `packages/authz-orm/src/ancestors/middleware.ts` | `AncestorMiddleware` | 5 |
| `packages/authz-orm/src/ancestors/reparent.ts` | `reparent` | 6 |
| `packages/authz-orm/src/ancestors/full.ts` | whole-type closure for the CLI | 7 |
| `packages/authz-orm/src/cli/base.ts`, `src/cli/commands/ancestors-verify.ts`, `src/cli/commands/ancestors-rebuild.ts` | CLI | 7 |
| `packages/authz-orm/src/config/authz-orm-cli.ts` | registers `cli/commands` with `@spinajs/cli` | 7 |
| `packages/authz-orm/src/guard/env.ts`, `src/guard/middleware.ts` | runtime guard | 8 |
| `packages/authz-orm/src/contributor.ts` | domain-boot check: `@Parent` models on the stores connection | 9 |

Task numbering note: the coordinator's task 4 ("ancestor maintenance") is split into Task 4 (closure engine, no L1 needed) and Task 5 (middleware, needs L1); later tasks shift by one, and Task 9 (domain-boot connection check, overview decision 21) is added. Tasks 1–3 are unchanged.

---

### Task 1: Gut the package; registry, decorators, frozen API

**Files:**
- Delete (src): `packages/authz-orm/src/adapter.ts`, `columns.ts`, `contributor.ts`, `decorators.ts` (rewritten below), `exists.ts`, `fields.ts`, `implementation.ts`, `insert.ts`, `jit.ts`, `middleware.ts`, `native.ts`, `principal.ts`, `registry.ts` (rewritten below), `relations.ts`, `rows.ts`, `shield.ts`, `update.ts`, the whole `src/compile/` directory (`compiler.ts`, `dialect.ts`, `native.ts`, `patterns.ts`, `sql.ts`, `sync.ts`).
- Keep unchanged: `src/audit/**`, `src/scope-attributes/**`, `src/once.ts`.
- Delete (test): `test/adapter.test.ts`, `test/api.test.ts` (rewritten below), `test/b06.property.test.ts`, `test/behaviour.test.ts`, `test/builders.test.ts`, `test/compile.property.test.ts`, `test/compile.test.ts`, `test/config.test.ts`, `test/conformance.test.ts`, `test/fields.test.ts`, `test/implementation.test.ts`, `test/jit.test.ts`, `test/late-registration.test.ts`, `test/middleware.test.ts`, `test/native-exports.test.ts`, `test/native.test.ts`, `test/registry.test.ts` (rewritten below), `test/relations.test.ts`, `test/unchecked-scope.test.ts`, `test/ported/active-role.test.ts`, `test/ported/clone-rbac.test.ts`, `test/ported/create-ownership-idor.test.ts`, `test/ported/harness.ts`, `test/ported/m2m-rbac.test.ts`, `test/ported/orm-permission-policy.test.ts`, `test/ported/orm-permission-registry.test.ts`, `test/ported/orm-rbac.test.ts`, `test/ported/ownership.test.ts`, `test/ported/write-ownership-idor.test.ts`, `test/support/b06.ts`, `test/support/orm-harness.ts`, `test/support/residual.ts`.
- Keep (test): `test/.gitkeep`, `test/audit.test.ts`, `test/scope-attributes/db-store.test.ts`, `test/support/db.ts` (it imports `unregisterResource` from `../../src/registry.js`, which the new registry keeps), `test/support/system.ts`.
- Create: `src/api.ts` (replace), `src/registry.ts`, `src/decorators.ts`, `src/marker.ts`, `src/host.ts`; Modify: `src/schema.ts`, `src/index.ts`, `package.json`, `tsconfig.json`, `tsconfig.mjs.json`, `tsconfig.cjs.json`, `README.md`.
- Create: `docs/plans/authz-v3-rfc/RA3-1.md`; regenerate `packages/authz-orm/etc/authz-orm.api.md`.
- Test: `test/api.test.ts`, `test/registry.test.ts`, `test/host.test.ts`.

**Interfaces:**
- Produces (names table, owned here; L4, L5, L9 use them):
  - `entryOf(model: unknown): ResourceEntry | undefined` with `ResourceEntry = { registered; type; parents: readonly { property; column; type; nullable }[]; owner?: { property; column; typeColumn? }; self?: { column }; idColumn }` (a superset of the names-table shape: `registered` and `parents[].nullable` are extra).
  - `classesOf(type): ModelClass[]`, `registeredTypes(): string[]`, `registeredClasses()`, `typesAbove(type): string[]`, `nameOf(c)`, `unregisterResource(model)`, `resetRegistry()`.
  - Decorators `AccessResource(type)`, `Parent(type, opts?: { nullable?: boolean })`, `Owner(opts?: { typeColumn?: string })`, `Self()`; `registerAccessResource(model, type, opts?: { parents?: { column; type }[]; owner?: string | { column; typeColumn? }; self?: string })`; `reparent(model, ids, newParentId, column?)` (stub here, Task 6 implements).
  - `src/marker.ts`: `AccessMarks { accessible?: Permission; env?: Readonly<Record<string, unknown>>; unscoped?: string; withAccess?: readonly Permission[] }`, `marksOf(builder)`, `setMarks(builder, marks)`. L4 sets marks; Task 8 reads them.
  - `src/host.ts`: `ormDomain()`, `domainContainer(domain)`, `domainConfig(domain)`, `recordAudit(domain, record)`, `auditUnscoped(domain, principal, reason, type)`, `storageUnscoped()`, `ormLog()`.

- [ ] **Step 1: Delete the obsolete sources and tests**

```bash
cd packages/authz-orm
git rm -q src/adapter.ts src/columns.ts src/contributor.ts src/decorators.ts src/exists.ts src/fields.ts src/implementation.ts src/insert.ts src/jit.ts src/middleware.ts src/native.ts src/principal.ts src/registry.ts src/relations.ts src/rows.ts src/shield.ts src/update.ts
git rm -q -r src/compile
git rm -q test/adapter.test.ts test/api.test.ts test/b06.property.test.ts test/behaviour.test.ts test/builders.test.ts test/compile.property.test.ts test/compile.test.ts test/config.test.ts test/conformance.test.ts test/fields.test.ts test/implementation.test.ts test/jit.test.ts test/late-registration.test.ts test/middleware.test.ts test/native-exports.test.ts test/native.test.ts test/registry.test.ts test/relations.test.ts test/unchecked-scope.test.ts
git rm -q -r test/ported
git rm -q test/support/b06.ts test/support/orm-harness.ts test/support/residual.ts
ls src test test/support
```

Expected: `src` lists `api.ts audit index.ts once.ts schema.ts scope-attributes`; `test` lists `audit.test.ts scope-attributes support`; `test/support` lists `db.ts system.ts`.

- [ ] **Step 2: Write the failing tests**

Create `packages/authz-orm/test/registry.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { ModelBase, Primary } from '@spinajs/orm';

import { AccessResource, Owner, Parent, Self, registerAccessResource } from '../src/index.js';
import { classesOf, entryOf, registeredTypes, resetRegistry, typesAbove, unregisterResource } from '../src/registry.js';

const expect = chai.expect;

/** A class with an `id` primary key, as the ORM's @Primary declares it. */
function model(name: string, base: typeof ModelBase = ModelBase): typeof ModelBase {
  const cls = { [name]: class extends base {} }[name] as typeof ModelBase;
  Primary()(cls.prototype, 'id');
  return cls;
}

describe('authz-orm registry', () => {
  afterEach(() => resetRegistry());

  it('reads @AccessResource, @Parent, @Owner and @Self into one frozen entry', () => {
    const Task = model('Task');
    Parent('project')(Task.prototype, 'project_id');
    Parent('sprint', { nullable: true })(Task.prototype, 'sprint_id');
    Owner()(Task.prototype, 'owner_id');
    AccessResource('task')(Task);

    const e = entryOf(Task)!;
    expect(e.type).to.equal('task');
    expect(e.registered).to.equal(Task);
    expect(e.idColumn).to.equal('id');
    expect(e.parents).to.deep.equal([
      { property: 'project_id', column: 'project_id', type: 'project', nullable: false },
      { property: 'sprint_id', column: 'sprint_id', type: 'sprint', nullable: true },
    ]);
    expect(e.owner).to.deep.equal({ property: 'owner_id', column: 'owner_id' });
    expect(e.self).to.equal(undefined);
    expect(Object.isFrozen(e)).to.equal(true);
    expect(Object.isFrozen(e.parents)).to.equal(true);
  });

  it('registerAccessResource declares parents, owner and self by column', () => {
    const User = model('User');
    registerAccessResource(User as never, 'user', { self: 'Uuid', parents: [{ column: 'org_id', type: 'org' }], owner: 'created_by' });
    const e = entryOf(User)!;
    expect(e.self).to.deep.equal({ column: 'Uuid' });
    expect(e.owner).to.deep.equal({ property: 'created_by', column: 'created_by' });
    expect(e.parents).to.deep.equal([{ property: 'org_id', column: 'org_id', type: 'org', nullable: false }]);
  });

  it('an owner may name a principal type column (decorator or registration)', () => {
    const Job = model('JobRow');
    registerAccessResource(Job as never, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
    expect(entryOf(Job)!.owner).to.deep.equal({ property: 'InitiatorId', column: 'InitiatorId', typeColumn: 'InitiatorType' });
    const Doc = model('Doc');
    Owner({ typeColumn: 'owner_type' })(Doc.prototype, 'owner_id');
    AccessResource('doc')(Doc);
    expect(entryOf(Doc)!.owner).to.deep.equal({ property: 'owner_id', column: 'owner_id', typeColumn: 'owner_type' });
    expect(() => registerAccessResource(model('Bad') as never, 'bad', { owner: { column: 'a', typeColumn: 'a' } })).to.throw(AuthzConfigError, /typeColumn must differ/);
    const Note = model('Note');
    Owner({ typeColumn: 'owner_type' })(Note.prototype, 'owner_id');
    registerAccessResource(Note as never, 'note', { owner: 'owner_id' });
    expect(() => entryOf(Note)).to.throw(AuthzConfigError, /owner/);
  });

  it('a subclass inherits the entry of its nearest registered ancestor and adds its own parents', () => {
    const Base = model('Folder');
    Parent('project')(Base.prototype, 'project_id');
    AccessResource('folder')(Base);
    const Sub = model('SubFolder', Base);
    Parent('folder', { nullable: true })(Sub.prototype, 'parent_id');
    const e = entryOf(Sub)!;
    expect(e.registered).to.equal(Base);
    expect(e.parents.map((p) => p.column)).to.deep.equal(['project_id', 'parent_id']);
    expect(entryOf(Base)!.parents.map((p) => p.column)).to.deep.equal(['project_id']);
  });

  it('is idempotent for the same registration and refuses a conflicting one', () => {
    const Job = model('Job');
    registerAccessResource(Job as never, 'job', { owner: 'initiator' });
    registerAccessResource(Job as never, 'job', { owner: 'initiator' });
    expect(() => registerAccessResource(Job as never, 'job', { owner: 'other' })).to.throw(AuthzConfigError, /already registered/);
    expect(() => registerAccessResource(Job as never, 'task')).to.throw(AuthzConfigError, /already registered/);
  });

  it('refuses bad declarations with AuthzConfigError', () => {
    const M = model('M');
    expect(() => AccessResource('')(M)).to.throw(AuthzConfigError, /non-empty string/);
    expect(() => AccessResource('$global')(M)).to.throw(AuthzConfigError, /not a resource type/);
    expect(() => Parent('$global')).to.throw(AuthzConfigError, /resource type/);
    const N = model('N');
    Owner()(N.prototype, 'a');
    expect(() => Owner()(N.prototype, 'b')).to.throw(AuthzConfigError, /one owner/);
    Self()(N.prototype, 'Uuid');
    expect(() => Self()(N.prototype, 'other')).to.throw(AuthzConfigError, /one self/);
    Parent('org')(N.prototype, 'org_id');
    expect(() => Parent('team')(N.prototype, 'org_id')).to.throw(AuthzConfigError, /one @Parent per property/);
    const O = model('O');
    Owner()(O.prototype, 'owner');
    expect(() => registerAccessResource(O as never, 'o', { owner: 'someone_else' })).to.throw(AuthzConfigError, /owner/);
    const NoPk = { NoPk: class extends ModelBase {} }.NoPk;
    AccessResource('nopk')(NoPk);
    expect(() => entryOf(NoPk)).to.throw(AuthzConfigError, /primary key/);
  });

  it('lists classes by type in registration order, types, and the types above a type', () => {
    const A = model('A');
    const B = model('B');
    Parent('project')(A.prototype, 'project_id');
    AccessResource('task')(A);
    AccessResource('task')(B);
    const P = model('P');
    Parent('org')(P.prototype, 'org_id');
    AccessResource('project')(P);
    expect(classesOf('task')).to.deep.equal([A, B]);
    expect(registeredTypes()).to.deep.equal(['task', 'project']);
    expect(typesAbove('task')).to.deep.equal(['project', 'org']);
    unregisterResource(B);
    expect(classesOf('task')).to.deep.equal([A]);
  });
});
```

Create `packages/authz-orm/test/api.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import * as root from '../src/index.js';
import * as stubs from '../src/api.js';

const expect = chai.expect;

const model = class Fake {} as unknown as Class<ModelBase>;
const notImplemented = (name: string) => new RegExp(`^@spinajs/authz-orm: ${name} is not implemented yet$`);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <A, B>(ok: Same<A, B>) => ok;

describe('authz-orm api', () => {
  // api.ts is frozen and keeps its stubs; src/index.ts exports the implementations in their place.
  it('every stub of api.ts throws not implemented', async () => {
    expect(() => stubs.AccessResource('task')).to.throw(Error, notImplemented('AccessResource'));
    expect(() => stubs.Parent('project', { nullable: true })).to.throw(Error, notImplemented('Parent'));
    expect(() => stubs.Owner()).to.throw(Error, notImplemented('Owner'));
    expect(() => stubs.Owner({ typeColumn: 'InitiatorType' })).to.throw(Error, notImplemented('Owner'));
    expect(() => stubs.registerAccessResource(model, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } })).to.throw(Error, notImplemented('registerAccessResource'));
    expect(() => stubs.Self()).to.throw(Error, notImplemented('Self'));
    expect(() => stubs.registerAccessResource(model, 'job', { owner: 'initiator', self: 'Uuid', parents: [{ column: 'org_id', type: 'org' }] })).to.throw(Error, notImplemented('registerAccessResource'));
    expect(() => stubs.reparent(model, ['1'], '2', 'project_id')).to.throw(Error, notImplemented('reparent'));
  });

  it('the root exports implementations with the frozen types', () => {
    same<typeof root.AccessResource, typeof stubs.AccessResource>(true);
    same<typeof root.Parent, typeof stubs.Parent>(true);
    same<typeof root.Owner, typeof stubs.Owner>(true);
    same<typeof root.Self, typeof stubs.Self>(true);
    same<typeof root.registerAccessResource, typeof stubs.registerAccessResource>(true);
    for (const k of ['AccessResource', 'Parent', 'Owner', 'Self', 'registerAccessResource']) {
      expect((root as Record<string, unknown>)[k], k).to.not.equal((stubs as Record<string, unknown>)[k]);
    }
    const t: ResourceType = 'task';
    expect(() => root.AccessResource(t)).to.not.throw();
  });

  it('keeps the scope attribute store and the config schema on the root', () => {
    expect(root.DbScopeAttributeStore).to.be.a('function');
    expect(root.AUTHZ_ORM_CONFIGURATION_SCHEMA.properties).to.have.keys(['domain']);
  });
});
```

Create `packages/authz-orm/test/host.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { DecisionAudit, SYSTEM, authzStorage, runWithPrincipal } from '@spinajs/authz';
import { RecordingAudit, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';

import { marksOf, setMarks } from '../src/marker.js';
import { auditUnscoped, domainContainer, ormDomain, storageUnscoped } from '../src/host.js';

const expect = chai.expect;
const tick = () => new Promise((r) => setImmediate(r));

describe('authz-orm host helpers', function () {
  this.timeout(30000);

  before(async () => {
    await testHost.installHost();
  });

  after(async () => {
    await testHost.uninstallHost();
  });

  afterEach(async () => {
    await testHost.resetHost();
  });

  it('ormDomain reads authz.orm.domain, default root', () => {
    expect(ormDomain()).to.equal('root');
    testHost.config().set(['authz', 'orm', 'domain'], 'app');
    expect(ormDomain()).to.equal('app');
  });

  it('domainContainer falls back to the DI root before the host created the domain', () => {
    expect(domainContainer('nope')).to.equal(DI.RootContainer);
  });

  it('marks live on the builder object, frozen, and are not enumerable', () => {
    const builder = {};
    expect(marksOf(builder)).to.equal(undefined);
    setMarks(builder, { unscoped: 'export' });
    expect(marksOf(builder)).to.deep.equal({ unscoped: 'export' });
    expect(Object.isFrozen(marksOf(builder))).to.equal(true);
    expect(Object.keys(builder)).to.deep.equal([]);
  });

  it('storageUnscoped reads the route @Unscoped reason of the request store', async () => {
    expect(storageUnscoped()).to.equal(undefined);
    await authzStorage().run({ Unscoped: 'report' } as never, async () => {
      expect(storageUnscoped()).to.equal('report');
    });
  });

  it('auditUnscoped records an unscoped entry when authz.audit.unscoped is on', async () => {
    const audit = new RecordingAudit();
    testHost.registerInRoot(DecisionAudit, testHost.instance(audit));
    await (await testHost.domains()).service('root');
    auditUnscoped('root', SYSTEM, 'export', 'task');
    await tick();
    expect(audit.of('unscoped')).to.deep.equal([{ kind: 'unscoped', principal: { type: SYSTEM.type, id: SYSTEM.id }, reason: 'export', resource: { type: 'task' } }]);
    testHost.config().set(['authz', 'audit', 'unscoped'], false);
    await runWithPrincipal(SYSTEM, async () => auditUnscoped('root', SYSTEM, 'again', 'task'));
    await tick();
    expect(audit.of('unscoped')).to.have.length(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/registry.test.ts test/api.test.ts test/host.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/registry.js'` (and `../src/marker.js`, `../src/host.js`).

- [ ] **Step 4: Write `src/api.ts`**

Replace `packages/authz-orm/src/api.ts` with:

```ts
import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

// Takes the arguments so the stubs keep the design's parameter names under noUnusedParameters.
function notImplemented(name: string, ..._args: unknown[]): Error {
  return new Error(`@spinajs/authz-orm: ${name} is not implemented yet`);
}

export interface ParentOptions {
  /** A NULL column means "no parent" (a root); without it `authz:ancestors-verify` reports NULLs. */
  readonly nullable?: boolean;
}

export interface OwnerOptions {
  /** A column holding the owner's principal type; without it the owner is always a `user`. */
  readonly typeColumn?: string;
}

export interface AccessResourceOptions {
  /** The `@Parent` columns of a model the package does not own. */
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType }[];
  /** The `owner` column (the user whose id it holds), or the id column plus a principal type column. */
  readonly owner?: string | { readonly column: string; readonly typeColumn?: string };
  /** The `self` column: the row is the user whose id it holds. */
  readonly self?: string;
}

// default permissions: `${type}:read|create|update|delete`; several models may share one type (B21)
export function AccessResource(type: ResourceType): ClassDecorator {
  throw notImplemented('AccessResource', type);
}

// the column holds the id of the parent resource of `type`; several parents and self-references are allowed
export function Parent(type: ResourceType, opts?: ParentOptions): PropertyDecorator {
  throw notImplemented('Parent', type, opts);
}

// relation 'owner' on the model's type
export function Owner(opts?: OwnerOptions): PropertyDecorator {
  throw notImplemented('Owner', opts);
}

// relation 'self' on the model's type
export function Self(): PropertyDecorator {
  throw notImplemented('Self');
}

// for models a package does not own (JobModel, DbConfig)
export function registerAccessResource(model: Class<ModelBase>, type: ResourceType, opts?: AccessResourceOptions): void {
  throw notImplemented('registerAccessResource', model, type, opts);
}

// writes `column` (default: the model's only @Parent) of the rows `ids` in one transaction; resolves with the rows changed
export function reparent(model: Class<ModelBase>, ids: readonly (string | number)[], newParentId: string | number | null, column?: string): Promise<number> {
  throw notImplemented('reparent', model, ids, newParentId, column);
}
```

- [ ] **Step 5: Write `src/registry.ts`**

```ts
import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';

// Every module of the package reaches the registry, so a second copy fails before it registers anything.
import './once.js';

// eslint-disable-next-line @typescript-eslint/ban-types
export type ModelClass = Function;

export interface ParentEntry {
  readonly property: string;
  readonly column: string;
  readonly type: ResourceType;
  readonly nullable: boolean;
}

export interface ResourceEntry {
  /** The registered class; for a subclass looked up through the chain, its nearest registered ancestor. */
  readonly registered: ModelClass;
  readonly type: ResourceType;
  readonly parents: readonly ParentEntry[];
  /** Without `typeColumn` the owner is a `user` principal; with it, the row's type column names the principal type. */
  readonly owner?: { readonly property: string; readonly column: string; readonly typeColumn?: string };
  readonly self?: { readonly column: string };
  readonly idColumn: string;
}

export interface OwnerColumns {
  readonly column: string;
  readonly typeColumn?: string;
}

export interface RegistrationOptions {
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType }[];
  readonly owner?: string | OwnerColumns;
  readonly self?: string;
}

interface Registration {
  readonly type: ResourceType;
  readonly parents: readonly ParentEntry[];
  readonly owner?: OwnerColumns;
  readonly self?: string;
  /** Canonical form, to tell an idempotent re-registration from a conflicting one. */
  readonly key: string;
}

interface PropertyMetadata {
  owner?: OwnerColumns;
  self?: string;
  readonly parents: ParentEntry[];
}

const sameOwner = (a: OwnerColumns, b: OwnerColumns): boolean => a.column === b.column && a.typeColumn === b.typeColumn;
const showOwner = (o: OwnerColumns): string => (o.typeColumn === undefined ? `'${o.column}'` : `'${o.column}' (type column '${o.typeColumn}')`);

// Insertion order is registration order (lookups by type rely on it).
const registrations = new Map<ModelClass, Registration>();
// Property decorators run before the class decorator, and on classes registerAccessResource may never see.
const properties = new WeakMap<ModelClass, PropertyMetadata>();
// entryOf runs for every query builder; any registry write clears it.
let entries = new WeakMap<ModelClass, ResourceEntry | null>();
let version = 0;

/** Changes whenever a class is registered or forgotten. */
export const registryVersion = (): number => version;

export const nameOf = (c: unknown): string => (typeof c === 'function' && c.name ? c.name : '<anonymous class>');

function chain(model: ModelClass): ModelClass[] {
  const out: ModelClass[] = [];
  for (let c: unknown = model; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) out.push(c as ModelClass);
  return out;
}

export function checkType(type: unknown, where: string): ResourceType {
  if (typeof type !== 'string' || type.length === 0) throw new AuthzConfigError(`${where}: the type must be a non-empty string`);
  if (type === GLOBAL.type) throw new AuthzConfigError(`${where}: '${GLOBAL.type}' is not a resource type`);
  return type;
}

function checkColumn(column: unknown, where: string): string {
  if (typeof column !== 'string' || column.length === 0) throw new AuthzConfigError(`${where}: a column must be a non-empty string`);
  return column;
}

export function ownerColumns(owner: unknown, where: string): OwnerColumns {
  if (typeof owner === 'string') return { column: checkColumn(owner, where) };
  if (owner === null || typeof owner !== 'object') throw new AuthzConfigError(`${where}: the owner must be a column name or { column, typeColumn? }`);
  const o = owner as Record<string, unknown>;
  const column = checkColumn(o.column, where);
  if (o.typeColumn === undefined) return { column };
  const typeColumn = checkColumn(o.typeColumn, `${where} typeColumn`);
  if (typeColumn === column) throw new AuthzConfigError(`${where}: typeColumn must differ from the owner column`);
  return { column, typeColumn };
}

function normalize(model: ModelClass, type: unknown, opts: unknown): Registration {
  const where = `${nameOf(model)}: @AccessResource`;
  const t = checkType(type, where);
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError(`${where}('${t}'): options must be an object`);
  const o = (opts ?? {}) as RegistrationOptions;
  for (const k of Object.keys(o)) if (!['parents', 'owner', 'self'].includes(k)) throw new AuthzConfigError(`${where}('${t}'): unknown option '${k}'`);
  if (o.parents !== undefined && !Array.isArray(o.parents)) throw new AuthzConfigError(`${where}('${t}'): parents must be a list of { column, type }`);
  const parents = (o.parents ?? []).map((p) => {
    const column = checkColumn(p?.column, `${where}('${t}') parents`);
    return Object.freeze({ property: column, column, type: checkType(p?.type, `${where}('${t}') parent ${column}`), nullable: false });
  });
  const owner = o.owner === undefined ? undefined : ownerColumns(o.owner, `${where}('${t}') owner`);
  const self = o.self === undefined ? undefined : checkColumn(o.self, `${where}('${t}') self`);
  const key = JSON.stringify([t, parents.map((p) => [p.column, p.type]), owner ? [owner.column, owner.typeColumn ?? null] : null, self ?? null]);
  return { type: t, parents, ...(owner !== undefined ? { owner } : {}), ...(self !== undefined ? { self } : {}), key };
}

export function register(model: ModelClass, type: unknown, opts?: unknown): void {
  if (typeof model !== 'function') throw new AuthzConfigError('registerAccessResource: the model must be a class');
  const next = normalize(model, type, opts);
  const prev = registrations.get(model);
  if (prev !== undefined) {
    if (prev.key === next.key) return;
    throw new AuthzConfigError(`${nameOf(model)} is already registered as resource '${prev.type}' with other options`);
  }
  registrations.set(model, next);
  entries = new WeakMap();
  version++;
}

function metadataOf(model: ModelClass): PropertyMetadata {
  let m = properties.get(model);
  if (m === undefined) properties.set(model, (m = { parents: [] }));
  return m;
}

export function setOwner(model: ModelClass, owner: OwnerColumns): void {
  const m = metadataOf(model);
  if (m.owner !== undefined && !sameOwner(m.owner, owner)) throw new AuthzConfigError(`${nameOf(model)}: @Owner() is on ${showOwner(m.owner)} already; a model has one owner property`);
  m.owner = owner;
  entries = new WeakMap();
}

export function setSelf(model: ModelClass, property: string): void {
  const m = metadataOf(model);
  if (m.self !== undefined && m.self !== property) throw new AuthzConfigError(`${nameOf(model)}: @Self() is on '${m.self}' already; a model has one self property`);
  m.self = property;
  entries = new WeakMap();
}

export function addParent(model: ModelClass, parent: ParentEntry): void {
  const m = metadataOf(model);
  if (m.parents.some((p) => p.property === parent.property)) throw new AuthzConfigError(`${nameOf(model)}.${parent.property}: one @Parent per property`);
  m.parents.push(Object.freeze({ ...parent }));
  entries = new WeakMap();
}

function pkOf(model: ModelClass): string {
  const pk = extractModelDescriptor(model as never)?.PrimaryKey as unknown;
  const name = Array.isArray(pk) ? pk[0] : pk;
  if (typeof name !== 'string' || name === '') throw new AuthzConfigError(`authz-orm: @AccessResource model ${nameOf(model)} has no primary key`);
  return name;
}

/** The entry of `model` or of its nearest registered ancestor; property metadata merges over the whole chain of `model`. */
export function entryOf(model: unknown): ResourceEntry | undefined {
  if (typeof model !== 'function') return undefined;
  const cached = entries.get(model);
  if (cached !== undefined) return cached ?? undefined;
  const entry = buildEntry(model);
  entries.set(model, entry ?? null);
  return entry;
}

function buildEntry(model: ModelClass): ResourceEntry | undefined {
  const classes = chain(model);
  const registered = classes.find((c) => registrations.has(c));
  if (registered === undefined) return undefined;
  const r = registrations.get(registered)!;
  const where = `${nameOf(model)} (resource '${r.type}')`;

  let owner: OwnerColumns | undefined;
  let self: string | undefined;
  const parents: ParentEntry[] = [];
  // Base first, so a subclass's own declarations follow the inherited ones and its @Owner wins.
  for (const c of [...classes].reverse()) {
    const m = properties.get(c);
    if (m === undefined) continue;
    if (m.owner !== undefined) owner = m.owner;
    if (m.self !== undefined) self = m.self;
    for (const p of m.parents) {
      const i = parents.findIndex((x) => x.property === p.property);
      if (i === -1) parents.push(p);
      else parents[i] = p;
    }
  }
  for (const p of r.parents) {
    const same = parents.find((x) => x.column === p.column);
    if (same && same.type !== p.type) throw new AuthzConfigError(`${where}: parent column ${p.column} is @Parent('${same.type}') and registered as '${p.type}'`);
    if (!same) parents.push(p);
  }
  if (r.owner !== undefined && owner !== undefined && !sameOwner(r.owner, owner)) throw new AuthzConfigError(`${where}: the owner is @Owner() ${showOwner(owner)} and registered as ${showOwner(r.owner)}`);
  if (r.self !== undefined && self !== undefined && r.self !== self) throw new AuthzConfigError(`${where}: self is @Self() '${self}' and registered as '${r.self}'`);
  owner ??= r.owner;
  self ??= r.self;

  return Object.freeze({
    registered,
    type: r.type,
    parents: Object.freeze(parents),
    ...(owner !== undefined ? { owner: Object.freeze({ property: owner.column, column: owner.column, ...(owner.typeColumn !== undefined ? { typeColumn: owner.typeColumn } : {}) }) } : {}),
    ...(self !== undefined ? { self: Object.freeze({ column: self }) } : {}),
    idColumn: pkOf(model),
  });
}

export function isRegistered(model: unknown): boolean {
  return entryOf(model) !== undefined;
}

/** Registered classes of `type`, in registration order. */
export function classesOf(type: ResourceType): ModelClass[] {
  return [...registrations].filter(([, r]) => r.type === type).map(([c]) => c);
}

/** Every registered type, in first-registration order. */
export function registeredTypes(): ResourceType[] {
  return [...new Set([...registrations.values()].map((r) => r.type))];
}

export function registeredClasses(): ModelClass[] {
  return [...registrations.keys()];
}

/** The parent types of `type`'s classes, transitively, nearest first; `type` itself only when it is its own ancestor type. */
export function typesAbove(type: ResourceType): ResourceType[] {
  const out: ResourceType[] = [];
  const queue: ResourceType[] = [type];
  while (queue.length > 0) {
    const t = queue.shift()!;
    for (const c of classesOf(t)) {
      for (const p of entryOf(c)?.parents ?? []) {
        if (out.includes(p.type) || p.type === type) continue;
        out.push(p.type);
        queue.push(p.type);
      }
    }
  }
  return out;
}

/** Test seam: forget a class's registration. Its decorated properties stay, so it can register again. */
export function unregisterResource(model: ModelClass): void {
  registrations.delete(model);
  entries = new WeakMap();
  version++;
}

/** Test seam: forget every registration (decorator metadata stays). */
export function resetRegistry(): void {
  registrations.clear();
  entries = new WeakMap();
  version++;
}
```

- [ ] **Step 6: Write `src/decorators.ts`**

```ts
import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import type { AccessResourceOptions, OwnerOptions, ParentOptions } from './api.js';
import { addParent, checkType, ownerColumns, register, setOwner, setSelf } from './registry.js';
import type { ModelClass } from './registry.js';

const ctorOf = (target: object): ModelClass => (typeof target === 'function' ? target : (target as { constructor: ModelClass }).constructor);

function propertyName(decorator: string, target: object, key: string | symbol): string {
  if (typeof key !== 'string') throw new AuthzConfigError(`${decorator}: ${ctorOf(target).name || '<anonymous class>'} decorates a symbol property; use a named property`);
  return key;
}

export function AccessResource(type: ResourceType): ClassDecorator {
  checkType(type, '@AccessResource');
  return (target) => {
    register(target, type);
  };
}

export function Parent(type: ResourceType, opts?: ParentOptions): PropertyDecorator {
  checkType(type, '@Parent');
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError(`@Parent('${type}'): options must be an object`);
  return (target, key) => {
    const property = propertyName(`@Parent('${type}')`, target, key);
    addParent(ctorOf(target), { property, column: property, type, nullable: opts?.nullable === true });
  };
}

export function Owner(opts?: OwnerOptions): PropertyDecorator {
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError('@Owner(): options must be an object');
  return (target, key) => {
    const column = propertyName('@Owner()', target, key);
    setOwner(ctorOf(target), ownerColumns(opts?.typeColumn === undefined ? column : { column, typeColumn: opts.typeColumn }, `${ctorOf(target).name || '<anonymous class>'}: @Owner()`));
  };
}

export function Self(): PropertyDecorator {
  return (target, key) => {
    setSelf(ctorOf(target), propertyName('@Self()', target, key));
  };
}

export function registerAccessResource(model: Class<ModelBase>, type: ResourceType, opts?: AccessResourceOptions): void {
  register(model, type, opts);
}
```

- [ ] **Step 7: Write `src/marker.ts`**

```ts
import type { Permission } from '@spinajs/authz';

const MARKS = Symbol.for('@spinajs/authz-orm:marks');

/** What `.accessible()`, `.unscoped()` and `.withAccess()` (lane L4) declared on one builder. */
export interface AccessMarks {
  readonly accessible?: Permission;
  /** Request env for the access plans (`accessPlan`'s `env`). */
  readonly env?: Readonly<Record<string, unknown>>;
  readonly unscoped?: string;
  readonly withAccess?: readonly Permission[];
}

export function marksOf(builder: object): AccessMarks | undefined {
  return (builder as Record<symbol, AccessMarks | undefined>)[MARKS];
}

export function setMarks(builder: object, marks: AccessMarks): void {
  Object.defineProperty(builder, MARKS, { value: Object.freeze({ ...marks }), configurable: true, writable: true, enumerable: false });
}
```

- [ ] **Step 8: Write `src/host.ts`**

```ts
import { AuthzDomains, DecisionAudit, DefaultAuthzDomains, authzStorage, configuredLineage, engineLog, readDomainConfig } from '@spinajs/authz';
import type { DomainConfig, HostLog, Principal, ResourceType } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, ResolveType, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

const ROOT = 'root';

type AuditRecord = Parameters<DecisionAudit['record']>[0];

/** `authz.orm.domain`: the domain whose service plans lists and whose stores a delete cleans; default root. */
export function ormDomain(): string {
  const v = DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'domain']);
  return typeof v === 'string' && v !== '' ? v : ROOT;
}

function hostDomains(): DefaultAuthzDomains | undefined {
  const d: unknown = DI.get(AuthzDomains);
  return d instanceof DefaultAuthzDomains ? d : undefined;
}

/** The domain's container once the host created it, else the DI root. */
export function domainContainer(domain: string): IContainer {
  const d = hostDomains();
  return d !== undefined && d.names().includes(domain) ? d.container(domain) : DI.RootContainer;
}

/** The domain's config over its lineage: the host's lineage once it has created its domains, else the configured parents. */
export function domainConfig(domain: string): DomainConfig {
  const tree = DI.get(Configuration)?.get<unknown>(['authz']);
  const d = hostDomains();
  const lineage = d !== undefined && d.names().includes(domain) ? d.lineage(domain) : configuredLineage(tree, domain);
  return readDomainConfig(tree, lineage);
}

// As the host picks it: the one named in audit.service, else the last DecisionAudit registered.
async function auditOf(domain: string): Promise<DecisionAudit | undefined> {
  const container = domainContainer(domain);
  const name = domainConfig(domain).audit.service;
  if (name === undefined) return container.hasRegistered(DecisionAudit) ? ((await container.resolve(DecisionAudit)) as DecisionAudit) : undefined;
  const entry = container.Registry.getTypesChain(DecisionAudit)
    .filter((e) => !isFactory(e.type) && (e.type as { name?: string }).name === name)
    .pop();
  if (!entry) return undefined;
  const type = entry.type as Class<DecisionAudit>;
  const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
  return (await at.resolve(type)) as DecisionAudit;
}

/** Fire and forget: auditing never fails the query. */
export function recordAudit(domain: string, record: AuditRecord): void {
  auditOf(domain)
    .then((audit) => audit?.record(record))
    .then(undefined, (e: unknown) => ormLog().error(`authz-orm: audit record failed: ${e instanceof Error ? e.message : String(e)}`));
}

/** A `.unscoped(reason)` query, audited when `authz.audit.unscoped` is on. */
export function auditUnscoped(domain: string, principal: Principal, reason: string, type: ResourceType): void {
  if (!domainConfig(domain).audit.unscoped) return;
  recordAudit(domain, { kind: 'unscoped', principal: { type: principal.type, id: principal.id }, reason, resource: { type } });
}

/** The reason of a route's `@Unscoped(reason)` (authz-http) for this request, if any. */
export function storageUnscoped(): string | undefined {
  const reason = authzStorage().getStore()?.Unscoped;
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

let log: HostLog | undefined;

export function ormLog(): HostLog {
  return (log ??= engineLog('authz-orm'));
}
```

- [ ] **Step 9: Rewrite `src/schema.ts`**

```ts
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

export const AUTHZ_ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-orm.configuration.schema.json',
  $configurationModule: 'authz.orm',
  description: 'ORM authorization configuration (authz.orm.*)',
  type: 'object',
  properties: {
    // The authz domain whose service plans lists and whose stores a delete cleans up.
    domain: { type: 'string', minLength: 1, default: 'root' },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_ORM_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzOrmConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ORM_CONFIGURATION_SCHEMA);
  }
}
```

- [ ] **Step 10: Rewrite `src/index.ts`**

```ts
import './once.js';

export * from './api.js';
export * from './scope-attributes/index.js';
export * from './schema.js';
// api.ts is the frozen contract and keeps its stubs; the implementations shadow them here (an
// explicit export wins over export *), and test/api.test.ts pins that their types equal the contract's.
export { AccessResource, Parent, Owner, Self, registerAccessResource } from './decorators.js';
export { entryOf, classesOf, registeredTypes, typesAbove } from './registry.js';
export type { ResourceEntry, ParentEntry } from './registry.js';
```

- [ ] **Step 11: Update `package.json` and the tsconfigs**

In `packages/authz-orm/package.json`: replace the `"./native"` entry of `exports` with

```json
    "./scope-attributes": {
      "types": "./lib/mjs/scope-attributes/index.d.ts",
      "import": "./lib/mjs/scope-attributes/index.js",
      "require": "./lib/cjs/scope-attributes/index.js"
    },
```

replace `"native": ["lib/cjs/native.d.ts"],` in `typesVersions["*"]` with `"scope-attributes": ["lib/cjs/scope-attributes/index.d.ts"],`, and add to `dependencies` (alphabetical): `"@spinajs/cli": "2.0.549",` (Task 7's commands; added here so dependency edits stay in this one task). Change `"description"` to `"ORM resources, closure table and list helpers for SpinaJS authorization"`.

In `packages/authz-orm/tsconfig.json` `references` add `{ "path": "../cli/tsconfig.json" }`. In `tsconfig.mjs.json` add `{ "path": "../cli/tsconfig.mjs.json" }`; in `tsconfig.cjs.json` add `{ "path": "../cli/tsconfig.cjs.json" }`.

Run: `cd ../.. && npm install --no-audit --no-fund 2>&1 | tail -1`
Expected: a line like `up to date` or `added 0 packages` (both are `file:` links that already exist).

- [ ] **Step 12: Rewrite `README.md`**

Replace `packages/authz-orm/README.md` with the sections below; the sections `@OrmScope policies`, `What the query middleware does not see`, `Relations, sub-queries and clones`, `Databases`, `Field filtering`, `Native compilers` and `ABAC scope leaves` are removed. Keep `## Database audit` exactly as it is today (lines 113–135 of the old file), after `## Declaring resources`.

````md
# `@spinajs/authz-orm`

ORM resources for SpinaJS authorization: declarations, single-object checks, the
`authz_resource_ancestor` closure table and the list helpers (design 2026-10-14).

## Setup

- `import '@spinajs/authz-orm'` registers `OrmResourceAdapter` (a `ResourceAdapter` for every
  `@AccessResource` type), the query middleware that keeps `authz_resource_ancestor` right, and the
  runtime guard. Register models before the authz domain boots (at import, or in a `Bootstrapper`).
- `authz.orm.domain` (default `root`) names the domain whose service plans lists and whose stores a
  delete cleans up.

## Declaring resources

```ts
@AccessResource('task')
export class Task extends ModelBase {
  @Parent('project') public project_id: number;
  @Parent('sprint', { nullable: true }) public sprint_id: number;
  @Owner() public owner_id: string;
}
```

- `@Parent(type)`: the column holds the parent's id. Several parents and self-references are allowed.
- `@Owner()`: relation `owner`, true for the `user` principal whose id the column holds;
  `@Owner({ typeColumn })` also reads the principal type from that column (any principal type). `@Self()`:
  relation `self`, true when the row is that user.
- `registerAccessResource(model, type, { parents, owner, self })` does the same for models a package
  does not own.
- Default permissions per type: `<type>:read`, `<type>:create`, `<type>:update`, `<type>:delete`.
````

- [ ] **Step 13: Write the RFC**

Create `docs/plans/authz-v3-rfc/RA3-1.md`:

```md
# RA3-1: authz-orm declares resources by parent links, not query scopes

Status: APPROVED with the 2026-10-14 resource-access design (lane L3).

## Problem

`packages/authz-orm/src/api.ts` froze the query-rewriting API: `@AccessResource(type, { relationScope,
permissions, attributes })`, `@ScopeColumn`, `@OrmScope` / `OrmScopePolicy`, `OrmNativeCompiler`,
`filterFields`, `ownsBy`. The design of 2026-10-14 removes query rewriting (design §9).

## Change

`src/api.ts` now freezes:

- `AccessResource(type)`, `Parent(type, opts?: ParentOptions)`, `Owner(opts?: OwnerOptions)` (`typeColumn`: the principal type of the owner), `Self()`;
- `registerAccessResource(model, type, opts?: AccessResourceOptions)` with `{ parents?, owner?: string | { column, typeColumn? }, self? }`;
- `reparent(model, ids, newParentId, column?)`: the bulk move of design §6.4. It is an authz-orm
  function, not `authz().ancestors.reparent` as the design sketched: the closure table belongs to
  this package and the core `AuthzService` contract stays free of ORM types.

Removed: `ScopeColumn`, `OrmScope`, `OrmScopePolicy`, `OrmNativeCompiler`, `filterFields`, `ownsBy`,
the `./native` subpath. Added: the `./scope-attributes` subpath.

## Affected lanes

L5 (authz-queue, configuration-http, users, http-socket, authz-testing move to the new decorators),
L9 (docs).
```

- [ ] **Step 14: Build, regenerate the snapshot, run the tests**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/registry.test.ts test/api.test.ts test/host.test.ts`
Expected: PASS, `15 passing`, `0 failing`.

Run: `cd ../.. && npm run build 2>&1 | tail -3 && node scripts/api-snapshot.mjs --update && git diff --stat packages/authz-orm/etc`
Expected: the build of `packages/authz-orm` succeeds (`authz-queue`, `configuration-http` and `authz-testing` tests may fail to compile until L5; the root build fails only if `authz-queue/src/job/job-resource.ts` or `configuration-http/src/bootstrap.ts` is built: in that case run `npm run build` again after L5, and generate the snapshot with `cd packages/authz-orm && npm run compile && cd ../.. && node scripts/api-snapshot.mjs --update`). The diff shows `packages/authz-orm/etc/authz-orm.api.md | ` changed.

Run: `cd packages/authz-orm && npm test`
Expected: PASS: registry, api, host, audit and scope-attribute suites, `0 failing`.

- [ ] **Step 15: Commit**

```bash
git add -A packages/authz-orm docs/plans/authz-v3-rfc/RA3-1.md package-lock.json
git commit -m "refactor(authz-orm): gut query scoping; registry, @Parent/@Owner/@Self, frozen API (RA3-1)"
```

---

### Task 2: Migration `AuthzResourceAncestor_2026_10_14_00_00_00`

**Files:**
- Create: `packages/authz-orm/src/ancestors/table.ts`, `src/ancestors/AuthzResourceAncestor_2026_10_14_00_00_00.ts`, `src/ancestors/index.ts`
- Modify: `packages/authz-orm/src/index.ts`
- Create: `packages/authz-orm/test/support/ancestors.ts`
- Test: `packages/authz-orm/test/ancestors/migration.test.ts`

**Interfaces:**
- Produces: `AUTHZ_RESOURCE_ANCESTOR_TABLE = 'authz_resource_ancestor'`, `AncestorRow { resource_type; resource_id; ancestor_type; ancestor_id; depth }`, `ANCESTOR_COLUMNS`, `chunks(list, size)`, `ROW_CHUNK = 400` (5 columns × 400 = 2000 parameters, under MSSQL's 2100).
- Connection: the migration is `@Migration('default')`, as `AuthzRbac_2026_10_01_00_00_00` (whose stores read `authz.rbac.connection`, else `authz.admin.connection`, else `default`; `packages/authz-rbac/src/stores/context.ts:65-79`). The list query joins the table with the resource tables and `authz_assignment`, so all three live in one database (design §4.1). The middleware writes through the resource model's own connection (the statement's transaction); an app whose resource tables are on another connection than `default` runs the migration class's `up()` against that connection.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/support/ancestors.ts`:

```ts
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE, AuthzResourceAncestor_2026_10_14_00_00_00 } from '../../src/ancestors/index.js';
import type { AncestorRow } from '../../src/ancestors/index.js';
import type { Dialect, TestDb } from './db.js';

export async function createAncestorTable(db: TestDb, dialect: Dialect): Promise<void> {
  await db.raw(`DROP TABLE IF EXISTS "${AUTHZ_RESOURCE_ANCESTOR_TABLE}"`, [], dialect);
  await new AuthzResourceAncestor_2026_10_14_00_00_00().up(db.driver(dialect));
}

export async function dropAncestorTable(db: TestDb, dialect: Dialect): Promise<void> {
  await db.raw(`DROP TABLE IF EXISTS "${AUTHZ_RESOURCE_ANCESTOR_TABLE}"`, [], dialect);
}

/** `type:id>type:id@depth`, sorted: easy to compare in a deep equal. */
export async function ancestorLinks(driver: OrmDriver): Promise<string[]> {
  const rows = (await driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE)) as AncestorRow[];
  return rows.map((r) => `${r.resource_type}:${r.resource_id}>${r.ancestor_type}:${r.ancestor_id}@${Number(r.depth)}`).sort();
}

export async function insertLinks(driver: OrmDriver, links: readonly string[]): Promise<void> {
  if (links.length === 0) return;
  const rows = links.map((l) => {
    const m = /^([^:]+):([^>]+)>([^:]+):([^@]+)@(\d+)$/.exec(l);
    if (!m) throw new Error(`bad link ${l}`);
    return { resource_type: m[1], resource_id: m[2], ancestor_type: m[3], ancestor_id: m[4], depth: Number(m[5]) };
  });
  await driver.insert().into(AUTHZ_RESOURCE_ANCESTOR_TABLE).values(rows);
}
```

Create `packages/authz-orm/test/ancestors/migration.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { DI } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE, AuthzResourceAncestor_2026_10_14_00_00_00, chunks } from '../../src/ancestors/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

describe('authz_resource_ancestor migration', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  it('is registered on the default connection, as the RBAC migration', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzResourceAncestor_2026_10_14_00_00_00);
    expect((AuthzResourceAncestor_2026_10_14_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal('default');
  });

  it('chunks a list', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).to.deep.equal([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).to.deep.equal([]);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      afterEach(async () => {
        await dropAncestorTable(db, dialect);
      });

      it('creates the table with its primary key and the up index; down drops it', async () => {
        await createAncestorTable(db, dialect);
        const driver = db.driver(dialect);
        expect(await driver.schema().tableExists(AUTHZ_RESOURCE_ANCESTOR_TABLE)).to.equal(true);
        await insertLinks(driver, ['task:7>project:3@1']);
        let duplicate: unknown;
        try {
          await insertLinks(driver, ['task:7>project:3@2']);
        } catch (e) {
          duplicate = e;
        }
        expect(duplicate, 'the primary key refuses a second row for the same pair').to.be.instanceOf(Error);
        expect(await ancestorLinks(driver)).to.deep.equal(['task:7>project:3@1']);
        const indexes = dialect === 'sqlite' ? ((await db.raw(`PRAGMA index_list("${AUTHZ_RESOURCE_ANCESTOR_TABLE}")`)) as { name: string }[]).map((i) => i.name) : ((await db.raw(`SELECT indexname AS name FROM pg_indexes WHERE tablename = $1`, [AUTHZ_RESOURCE_ANCESTOR_TABLE], 'postgres')) as { name: string }[]).map((i) => i.name);
        expect(indexes).to.include('authz_resource_ancestor_up');
        await new AuthzResourceAncestor_2026_10_14_00_00_00().down(driver);
        expect(await driver.schema().tableExists(AUTHZ_RESOURCE_ANCESTOR_TABLE)).to.equal(false);
      });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/ancestors/migration.test.ts`
Expected: FAIL with a TSError `Cannot find module '../../src/ancestors/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/authz-orm/src/ancestors/table.ts`:

```ts
export const AUTHZ_RESOURCE_ANCESTOR_TABLE = 'authz_resource_ancestor';

export interface AncestorRow {
  readonly resource_type: string;
  readonly resource_id: string;
  readonly ancestor_type: string;
  readonly ancestor_id: string;
  /** 1 = direct parent. */
  readonly depth: number;
}

export const ANCESTOR_COLUMNS = ['resource_type', 'resource_id', 'ancestor_type', 'ancestor_id', 'depth'] as const;

/** Rows per INSERT: 5 parameters each stays under MSSQL's 2100 parameters per statement. */
export const ROW_CHUNK = 400;

/** Ids per IN list, for the same limit. */
export const ID_CHUNK = 1000;

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
```

Create `packages/authz-orm/src/ancestors/AuthzResourceAncestor_2026_10_14_00_00_00.ts`:

```ts
import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';

/**
 * authz_resource_ancestor (design §4.1): one row per proper ancestor of a resource, no self row and no
 * $global row. On 'default' like the RBAC tables: the list query joins it with them and with the resource tables.
 */
@Migration('default')
export class AuthzResourceAncestor_2026_10_14_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(AUTHZ_RESOURCE_ANCESTOR_TABLE, (table) => {
      table.string('resource_type', 64).notNull().primaryKey();
      table.string('resource_id', 64).notNull().primaryKey();
      table.string('ancestor_type', 64).notNull().primaryKey();
      table.string('ancestor_id', 64).notNull().primaryKey();
      table.int('depth').notNull();
    });
    await connection.index().table(AUTHZ_RESOURCE_ANCESTOR_TABLE).name('authz_resource_ancestor_up').columns(['ancestor_type', 'ancestor_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(AUTHZ_RESOURCE_ANCESTOR_TABLE).ifExists();
  }
}
```

Create `packages/authz-orm/src/ancestors/index.ts`:

```ts
export * from './table.js';
export * from './AuthzResourceAncestor_2026_10_14_00_00_00.js';
```

In `packages/authz-orm/src/index.ts` append:

```ts
export * from './ancestors/index.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/ancestors/migration.test.ts`
Expected: PASS, `4 passing` with Postgres up (`3 passing, 1 pending` without).

- [ ] **Step 5: Commit**

```bash
git add packages/authz-orm/src/ancestors packages/authz-orm/src/index.ts packages/authz-orm/test/support/ancestors.ts packages/authz-orm/test/ancestors/migration.test.ts
git commit -m "feat(authz-orm): authz_resource_ancestor migration"
```

---

### Task 3: `OrmResourceAdapter`

**Files:**
- Create: `packages/authz-orm/src/ids.ts`, `src/rows.ts`, `src/ancestors/read.ts`, `src/relations.ts`, `src/adapter.ts`
- Modify: `packages/authz-orm/src/ancestors/index.ts`, `src/index.ts`
- Test: `packages/authz-orm/test/adapter.test.ts`

**Interfaces:**
- Consumes: `ResourceAdapter` with L0's optional `loadMany` / `ancestorsMany` (overview, frozen contracts); `entryOf`, `classesOf`, `registeredTypes` (Task 1); `AUTHZ_RESOURCE_ANCESTOR_TABLE`, `chunks`, `ID_CHUNK` (Task 2).
- Produces:
  - `idText(value): string | undefined` (a hydrated id as the text the table stores: numbers via `String`, strings as they are, anything else undefined); `idLookup(model, column, id): string | number | undefined` (the value to bind for `id` against `column`, undefined when no row can have it); `refKey = resourceKey`.
  - `findRows(refs): Promise<Map<string, { model: ModelClass; row: ModelBase }>>` (as SYSTEM, by resourceKey) in `rows.ts`; `driverOf(model): OrmDriver`.
  - `readAncestors(driver, refs): Promise<Map<string, AncestorRow[]>>` sorted by depth, then type, then id; `whereRefs(builder, typeColumn, idColumn, refs)`, `groupIds(refs)` in `ancestors/read.ts`.
  - `OrmResourceAdapter` (`kind = 'orm'`), registered `@Injectable(ResourceAdapter)`.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/adapter.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, GLOBAL, ResourceAdapter, SYSTEM, currentPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { OrmResourceAdapter } from '../src/adapter.js';
import { AccessResource, Owner, Parent, Self, registerAccessResource } from '../src/index.js';
import { TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';
import { createAncestorTable, dropAncestorTable, insertLinks } from './support/ancestors.js';

const expect = chai.expect;

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });
const agent: Principal = { type: 'agent', id: 'alice', authenticated: true, source: 'test', attributes: {} };

describe('OrmResourceAdapter', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const adapter = new OrmResourceAdapter();

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  it('is the ResourceAdapter DI registers', async () => {
    expect(DI.getRegisteredTypes(ResourceAdapter)).to.include(OrmResourceAdapter);
    expect(adapter.kind).to.equal('orm');
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: typeof ModelBase;
      let User: typeof ModelBase;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = await db.define(
          {
            name: 'Task',
            columns: { id: 'INTEGER', project_id: 'TEXT', owner: 'TEXT', title: 'TEXT' },
            rows: [
              { id: 7, project_id: 'p1', owner: 'alice', title: 'a' },
              { id: 8, project_id: 'p2', owner: 'bob', title: 'b' },
            ],
            decorate: (cls, proto) => {
              AccessResource('task')(cls);
              Parent('project')(proto, 'project_id');
              Owner()(proto, 'owner');
            },
          },
          dialect,
        );
        User = await db.define(
          {
            name: 'User',
            columns: { Uuid: 'TEXT' },
            rows: [{ id: 'u1', Uuid: 'alice' }],
            decorate: (cls, proto) => {
              AccessResource('user')(cls);
              Self()(proto, 'Uuid');
            },
          },
          dialect,
        );
        await insertLinks(db.driver(dialect), ['task:7>project:p1@1', 'task:7>org:o1@2', 'task:8>project:p2@1']);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('lists the registered types and accepts their rows only', async () => {
        expect(adapter.types).to.include.members(['task', 'user']);
        expect(adapter.accepts({})).to.equal(false);
        const loaded = (await adapter.load({ type: 'task', id: '7' })) as ModelBase;
        expect(adapter.accepts(loaded)).to.equal(true);
        expect(adapter.refOf(loaded)).to.deep.equal({ type: 'task', id: '7' });
      });

      it('ancestors: self, the table rows by depth, GLOBAL; null for an unknown row; type level for a ref without id', async () => {
        expect(await adapter.ancestors({ type: 'task', id: '7' })).to.deep.equal([{ type: 'task', id: '7' }, { type: 'project', id: 'p1' }, { type: 'org', id: 'o1' }, GLOBAL]);
        expect(await adapter.ancestors({ type: 'user', id: 'u1' })).to.deep.equal([{ type: 'user', id: 'u1' }, GLOBAL]);
        expect(await adapter.ancestors({ type: 'task', id: '99' })).to.equal(null);
        expect(await adapter.ancestors({ type: 'task', id: 'not-a-number' })).to.equal(null);
        expect(await adapter.ancestors({ type: 'task' })).to.deep.equal([{ type: 'task' }, GLOBAL]);
      });

      it('ancestorsMany answers a batch by resourceKey', async () => {
        const out = await adapter.ancestorsMany!([{ type: 'task', id: '7' }, { type: 'task', id: '8' }, { type: 'task', id: '9' }, { type: 'user', id: 'u1' }]);
        expect([...out.keys()].sort()).to.deep.equal(['task:7', 'task:8', 'task:9', 'user:u1']);
        expect(out.get('task:8')).to.deep.equal([{ type: 'task', id: '8' }, { type: 'project', id: 'p2' }, GLOBAL]);
        expect(out.get('task:9')).to.equal(null);
      });

      it('load and loadMany read rows by resourceKey; the caller keeps its principal', async () => {
        const row = (await adapter.load({ type: 'task', id: '7' })) as ModelBase & { title: string };
        expect(row.title).to.equal('a');
        expect(currentPrincipal()).to.not.equal(SYSTEM);
        const many = await adapter.loadMany!([{ type: 'task', id: '7' }, { type: 'task', id: '8' }, { type: 'task', id: '42' }]);
        expect([...many.keys()].sort()).to.deep.equal(['task:7', 'task:8']);
        expect(await adapter.load({ type: 'task', id: '42' })).to.equal(null);
      });

      it('relations: owner and self compare the column with a user id', async () => {
        const rels = adapter.relations();
        const owner = rels.find((r) => r.type === 'task' && r.relation === 'owner')!;
        const self = rels.find((r) => r.type === 'user' && r.relation === 'self')!;
        expect(await owner.holds(user('alice'), { type: 'task', id: '7' })).to.equal(true);
        expect(await owner.holds(user('bob'), { type: 'task', id: '7' })).to.equal(false);
        expect(await owner.holds(agent, { type: 'task', id: '7' })).to.equal(false);
        expect(await owner.holds(user('alice'), { type: 'task', id: '404' })).to.equal(false);
        expect(await self.holds(user('alice'), { type: 'user', id: 'u1' })).to.equal(true);
        expect(await self.holds(user('bob'), { type: 'user', id: 'u1' })).to.equal(false);
        expect(rels.some((r) => r.type === 'user' && r.relation === 'owner')).to.equal(false);
      });

      it('relations: an owner with a type column holds for that principal type only', async () => {
        const Job = await db.define({ name: 'Job', columns: { InitiatorId: 'TEXT', InitiatorType: 'TEXT' }, rows: [{ id: 'j1', InitiatorId: 'alice', InitiatorType: 'agent' }] }, dialect);
        registerAccessResource(Job as never, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });
        const owner = adapter.relations().find((r) => r.type === 'job' && r.relation === 'owner')!;
        expect(await owner.holds(agent, { type: 'job', id: 'j1' })).to.equal(true);
        expect(await owner.holds(user('alice'), { type: 'job', id: 'j1' })).to.equal(false);
      });

      it('permissions: <type>:read|create|update|delete per type', () => {
        const names = adapter.permissions().map((p) => p.name);
        expect(names).to.include.members(['task:read', 'task:create', 'task:update', 'task:delete', 'user:read']);
        expect(adapter.permissions().find((p) => p.name === 'task:read')).to.deep.equal({ name: 'task:read', resource: 'task', action: 'read', types: ['task'] });
      });

      it('refOf refuses a row without a primary key value', () => {
        const blank = new (Task as unknown as new () => ModelBase)();
        expect(() => adapter.refOf(blank)).to.throw(AuthzConfigError, /primary key/);
      });
    });
  }
});
```

Replace the second test's first three lines (the `row` lookup that tries `.unscoped`) with nothing if L4 is not merged yet; the version above tolerates both (`?.`), and the test asserts only through `adapter.load`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/adapter.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/adapter.js'`.

- [ ] **Step 3: Write `src/ids.ts`**

```ts
import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import { extractModelDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { nameOf } from './registry.js';
import type { ModelClass } from './registry.js';

export const refKey = resourceKey;

/** A hydrated id as the text authz_resource_ancestor and the list SQL (CAST AS TEXT) hold. */
export function idText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return value.toString();
  return undefined;
}

const NUMERIC = /int|serial|number|numeric|decimal|real|float|double/i;
const UUID_TYPE = /^(uuid|uniqueidentifier)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * The value to look `id` up by in `column`, or undefined when no row can have it: binding 'abc'
 * against an integer or uuid column is a cast error on PostgreSQL, not a miss.
 */
export function idLookup(model: ModelClass, column: string, id: string): string | number | undefined {
  const c = extractModelDescriptor(model as never)?.Columns?.find((x) => x.Name === column);
  const type = String(c?.NativeType ?? c?.Type ?? '');
  if (UUID_TYPE.test(type)) return UUID.test(id) ? id : undefined;
  if (NUMERIC.test(type)) {
    if (!INTEGER.test(id)) return undefined;
    const n = Number(id);
    return Number.isSafeInteger(n) ? n : id;
  }
  return id;
}

export function tableOf(model: ModelClass): string {
  const t = extractModelDescriptor(model as never)?.TableName;
  if (typeof t !== 'string' || t === '') throw new AuthzConfigError(`authz-orm: ${nameOf(model)} has no table`);
  return t;
}

export function driverOf(model: ModelClass): OrmDriver {
  const d = extractModelDescriptor(model as never)?.Driver as OrmDriver | undefined;
  if (!d) throw new AuthzConfigError(`authz-orm: ${nameOf(model)} has no ORM connection yet (is the ORM booted?)`);
  return d;
}
```

- [ ] **Step 4: Write `src/rows.ts`**

```ts
import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';

import { ID_CHUNK, chunks } from './ancestors/table.js';
import { idLookup, idText, refKey } from './ids.js';
import { classesOf, entryOf } from './registry.js';
import type { ModelClass } from './registry.js';

export interface FoundRow {
  readonly model: ModelClass;
  readonly row: ModelBase;
}

type Queryable = typeof ModelBase & { query(): { whereIn(column: string, values: unknown[]): Promise<ModelBase[]> } };

/**
 * Rows of `refs` by resourceKey, loaded as SYSTEM: per type, the classes of the type in registration
 * order, one query per class and id chunk; the first class that has an id wins.
 */
export async function findRows(refs: readonly ResourceRef[]): Promise<Map<string, FoundRow>> {
  const out = new Map<string, FoundRow>();
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (r.id === undefined || r.id === null) continue;
    const ids = byType.get(r.type) ?? new Set<string>();
    ids.add(String(r.id));
    byType.set(r.type, ids);
  }
  await runWithPrincipal(SYSTEM, async () => {
    for (const [type, ids] of byType) {
      for (const cls of classesOf(type)) {
        const entry = entryOf(cls)!;
        const wanted = [...ids].filter((id) => !out.has(refKey({ type, id })));
        const values = wanted.map((id) => idLookup(cls, entry.idColumn, id)).filter((v) => v !== undefined);
        for (const part of chunks(values, ID_CHUNK)) {
          if (part.length === 0) continue;
          const rows = await (cls as Queryable).query().whereIn(entry.idColumn, part);
          for (const row of rows) {
            const id = idText((row as unknown as Record<string, unknown>)[entry.idColumn]);
            if (id !== undefined && ids.has(id) && !out.has(refKey({ type, id }))) out.set(refKey({ type, id }), { model: cls, row });
          }
        }
      }
    }
  });
  return out;
}
```

- [ ] **Step 5: Write `src/ancestors/read.ts`**

```ts
import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

import { ANCESTOR_COLUMNS, AUTHZ_RESOURCE_ANCESTOR_TABLE, ID_CHUNK, chunks } from './table.js';
import type { AncestorRow } from './table.js';

type Where = IWhereBuilder<unknown>;

/** Ids of the refs that have one, by type. */
export function groupIds(refs: readonly ResourceRef[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of refs) {
    if (r.id === undefined || r.id === null) continue;
    const ids = out.get(r.type) ?? [];
    if (!ids.includes(String(r.id))) ids.push(String(r.id));
    out.set(r.type, ids);
  }
  return out;
}

/** `(typeColumn = t1 AND idColumn IN (…)) OR (typeColumn = t2 AND …)` as one where group. */
export function whereRefs(q: Where, typeColumn: string, idColumn: string, groups: ReadonlyMap<string, readonly string[]>): void {
  q.where(function (this: Where) {
    let first = true;
    for (const [type, ids] of groups) {
      const clause = function (this: Where) {
        this.where(typeColumn, type).whereIn(idColumn, [...ids]);
      };
      if (first) this.where(clause as never);
      else this.orWhere(clause as never);
      first = false;
    }
  } as never);
}

export const byDepth = (a: AncestorRow, b: AncestorRow): number => a.depth - b.depth || (a.ancestor_type < b.ancestor_type ? -1 : a.ancestor_type > b.ancestor_type ? 1 : 0) || (a.ancestor_id < b.ancestor_id ? -1 : a.ancestor_id > b.ancestor_id ? 1 : 0);

function split(refs: readonly ResourceRef[]): Map<string, string[]>[] {
  const out: Map<string, string[]>[] = [];
  for (const [type, ids] of groupIds(refs)) for (const part of chunks(ids, ID_CHUNK)) out.push(new Map([[type, part]]));
  return out;
}

/** The table rows of each ref (as resource), by resourceKey, nearest first. */
export async function readAncestors(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<Map<string, AncestorRow[]>> {
  const out = new Map<string, AncestorRow[]>();
  for (const groups of split(refs)) {
    const q = driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).columns([...ANCESTOR_COLUMNS]);
    whereRefs(q as unknown as Where, 'resource_type', 'resource_id', groups);
    for (const raw of (await q) as Record<string, unknown>[]) {
      const row: AncestorRow = { resource_type: String(raw.resource_type), resource_id: String(raw.resource_id), ancestor_type: String(raw.ancestor_type), ancestor_id: String(raw.ancestor_id), depth: Number(raw.depth) };
      const key = resourceKey({ type: row.resource_type, id: row.resource_id });
      const list = out.get(key) ?? [];
      list.push(row);
      out.set(key, list);
    }
  }
  for (const list of out.values()) list.sort(byDepth);
  return out;
}
```

Append to `packages/authz-orm/src/ancestors/index.ts`:

```ts
export { readAncestors } from './read.js';
```

- [ ] **Step 6: Write `src/relations.ts`**

```ts
import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef, ResourceType } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';

import { idText, refKey } from './ids.js';
import { classesOf, entryOf, registeredTypes } from './registry.js';
import { findRows } from './rows.js';

type Row = ModelBase & Record<string, unknown>;

/** The subject when it is the row of `ref`, else that row loaded as SYSTEM; null when there is none. */
async function rowFor(type: ResourceType, ref: ResourceRef, subject: unknown): Promise<Row | null> {
  if (ref.id === undefined || ref.id === null) return null;
  if (subject instanceof ModelBase) {
    const entry = entryOf(subject.constructor);
    if (entry?.type === type && idText((subject as Row)[entry.idColumn]) === String(ref.id)) return subject as Row;
  }
  return ((await findRows([ref])).get(refKey(ref))?.row as Row | undefined) ?? null;
}

class ColumnRelation extends RelationResolver {
  constructor(readonly type: ResourceType, readonly relation: 'owner' | 'self') {
    super();
  }

  async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    if (typeof principal?.type !== 'string' || typeof principal.id !== 'string') return false;
    const row = await rowFor(this.type, ref, subject);
    if (row === null) return false;
    const entry = entryOf(row.constructor)!;
    if (this.relation === 'self') return principal.type === 'user' && entry.self !== undefined && idText(row[entry.self.column]) === principal.id;
    const owner = entry.owner;
    if (owner === undefined || idText(row[owner.column]) !== principal.id) return false;
    // Without a type column the owner column holds user ids (design §5).
    return owner.typeColumn === undefined ? principal.type === 'user' : row[owner.typeColumn] === principal.type;
  }
}

/** `owner` per type with an owner column, `self` per type with a self column. */
export function ormRelations(): readonly RelationResolver[] {
  const out: RelationResolver[] = [];
  for (const type of registeredTypes()) {
    const entries = classesOf(type).map((c) => entryOf(c)!);
    if (entries.some((e) => e.owner !== undefined)) out.push(new ColumnRelation(type, 'owner'));
    if (entries.some((e) => e.self !== undefined)) out.push(new ColumnRelation(type, 'self'));
  }
  return out;
}
```

- [ ] **Step 7: Write `src/adapter.ts`**

```ts
import { AuthzConfigError, GLOBAL, ResourceAdapter, parsePermission, requestScope } from '@spinajs/authz';
import type { PermissionDef, RelationResolver, ResourceRef, ResourceType } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { readAncestors } from './ancestors/read.js';
import { driverOf, idText, refKey } from './ids.js';
import { classesOf, entryOf, registeredTypes } from './registry.js';
import { ormRelations } from './relations.js';
import { findRows } from './rows.js';

const MEMO = 'authz-orm:';
const KINDS = ['read', 'create', 'update', 'delete'] as const;

/** Memoised per request store (none outside a store); a rejection is not kept. */
function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  let cache: Map<string, unknown> | undefined;
  try {
    cache = requestScope().cache;
  } catch {
    cache = undefined;
  }
  if (cache === undefined) return load();
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit !== undefined) return hit;
  const p = load();
  cache.set(key, p);
  p.catch(() => {
    if (cache!.get(key) === p) cache!.delete(key);
  });
  return p;
}

const typeLevel = (ref: ResourceRef): readonly ResourceRef[] => Object.freeze([Object.freeze({ type: ref.type }), GLOBAL]);

@Singleton()
@Injectable(ResourceAdapter)
export class OrmResourceAdapter extends ResourceAdapter<ModelBase> {
  readonly kind = 'orm';

  // A live view of the registry: tests and apps register models after the adapter exists. The base
  // class declares it as a property, so the getter goes on the instance.
  declare readonly types: readonly ResourceType[];

  constructor() {
    super();
    Object.defineProperty(this, 'types', { get: () => registeredTypes(), enumerable: true });
  }

  accepts(target: unknown): target is ModelBase {
    return target instanceof ModelBase && entryOf(target.constructor) !== undefined;
  }

  refOf(target: ModelBase): ResourceRef {
    const entry = entryOf(target.constructor);
    if (!entry) throw new AuthzConfigError(`authz-orm: ${target?.constructor?.name} is not an @AccessResource model`);
    const id = idText((target as unknown as Record<string, unknown>)[entry.idColumn]);
    if (id === undefined) throw new AuthzConfigError(`authz-orm: a ${entry.type} row without a primary key value has no ref`);
    return { type: entry.type, id };
  }

  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (ref.id === undefined || ref.id === null) return Promise.resolve(typeLevel(ref));
    return memo(`${MEMO}ancestors:${refKey(ref)}`, async () => (await this.ancestorsMany([ref])).get(refKey(ref)) ?? null);
  }

  async ancestorsMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, readonly ResourceRef[] | null>> {
    const out = new Map<string, readonly ResourceRef[] | null>();
    const nodes: ResourceRef[] = [];
    for (const r of refs) {
      if (r.id === undefined || r.id === null) out.set(refKey(r), typeLevel(r));
      else nodes.push({ type: r.type, id: String(r.id) });
    }
    const found = await findRows(nodes);
    const byDriver = new Map<OrmDriver, ResourceRef[]>();
    for (const n of nodes) {
      const f = found.get(refKey(n));
      if (!f) continue;
      const d = driverOf(f.model);
      byDriver.set(d, [...(byDriver.get(d) ?? []), n]);
    }
    const rows = new Map<string, readonly { ancestor_type: string; ancestor_id: string }[]>();
    for (const [driver, list] of byDriver) for (const [k, v] of await readAncestors(driver, list)) rows.set(k, v);
    for (const n of nodes) {
      const key = refKey(n);
      if (!found.has(key)) {
        out.set(key, null);
        continue;
      }
      const chain = [{ type: n.type, id: n.id }, ...(rows.get(key) ?? []).map((a) => ({ type: a.ancestor_type, id: a.ancestor_id })), GLOBAL];
      out.set(key, Object.freeze(chain.map((r) => Object.freeze(r))));
    }
    return out;
  }

  load(ref: ResourceRef): Promise<unknown | null> {
    if (ref.id === undefined || ref.id === null) return Promise.resolve(null);
    return memo(`${MEMO}row:${refKey(ref)}`, async () => (await findRows([ref])).get(refKey(ref))?.row ?? null);
  }

  async loadMany(refs: readonly ResourceRef[]): Promise<ReadonlyMap<string, unknown>> {
    const out = new Map<string, unknown>();
    for (const [key, f] of await findRows(refs)) out.set(key, f.row);
    return out;
  }

  relations(): readonly RelationResolver[] {
    return ormRelations();
  }

  permissions(): readonly Omit<PermissionDef, 'source'>[] {
    // One def per name; a name several types use lists them all.
    const out = new Map<string, { name: string; resource: string; action: string; types: ResourceType[] }>();
    for (const type of registeredTypes()) {
      if (classesOf(type).length === 0) continue;
      for (const kind of KINDS) {
        const name = `${type}:${kind}`;
        const def = out.get(name);
        if (def === undefined) out.set(name, { name, ...parsePermission(name), types: [type] });
        else if (!def.types.includes(type)) def.types.push(type);
      }
    }
    return [...out.values()];
  }
}
```

Note: a type name that is not a valid permission resource (it must match `[A-Za-z][A-Za-z0-9_.-]*`) makes `parsePermission` throw `AuthzConfigError` at boot, as before.

- [ ] **Step 8: Export the adapter**

Append to `packages/authz-orm/src/index.ts`:

```ts
export { OrmResourceAdapter } from './adapter.js';
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/adapter.test.ts`
Expected: PASS, `17 passing` with Postgres up (`9 passing, 8 pending` without: the DI test, plus 8 per dialect).

- [ ] **Step 10: Commit**

```bash
git add packages/authz-orm/src packages/authz-orm/test/adapter.test.ts
git commit -m "feat(authz-orm): OrmResourceAdapter over authz_resource_ancestor"
```

---

### Task 4: Closure engine (compute and rewrite ancestor rows)

**Files:**
- Create: `packages/authz-orm/src/ancestors/closure.ts`, `src/ancestors/store.ts`, `src/ancestors/rebuild.ts`
- Modify: `packages/authz-orm/src/ancestors/index.ts`
- Test: `packages/authz-orm/test/ancestors/closure.test.ts`, `test/ancestors/rebuild.test.ts`

**Interfaces:**
- Consumes: `readAncestors`, `whereRefs`, `groupIds` (Task 3); `classesOf`, `entryOf` (Task 1); `idLookup`, `idText`, `tableOf` (Task 3).
- Produces:
  - `Link = { type: string; id: string; depth: number }`; `closeOver(nodes, parents, outside, gone?): Map<string, Link[]>` (throws `AuthzConfigError` on a `@Parent` cycle).
  - `readDescendants(driver, refs): Promise<ResourceRef[]>`, `readParents(driver, refs): Promise<Map<string, ResourceRef[]>>`, `deleteRowsOf(driver, refs)`, `replaceAncestors(driver, nodes, closure)` in `store.ts`.
  - `rebuildFrom(driver, roots): Promise<number>` (roots and their descendants; returns nodes rewritten), `rebuildNodes(driver, nodes, gone?)`, `removeNodes(driver, deleted): Promise<void>` (design §6.4 steps 1–2) in `rebuild.ts`. All writes go through `driver`: the caller's transaction, if any, carries them.

- [ ] **Step 1: Write the failing tests**

Create `packages/authz-orm/test/ancestors/closure.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

import { closeOver } from '../../src/ancestors/closure.js';
import type { Link } from '../../src/ancestors/closure.js';

const expect = chai.expect;
const r = (s: string): ResourceRef => ({ type: s.split(':')[0], id: s.split(':')[1] });
const show = (m: Map<string, Link[]>) => Object.fromEntries([...m].map(([k, v]) => [k, v.map((l) => `${l.type}:${l.id}@${l.depth}`)]));

describe('closeOver', () => {
  it('walks parents in the node set and reads the rest from `outside`', () => {
    const out = closeOver(
      [r('task:1'), r('project:p')],
      new Map([
        ['task:1', [r('project:p')]],
        ['project:p', [r('org:o')]],
      ]),
      new Map([['org:o', [{ type: 'tenant', id: 't', depth: 1 }]]]),
    );
    expect(show(out)).to.deep.equal({ 'task:1': ['project:p@1', 'org:o@2', 'tenant:t@3'], 'project:p': ['org:o@1', 'tenant:t@2'] });
  });

  it('keeps the smallest depth when two parent chains meet, sorted by depth then key', () => {
    const out = closeOver([r('task:1')], new Map([['task:1', [r('project:p'), r('sprint:s')]]]), new Map([
      ['project:p', [{ type: 'org', id: 'o', depth: 1 }]],
      ['sprint:s', [{ type: 'board', id: 'b', depth: 1 }, { type: 'org', id: 'o', depth: 2 }]],
    ]));
    expect(show(out)['task:1']).to.deep.equal(['project:p@1', 'sprint:s@1', 'board:b@2', 'org:o@2']);
  });

  it('skips parents that are gone, which makes their children roots', () => {
    const out = closeOver([r('task:1')], new Map([['task:1', [r('project:p')]]]), new Map([['project:p', [{ type: 'org', id: 'o', depth: 1 }]]]), new Set(['project:p']));
    expect(show(out)).to.deep.equal({ 'task:1': [] });
  });

  it('refuses a cycle, including a self-parent', () => {
    expect(() => closeOver([r('folder:a'), r('folder:b')], new Map([['folder:a', [r('folder:b')]], ['folder:b', [r('folder:a')]]]), new Map())).to.throw(AuthzConfigError, /cycle/);
    expect(() => closeOver([r('folder:a')], new Map([['folder:a', [r('folder:a')]]]), new Map())).to.throw(AuthzConfigError, /cycle/);
  });
});
```

Create `packages/authz-orm/test/ancestors/rebuild.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { ModelBase } from '@spinajs/orm';

import { rebuildFrom, removeNodes } from '../../src/ancestors/rebuild.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

describe('ancestor rebuild', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Project: typeof ModelBase;
      let Folder: typeof ModelBase;
      let Task: typeof ModelBase;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Project = await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, rows: [{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o2' }], decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect);
        Folder = await db.define({ name: 'Folder', columns: { project_id: 'TEXT', parent_id: 'TEXT' }, rows: [{ id: 'f1', project_id: 'p1', parent_id: null }, { id: 'f2', project_id: 'p1', parent_id: 'f1' }], decorate: (c, p) => { AccessResource('folder')(c); Parent('project')(p, 'project_id'); Parent('folder', { nullable: true })(p, 'parent_id'); } }, dialect);
        Task = await db.define({ name: 'Task', columns: { id: 'INTEGER', folder_id: 'TEXT' }, rows: [{ id: 1, folder_id: 'f2' }], decorate: (c, p) => { AccessResource('task')(c); Parent('folder')(p, 'folder_id'); } }, dialect);
        void Project;
        void Folder;
        void Task;
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('rebuildFrom writes the closure of the roots and of every descendant the table knows', async () => {
        const d = db.driver(dialect);
        await rebuildFrom(d, [{ type: 'project', id: 'p1' }, { type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }, { type: 'task', id: '1' }]);
        expect(await ancestorLinks(d)).to.deep.equal(
          ['folder:f1>org:o1@2', 'folder:f1>project:p1@1', 'folder:f2>folder:f1@1', 'folder:f2>org:o1@2', 'folder:f2>project:p1@1', 'project:p1>org:o1@1', 'task:1>folder:f1@2', 'task:1>folder:f2@1', 'task:1>org:o1@3', 'task:1>project:p1@2'].sort(),
        );

        // move both folders to p2: the subtree (f2, task 1) follows f1
        await db.raw(`UPDATE "${db.table(Folder)}" SET project_id = 'p2'`, [], dialect);
        await rebuildFrom(d, [{ type: 'project', id: 'p2' }]);
        await rebuildFrom(d, [{ type: 'folder', id: 'f1' }]);
        const links = await ancestorLinks(d);
        expect(links).to.include.members(['folder:f1>project:p2@1', 'folder:f1>org:o2@2', 'task:1>project:p2@2', 'task:1>org:o2@3']);
        expect(links.some((l) => l.includes('>project:p1@') || (l.startsWith('folder:') && l.includes('>org:o1@')) || l.startsWith('task:1>org:o1'))).to.equal(false);
      });

      it('refuses a reparent into its own subtree', async () => {
        const d = db.driver(dialect);
        await rebuildFrom(d, [{ type: 'folder', id: 'f1' }, { type: 'folder', id: 'f2' }]);
        await db.raw(`UPDATE "${db.table(Folder)}" SET parent_id = 'f2' WHERE id = 'f1'`, [], dialect);
        let err: unknown;
        try {
          await rebuildFrom(d, [{ type: 'folder', id: 'f1' }]);
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/cycle/);
      });

      it('removeNodes drops the rows of the deleted and turns their undeleted children into roots', async () => {
        const d = db.driver(dialect);
        await insertLinks(d, ['project:p1>org:o1@1', 'folder:f1>project:p1@1', 'folder:f1>org:o1@2', 'folder:f2>folder:f1@1', 'folder:f2>project:p1@1', 'folder:f2>org:o1@2', 'task:1>folder:f2@1', 'task:1>folder:f1@2', 'task:1>project:p1@2', 'task:1>org:o1@3']);
        await db.raw(`DELETE FROM "${db.table(Folder)}" WHERE id = 'f1'`, [], dialect);
        await removeNodes(d, [{ type: 'folder', id: 'f1' }]);
        expect(await ancestorLinks(d)).to.deep.equal(['folder:f2>org:o1@2', 'folder:f2>project:p1@1', 'project:p1>org:o1@1', 'task:1>folder:f2@1', 'task:1>org:o1@3', 'task:1>project:p1@2']);
      });
    });
  }
});
```

Note on the first test: `rebuildFrom` reads parents from the model tables, so the moves are written with raw SQL first (the middleware of Task 5 is what does this on real writes). The `org` type has no model: its rows have no ancestors, so `outside` reads nothing for it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/ancestors/closure.test.ts test/ancestors/rebuild.test.ts`
Expected: FAIL with a TSError `Cannot find module '../../src/ancestors/closure.js'`.

- [ ] **Step 3: Write `src/ancestors/closure.ts`**

```ts
import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';

export interface Link {
  readonly type: string;
  readonly id: string;
  readonly depth: number;
}

const byDepthThenKey = (a: Link, b: Link): number => a.depth - b.depth || (resourceKey(a) < resourceKey(b) ? -1 : resourceKey(a) > resourceKey(b) ? 1 : 0);

/**
 * The proper ancestors of every node: per direct parent p, p at depth 1 and p's ancestors one deeper,
 * the smallest depth winning where chains meet. A parent in `nodes` is computed first (memoised DFS);
 * any other parent's ancestors come from `outside` (the table). Parents in `gone` count as absent.
 */
export function closeOver(nodes: readonly ResourceRef[], parents: ReadonlyMap<string, readonly ResourceRef[]>, outside: ReadonlyMap<string, readonly Link[]>, gone: ReadonlySet<string> = new Set()): Map<string, Link[]> {
  const inNodes = new Set(nodes.map((n) => resourceKey(n)));
  const done = new Map<string, Link[]>();
  const active = new Set<string>();

  const linksOf = (key: string): Link[] => {
    const hit = done.get(key);
    if (hit) return hit;
    if (active.has(key)) throw new AuthzConfigError(`authz-orm: the @Parent links form a cycle through ${key}`);
    active.add(key);
    const best = new Map<string, Link>();
    const add = (l: Link): void => {
      const k = resourceKey(l);
      const prev = best.get(k);
      if (prev === undefined || l.depth < prev.depth) best.set(k, Object.freeze({ type: l.type, id: l.id, depth: l.depth }));
    };
    for (const p of parents.get(key) ?? []) {
      const pk = resourceKey(p);
      if (gone.has(pk)) continue;
      add({ type: p.type, id: String(p.id), depth: 1 });
      const above = inNodes.has(pk) ? linksOf(pk) : outside.get(pk) ?? [];
      for (const a of above) if (!gone.has(resourceKey(a))) add({ type: a.type, id: a.id, depth: a.depth + 1 });
    }
    if (best.has(key)) throw new AuthzConfigError(`authz-orm: the @Parent links form a cycle through ${key}`);
    active.delete(key);
    const out = [...best.values()].sort(byDepthThenKey);
    done.set(key, out);
    return out;
  };

  for (const k of inNodes) linksOf(k);
  return done;
}
```

- [ ] **Step 4: Write `src/ancestors/store.ts`**

```ts
import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { IWhereBuilder, OrmDriver } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import { classesOf, entryOf } from '../registry.js';
import type { Link } from './closure.js';
import { groupIds, whereRefs } from './read.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE, ID_CHUNK, ROW_CHUNK, chunks } from './table.js';
import type { AncestorRow } from './table.js';

type Where = IWhereBuilder<unknown>;

function splitGroups(refs: readonly ResourceRef[]): Map<string, string[]>[] {
  const out: Map<string, string[]>[] = [];
  for (const [type, ids] of groupIds(refs)) for (const part of chunks(ids, ID_CHUNK)) out.push(new Map([[type, part]]));
  return out;
}

/** Every resource the table lists below one of `refs`, once. */
export async function readDescendants(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<ResourceRef[]> {
  const seen = new Map<string, ResourceRef>();
  for (const groups of splitGroups(refs)) {
    const q = driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).columns(['resource_type', 'resource_id']);
    whereRefs(q as unknown as Where, 'ancestor_type', 'ancestor_id', groups);
    for (const row of (await q) as Record<string, unknown>[]) {
      const ref = { type: String(row.resource_type), id: String(row.resource_id) };
      seen.set(resourceKey(ref), ref);
    }
  }
  return [...seen.values()];
}

/**
 * The direct parents of each ref, read from its model's `@Parent` columns through `driver` (the
 * statement's transaction). A ref whose row no class of its type has gets no parents: it becomes a root.
 */
export async function readParents(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<Map<string, ResourceRef[]>> {
  const out = new Map<string, ResourceRef[]>();
  for (const [type, ids] of groupIds(refs)) {
    const tables = new Set<string>();
    for (const cls of classesOf(type)) {
      const entry = entryOf(cls)!;
      const table = tableOf(cls);
      if (entry.parents.length === 0 || tables.has(table)) continue;
      tables.add(table);
      const columns = [entry.idColumn, ...new Set(entry.parents.map((p) => p.column))];
      const values = ids.filter((id) => !out.has(resourceKey({ type, id }))).map((id) => idLookup(cls, entry.idColumn, id)).filter((v) => v !== undefined);
      for (const part of chunks(values, ID_CHUNK)) {
        if (part.length === 0) continue;
        const rows = (await driver.select().from(table).columns(columns).whereIn(entry.idColumn, part)) as Record<string, unknown>[];
        for (const row of rows) {
          const id = idText(row[entry.idColumn]);
          if (id === undefined) continue;
          const list: ResourceRef[] = [];
          for (const p of entry.parents) {
            const parentId = idText(row[p.column]);
            if (parentId !== undefined) list.push({ type: p.type, id: parentId });
          }
          out.set(resourceKey({ type, id }), list);
        }
      }
    }
  }
  return out;
}

/** Deletes the rows whose resource is one of `refs`. */
export async function deleteRowsOf(driver: OrmDriver, refs: readonly ResourceRef[]): Promise<void> {
  for (const groups of splitGroups(refs)) {
    const q = driver.del().from(AUTHZ_RESOURCE_ANCESTOR_TABLE);
    whereRefs(q as unknown as Where, 'resource_type', 'resource_id', groups);
    await q;
  }
}

/** Replaces the rows of `nodes` with `closure` (nodes without an entry get none). */
export async function replaceAncestors(driver: OrmDriver, nodes: readonly ResourceRef[], closure: ReadonlyMap<string, readonly Link[]>): Promise<void> {
  await deleteRowsOf(driver, nodes);
  const rows: AncestorRow[] = [];
  for (const n of nodes) {
    for (const l of closure.get(resourceKey(n)) ?? []) rows.push({ resource_type: n.type, resource_id: String(n.id), ancestor_type: l.type, ancestor_id: l.id, depth: l.depth });
  }
  for (const part of chunks(rows, ROW_CHUNK)) await driver.insert().into(AUTHZ_RESOURCE_ANCESTOR_TABLE).values(part);
}
```

- [ ] **Step 5: Write `src/ancestors/rebuild.ts`**

```ts
import { resourceKey } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { closeOver } from './closure.js';
import type { Link } from './closure.js';
import { readAncestors } from './read.js';
import { deleteRowsOf, readDescendants, readParents, replaceAncestors } from './store.js';

function unique(refs: readonly ResourceRef[], skip: ReadonlySet<string> = new Set()): ResourceRef[] {
  const out = new Map<string, ResourceRef>();
  for (const r of refs) {
    const k = resourceKey(r);
    if (!skip.has(k) && r.id !== undefined && r.id !== null) out.set(k, { type: r.type, id: String(r.id) });
  }
  return [...out.values()];
}

/** Recomputes `nodes` from their `@Parent` columns; parents outside `nodes` contribute their table rows. */
export async function rebuildNodes(driver: OrmDriver, nodes: readonly ResourceRef[], gone: ReadonlySet<string> = new Set()): Promise<number> {
  const list = unique(nodes, gone);
  if (list.length === 0) return 0;
  const keys = new Set(list.map((n) => resourceKey(n)));
  const parents = await readParents(driver, list);
  const outsideRefs = unique([...parents.values()].flat(), new Set([...keys, ...gone]));
  const outside = new Map<string, Link[]>();
  for (const [k, rows] of await readAncestors(driver, outsideRefs)) outside.set(k, rows.map((r) => ({ type: r.ancestor_type, id: r.ancestor_id, depth: r.depth })));
  await replaceAncestors(driver, list, closeOver(list, parents, outside, gone));
  return list.length;
}

/** Recomputes `roots` and every resource the table lists below them (a move, an insert). */
export async function rebuildFrom(driver: OrmDriver, roots: readonly ResourceRef[]): Promise<number> {
  const list = unique(roots);
  if (list.length === 0) return 0;
  return rebuildNodes(driver, [...list, ...(await readDescendants(driver, list))]);
}

/** Design §6.4 steps 1–2: drop the rows of the deleted resources and recompute what was below them without them. */
export async function removeNodes(driver: OrmDriver, deleted: readonly ResourceRef[]): Promise<void> {
  const list = unique(deleted);
  if (list.length === 0) return;
  const gone = new Set(list.map((n) => resourceKey(n)));
  const below = (await readDescendants(driver, list)).filter((d) => !gone.has(resourceKey(d)));
  await deleteRowsOf(driver, list);
  await rebuildNodes(driver, below, gone);
}
```

Append to `packages/authz-orm/src/ancestors/index.ts`:

```ts
export { rebuildFrom, rebuildNodes, removeNodes } from './rebuild.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/ancestors/closure.test.ts test/ancestors/rebuild.test.ts`
Expected: PASS, `10 passing` with Postgres up (`7 passing, 3 pending` without).

- [ ] **Step 7: Commit**

```bash
git add packages/authz-orm/src/ancestors packages/authz-orm/test/ancestors
git commit -m "feat(authz-orm): closure computation and ancestor row rewrite"
```

---

### Task 5: Ancestor maintenance middleware (insert, `@Parent` update, delete clean-up)

**Files:**
- Create: `packages/authz-orm/src/ancestors/commit.ts`, `src/ancestors/targets.ts`, `src/ancestors/cleanup.ts`, `src/ancestors/middleware.ts`
- Modify: `packages/authz-orm/src/index.ts`
- Test: `packages/authz-orm/test/ancestors/middleware.test.ts`

**Interfaces:**
- Consumes: L1: `OrmDriver.afterCommit(cb: () => void | Promise<void>): void` (overview decision 18), `QueryMiddleware.afterQueryExecution?(query, result)` and `transactional?(query): boolean` (overview decision 6; when a middleware answers `true` and `query.Driver.CurrentTransaction` is undefined, the builder runs `before…`, the statement and `after…` in `driver.transaction()`). L2 Task 6: `forgetScopesInTx(container: IContainer, scopes: readonly ResourceRef[], tx: AuthzTx, ctx: { readonly actor: Principal; readonly reason: string }): Promise<{ tags: string[] }>` from `@spinajs/authz` (no version bump, publish or audit: the caller does those). `rebuildFrom`, `removeNodes` (Task 4); `ormDomain`, `domainContainer`, `recordAudit`, `ormLog` (Task 1).
- Produces: `AncestorMiddleware` (`@Injectable(QueryMiddleware)`, `order = 90`); `afterCommit(driver, fn)`; `insertedRefs(query, result, entry)`; `targetRefs(query, model, entry)`; `cleanupDeleted(driver, deleted)`.
- Decisions recorded here:
  - **Post-commit work** uses L1's `driver.afterCommit(cb)` (overview decision 18: run after the outermost commit, dropped on rollback, at once outside a transaction). `commit.ts` only wraps it so a failure is logged, never thrown: the data is committed by then.
  - **Where the clean-up runs** (overview decision 20). The admin backend is the one `authz.admin.backend` names (default `MemoryAuthzAdminBackend`, `packages/authz/src/admin/config.ts:17`), resolved by class name as `DefaultAuthzAdmin.named` does (`admin.ts:431-441`):
    - `DbAuthzAdminBackend`: `forgetScopesInTx(container, deleted, { driver: query.Driver }, …)` inside the statement's transaction; the DB stores bump `authz_version` in their own forget writes (`db-assignment-store.ts` `deleteWhere`, scope attributes `db-store.ts`). The backend is compared by name, so authz-orm needs no dependency on authz-rbac.
    - any other backend (memory, custom): after the ORM commit, `backend.transaction(domain, async (tx) => { forgetScopesInTx(container, deleted, tx, …); backend.bumpVersion(domain, tx) })`, best effort: a failure is logged, the delete stays committed.
    - Either way, `AuthzChange` and one `system` audit entry per deleted resource follow the forget, after commit.
  - **Insert ids.** Mirrors the ORM's own key backfill (`packages/orm/src/model.ts:1349-1381`): supplied primary keys, else `Returning` rows (model inserts ask for `RETURNING` where the driver supports it), else `LastInsertId` for one row, else `LastInsertId + k` when `supportedFeatures().insertIdIsFirstOfBatch`. Otherwise the rows are skipped with one warning per model ("a missing row only narrows access", design §6.4); `authz:ancestors-rebuild` fixes them.
  - **Transactions.** `transactional()` is true for a `@Parent` update, any delete of an `@AccessResource` model, and an insert of a `@Parent` model with `orIgnore` / `orReplace` / `onDuplicate` (those can rewrite existing rows). A plain insert is allowed outside one. When the hook was answered `true` and still no transaction is in scope at `beforeQueryExecution`, the write is refused with `AuthzConfigError` (design §6.4).
  - **Model builders only.** A raw `driver.insert().into('task')` has no `Model`; it is not maintained (document in README).

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/ancestors/middleware.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, ChangeBus, DecisionAudit, SYSTEM, ScopeForgetter } from '@spinajs/authz';
import type { AdminContext, AuthzChange, AuthzEvent, AuthzTx, ResourceRef } from '@spinajs/authz';
import { RecordingAudit, RecordingChangeBus, testHost } from '@spinajs/authz-testing';
import { InsertBehaviour, OrmDriver, QueryMiddleware } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';
import { DI } from '@spinajs/di';

import { AncestorMiddleware } from '../../src/ancestors/middleware.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable } from '../support/ancestors.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[], b?: InsertBehaviour): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> } & Promise<unknown>; destroy(pk: unknown): Promise<unknown> };
const ticks = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

class RecordingForgetter extends ScopeForgetter {
  readonly calls: { scope: ResourceRef; reason: string | undefined; ormTx: boolean }[] = [];
  async forget(scope: ResourceRef, ctx: AdminContext, tx: AuthzTx): Promise<{ affected: number; tags: readonly string[]; events: readonly AuthzEvent[] }> {
    this.calls.push({ scope, reason: ctx.reason, ormTx: tx.driver instanceof OrmDriver && tx.driver.CurrentTransaction !== undefined });
    return { affected: 1, tags: [`test:${scope.type}:${scope.id}`], events: [] };
  }
}

describe('AncestorMiddleware', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let forgetter: RecordingForgetter;
  let bus: RecordingChangeBus;
  let audit: RecordingAudit;
  const published: { change: AuthzChange; inTx: boolean }[] = [];
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    forgetter = new RecordingForgetter();
    bus = new RecordingChangeBus();
    audit = new RecordingAudit();
    published.length = 0;
    undo.push(testHost.registerInRoot(ScopeForgetter, testHost.instance(forgetter)));
    undo.push(testHost.registerInRoot(ChangeBus, testHost.instance(bus)));
    undo.push(testHost.registerInRoot(DecisionAudit, testHost.instance(audit)));
    await (await testHost.domains()).service('root');
  });

  // Not resetHost: it would also empty the config TestDb put its connections in.
  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) fn();
    await testHost.resetRoot();
  });

  it('is a QueryMiddleware at order 90', () => {
    expect(DI.getRegisteredTypes(QueryMiddleware)).to.include(AncestorMiddleware);
    expect(new AncestorMiddleware().order).to.equal(90);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Project: M;
      let Task: M;
      let driver: OrmDriver;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createAncestorTable(db, dialect);
        Project = (await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M;
        Task = (await db.define({ name: 'Task', columns: { id: 'INTEGER', project_id: 'TEXT', title: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        bus.subscribe((change) => published.push({ change, inTx: driver.CurrentTransaction !== undefined }));
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o2' }]);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('an insert writes the parent and its ancestors, one deeper', async () => {
        await Task.insert({ title: 'a', project_id: 'p1' });
        await Task.insert([{ id: 20, title: 'b', project_id: 'p2' }, { id: 21, title: 'c', project_id: null }]);
        const links = await ancestorLinks(driver);
        expect(links).to.include.members(['project:p1>org:o1@1', 'project:p2>org:o2@1', 'task:20>project:p2@1', 'task:20>org:o2@2']);
        const first = links.filter((l) => l.startsWith('task:') && !l.startsWith('task:20') && !l.startsWith('task:21'));
        expect(first.map((l) => l.replace(/^task:\d+/, 'task:*'))).to.deep.equal(['task:*>org:o1@2', 'task:*>project:p1@1']);
        expect(links.some((l) => l.startsWith('task:21>'))).to.equal(false);
      });

      it('an update of a @Parent column moves the row and its subtree in one transaction', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        await Task.update({ project_id: 'p2' }).where('id', 1);
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o2@2', 'task:1>project:p2@1']);
        await Project.update({ org_id: 'o9' }).where('id', 'p2');
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o9@2', 'task:1>project:p2@1']);
      });

      it('an update that leaves the @Parent columns alone touches nothing and needs no transaction', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        const mw = new AncestorMiddleware();
        const q = Task.update({ title: 'b' }) as unknown as Parameters<AncestorMiddleware['transactional']>[0];
        expect(mw.transactional(q)).to.equal(false);
        await (q as unknown as Promise<unknown>);
        expect((await ancestorLinks(driver)).filter((l) => l.startsWith('task:1>'))).to.deep.equal(['task:1>org:o1@2', 'task:1>project:p1@1']);
      });

      const useBackend = (name: string) => {
        testHost.config().set(['authz', 'admin', 'backend'], name);
        undo.push(() => testHost.config().unset(['authz', 'admin', 'backend']));
      };

      it('with DbAuthzAdminBackend a delete forgets in the statement transaction and publishes after the commit', async () => {
        useBackend('DbAuthzAdminBackend');
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        await Project.destroy('p1');
        expect(await ancestorLinks(driver)).to.deep.equal(['project:p2>org:o2@1']);
        expect(forgetter.calls).to.deep.equal([{ scope: { type: 'project', id: 'p1' }, reason: 'resource-deleted', ormTx: true }]);
        await ticks();
        expect(published).to.have.length(1);
        expect(published[0].inTx).to.equal(false);
        expect(published[0].change.tags).to.include.members(['test:project:p1', 'scope:project:p1']);
        expect(published[0].change.actor).to.deep.equal({ type: SYSTEM.type, id: SYSTEM.id });
        expect(audit.of('system')).to.deep.equal([{ kind: 'system', principal: { type: SYSTEM.type, id: SYSTEM.id }, resource: { type: 'project', id: 'p1' }, reason: 'resource-deleted' }]);
      });

      it('with the memory backend (default) the forget runs after the commit in its transaction, then publishes', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        await Project.destroy('p1');
        await ticks();
        expect(await ancestorLinks(driver)).to.deep.equal(['project:p2>org:o2@1']);
        expect(forgetter.calls).to.deep.equal([{ scope: { type: 'project', id: 'p1' }, reason: 'resource-deleted', ormTx: false }]);
        expect(published).to.have.length(1);
        expect(published[0].change.tags).to.include.members(['test:project:p1', 'scope:project:p1']);
      });

      it('a rolled-back delete keeps the rows and publishes nothing', async () => {
        await Task.insert({ id: 1, title: 'a', project_id: 'p1' });
        const before = await ancestorLinks(driver);
        try {
          await driver.transaction(async () => {
            await Task.destroy(1);
            throw new Error('roll back');
          });
        } catch (e) {
          expect((e as Error).message).to.equal('roll back');
        }
        await ticks();
        expect(await ancestorLinks(driver)).to.deep.equal(before);
        expect(forgetter.calls, 'the memory backend forgets only after a commit').to.deep.equal([]);
        expect(published).to.deep.equal([]);
      });

      it('a delete that reaches nothing forgets nothing', async () => {
        await Task.destroy(999);
        await ticks();
        expect(forgetter.calls).to.deep.equal([]);
        expect(published).to.deep.equal([]);
      });

      it('refuses a @Parent update when no transaction could be opened', async () => {
        const mw = new AncestorMiddleware();
        const q = Task.update({ project_id: 'p2' }) as unknown as Parameters<AncestorMiddleware['beforeQueryExecution']>[0];
        let err: unknown;
        try {
          await mw.beforeQueryExecution(q);
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect((err as Error).message).to.match(/transaction/);
      });
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/ancestors/middleware.test.ts`
Expected: FAIL with a TSError `Cannot find module '../../src/ancestors/middleware.js'`.

- [ ] **Step 3: Write `src/ancestors/commit.ts`**

```ts
import type { OrmDriver } from '@spinajs/orm';

import { ormLog } from '../host.js';

/** L1's driver.afterCommit; the data is committed when `fn` runs, so its failure is logged, not thrown. */
export function afterCommit(driver: OrmDriver, what: string, fn: () => Promise<void>): void {
  driver.afterCommit(async () => {
    try {
      await fn();
    } catch (e) {
      ormLog().error(`authz-orm: ${what} after a committed delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
```

- [ ] **Step 4: Write `src/ancestors/targets.ts`**

```ts
import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { SelectQueryBuilder, createQuery } from '@spinajs/orm';
import type { DeleteQueryBuilder, IQueryStatement, InsertQueryBuilder, OrmDriver, UpdateQueryBuilder } from '@spinajs/orm';

import { idLookup, idText, tableOf } from '../ids.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { ID_CHUNK, chunks } from './table.js';

const refsOf = (type: string, ids: readonly unknown[]): ResourceRef[] => [...new Set(ids.map((v) => idText(v)).filter((v): v is string => v !== undefined))].map((id) => ({ type, id }));

/** The ids an update or delete reaches: a select with its where statements, as SYSTEM, soft-deleted and archived rows included. */
export function targetRefs(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>, model: ModelClass, entry: ResourceEntry): Promise<ResourceRef[]> {
  return runWithPrincipal(SYSTEM, async () => {
    const { query: select } = createQuery(model as never, SelectQueryBuilder);
    select.withDeleted().withArchived();
    const source = (query as unknown as { _statements: IQueryStatement[] })._statements;
    (select as unknown as { _statements: IQueryStatement[] })._statements = source.map((s) => {
      const c = s.clone(select as never);
      c.Boolean = s.Boolean;
      return c;
    });
    select.columns([entry.idColumn]);
    const rows = await select.asRaw<Record<string, unknown>[]>();
    return refsOf(entry.type, rows.map((r) => r[entry.idColumn]));
  });
}

/** Which of `refs` still have a row (a delete with a limit, or one that lost a race, reaches fewer). */
export async function stillThere(driver: OrmDriver, model: ModelClass, entry: ResourceEntry, refs: readonly ResourceRef[]): Promise<Set<string>> {
  const out = new Set<string>();
  const values = refs.map((r) => idLookup(model, entry.idColumn, String(r.id))).filter((v) => v !== undefined);
  for (const part of chunks(values, ID_CHUNK)) {
    const rows = (await driver.select().from(tableOf(model)).columns([entry.idColumn]).whereIn(entry.idColumn, part)) as Record<string, unknown>[];
    for (const row of rows) {
      const id = idText(row[entry.idColumn]);
      if (id !== undefined) out.add(id);
    }
  }
  return out;
}

interface InsertResult {
  readonly Returning?: unknown[];
  readonly LastInsertId?: unknown;
  readonly RowsAffected?: unknown;
}

/** The ids an insert wrote, as the ORM's own key backfill reads them (model.ts:1349-1381); undefined when they cannot be known. */
export function insertedRefs(query: InsertQueryBuilder, result: unknown, entry: ResourceEntry): ResourceRef[] | undefined {
  const rows = query.Values.length;
  if (rows === 0) return [];
  const supplied = query.getColumnValues(entry.idColumn);
  if (supplied.length === rows && supplied.every((v) => v !== null && v !== undefined)) return refsOf(entry.type, supplied);
  const r: InsertResult = Array.isArray(result) ? { Returning: result } : ((result ?? {}) as InsertResult);
  const returning = Array.isArray(r.Returning) ? (r.Returning as Record<string, unknown>[]) : [];
  if (returning.length === rows && returning.every((x) => x !== null && typeof x === 'object' && x[entry.idColumn] !== undefined && x[entry.idColumn] !== null)) return refsOf(entry.type, returning.map((x) => x[entry.idColumn]));
  const last = r.LastInsertId;
  if (typeof last !== 'number' || !Number.isSafeInteger(last) || last <= 0) return undefined;
  if (rows === 1) return refsOf(entry.type, [last]);
  const noneSupplied = supplied.every((v) => v === null || v === undefined);
  if (noneSupplied && query.Driver.supportedFeatures().insertIdIsFirstOfBatch === true && r.RowsAffected === rows && !query.Ignore && !query.Replace && !query.Update) {
    return refsOf(entry.type, Array.from({ length: rows }, (_, k) => last + k));
  }
  return undefined;
}
```

- [ ] **Step 5: Write `src/ancestors/cleanup.ts`**

```ts
import { AuthzAdminBackend, AuthzConfigError, ChangeBus, SYSTEM, forgetScopesInTx } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, ResolveType, isFactory } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { domainContainer, ormDomain, recordAudit } from '../host.js';
import { afterCommit } from './commit.js';

const SYSTEM_REF = Object.freeze({ type: SYSTEM.type, id: SYSTEM.id });
export const RESOURCE_DELETED = 'resource-deleted';
const DELETED = Object.freeze({ actor: SYSTEM, reason: RESOURCE_DELETED });

/** The name `authz.admin.backend` gives; the default is the admin's (packages/authz/src/admin/config.ts:17). */
export function adminBackendName(): string {
  const v = DI.get(Configuration)?.get<unknown>(['authz', 'admin', 'backend']);
  return typeof v === 'string' && v !== '' ? v : 'MemoryAuthzAdminBackend';
}

// As DefaultAuthzAdmin.named (admin.ts:431-441): the class of that name registered for AuthzAdminBackend.
async function adminBackend(container: IContainer, name: string): Promise<AuthzAdminBackend> {
  const entry = container.Registry.getTypesChain(AuthzAdminBackend)
    .filter((e) => !isFactory(e.type) && (e.type as { name?: string }).name === name)
    .pop();
  if (!entry) throw new AuthzConfigError(`authz-orm: authz.admin.backend names ${JSON.stringify(name)}, but no AuthzAdminBackend class of that name is registered`);
  const type = entry.type as Class<AuthzAdminBackend>;
  const at = container.extractDescriptor(type).resolver === ResolveType.PerChildContainer ? container : entry.container;
  return (await at.resolve(type)) as AuthzAdminBackend;
}

function publishAndAudit(domain: string, container: IContainer, deleted: readonly ResourceRef[], tags: readonly string[]): Promise<void> {
  return (async () => {
    const bus = container.hasRegistered(ChangeBus) ? ((await container.resolve(ChangeBus)) as ChangeBus) : undefined;
    await bus?.publish(Object.freeze({ domain, tags: Object.freeze([...tags]), actor: SYSTEM_REF, at: new Date() }));
    for (const resource of deleted) recordAudit(domain, { kind: 'system', principal: SYSTEM_REF, resource, reason: RESOURCE_DELETED });
  })();
}

/**
 * Design §6.4 steps 3–4, placed by overview decision 20. With DbAuthzAdminBackend the stores write in the
 * statement's transaction (H22's one framework-owned exception) and bump authz_version themselves; any other
 * backend cannot join an ORM transaction, so its forget runs after the commit in its own, best effort.
 */
export async function cleanupDeleted(driver: OrmDriver, deleted: readonly ResourceRef[]): Promise<void> {
  if (deleted.length === 0) return;
  const domain = ormDomain();
  const container = domainContainer(domain);
  const backendName = adminBackendName();
  if (backendName === 'DbAuthzAdminBackend') {
    const { tags } = await forgetScopesInTx(container, deleted, { driver }, DELETED);
    afterCommit(driver, 'publishing the change', () => publishAndAudit(domain, container, deleted, tags));
    return;
  }
  afterCommit(driver, `forgetting the deleted scopes through ${backendName}`, async () => {
    const backend = await adminBackend(container, backendName);
    const { tags } = await backend.transaction(domain, async (tx) => {
      const out = await forgetScopesInTx(container, deleted, tx, DELETED);
      await backend.bumpVersion(domain, tx);
      return out;
    });
    await publishAndAudit(domain, container, deleted, tags);
  });
}
```

Check before writing: `AuthzAdminBackend` is exported from `@spinajs/authz` (`src/admin/backend.ts:18`, through `admin/index.ts`).

- [ ] **Step 6: Write `src/ancestors/middleware.ts`**

```ts
import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, QueryMiddleware, UpdateQueryBuilder } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';

import { ormLog } from '../host.js';
import { entryOf, nameOf } from '../registry.js';
import type { ModelClass, ResourceEntry } from '../registry.js';
import { cleanupDeleted } from './cleanup.js';
import { rebuildFrom, removeNodes } from './rebuild.js';
import { insertedRefs, stillThere, targetRefs } from './targets.js';

interface Work {
  readonly kind: 'insert' | 'update' | 'delete';
  readonly model: ModelClass;
  readonly entry: ResourceEntry;
  readonly transactional: boolean;
}

function workOf(query: QueryBuilder): Work | undefined {
  const model = query.Model as ModelClass | undefined;
  const entry = entryOf(model);
  if (!entry || !model) return undefined;
  if (query instanceof DeleteQueryBuilder) return { kind: 'delete', model, entry, transactional: true };
  if (entry.parents.length === 0) return undefined;
  if (query instanceof InsertQueryBuilder) return { kind: 'insert', model, entry, transactional: query.Ignore === true || query.Replace || query.Update };
  if (query instanceof UpdateQueryBuilder) {
    const written = Object.keys((query.Value ?? {}) as Record<string, unknown>);
    return entry.parents.some((p) => written.includes(p.column)) ? { kind: 'update', model, entry, transactional: true } : undefined;
  }
  return undefined;
}

/**
 * Keeps authz_resource_ancestor right for writes of @AccessResource models (design §6.4). It never
 * changes a query; it reads the rows a write reaches and writes the table in the same transaction.
 */
@Injectable(QueryMiddleware)
export class AncestorMiddleware extends QueryMiddleware {
  public order = 90;

  private readonly targets = new WeakMap<object, ResourceRef[]>();
  private readonly warned = new WeakSet<ModelClass>();

  afterQueryCreation(_query: QueryBuilder): void {}

  transactional(query: QueryBuilder): boolean {
    return workOf(query)?.transactional === true;
  }

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const work = workOf(query);
    if (!work) return;
    if (work.transactional && query.Driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`authz-orm: a ${work.kind} of ${nameOf(work.model)} (resource '${work.entry.type}') must run in a transaction so authz_resource_ancestor changes with it, and none could be opened on connection ${JSON.stringify(query.Driver.Options.Name)}`);
    }
    if (work.kind === 'update' || work.kind === 'delete') this.targets.set(query, await targetRefs(query as UpdateQueryBuilder<unknown>, work.model, work.entry));
  }

  async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    const work = workOf(query);
    if (!work) return;
    const driver = query.Driver;
    if (work.kind === 'insert') {
      const refs = insertedRefs(query as InsertQueryBuilder, result, work.entry);
      if (refs === undefined) return this.warnUnknownIds(work);
      await rebuildFrom(driver, refs);
      return;
    }
    const refs = this.targets.get(query) ?? [];
    this.targets.delete(query);
    if (refs.length === 0) return;
    if (work.kind === 'update') {
      await rebuildFrom(driver, refs);
      return;
    }
    const left = await stillThere(driver, work.model, work.entry, refs);
    const deleted = refs.filter((r) => !left.has(String(r.id)));
    await removeNodes(driver, deleted);
    await cleanupDeleted(driver, deleted);
  }

  private warnUnknownIds(work: Work): void {
    if (this.warned.has(work.model)) return;
    this.warned.add(work.model);
    ormLog().warn(`authz-orm: an insert of ${nameOf(work.model)} did not report the ids it wrote, so their authz_resource_ancestor rows are missing (access only narrows); insert one row at a time, supply the keys, or run authz:ancestors-rebuild ${work.entry.type}`);
  }
}
```

`AncestorMiddleware` implements L1's optional members (`transactional`, `afterQueryExecution`) as plain methods; if L1 typed them with other parameter names, keep L1's signature. `query.Ignore` is `undefined` until `orIgnore()` runs (`builders.ts:1849`), hence `=== true`.

- [ ] **Step 7: Register the middleware**

Append to `packages/authz-orm/src/index.ts`:

```ts
// Registers AncestorMiddleware as a QueryMiddleware.
import './ancestors/middleware.js';
export { AncestorMiddleware } from './ancestors/middleware.js';
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/ancestors/middleware.test.ts`
Expected: PASS, `17 passing` with Postgres up (`9 passing, 8 pending` without).

Run: `cd packages/authz-orm && npm test`
Expected: PASS, `0 failing`.

- [ ] **Step 9: Commit**

```bash
git add packages/authz-orm/src packages/authz-orm/test/ancestors/middleware.test.ts
git commit -m "feat(authz-orm): keep authz_resource_ancestor right on insert, @Parent update and delete"
```

---

### Task 6: `reparent`

**Files:**
- Create: `packages/authz-orm/src/ancestors/reparent.ts`
- Modify: `packages/authz-orm/src/index.ts`, `src/ancestors/index.ts`
- Test: `packages/authz-orm/test/ancestors/reparent.test.ts`

**Interfaces:**
- Consumes: `AncestorMiddleware` (Task 5: the update it issues recomputes the moved subtrees), `entryOf`, `driverOf`.
- Produces: `reparent(model, ids, newParentId, column?)` from the package root (frozen in `api.ts` since Task 1). `authz().ancestors.reparent` from design §6.4 is **not** a contract method: the closure table belongs to authz-orm, so the bulk move is an authz-orm function. The app checks the new parent (`assert(me, 'Task:update', …)` / create on the new parent) before calling it; `reparent` checks nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/ancestors/reparent.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Parent, reparent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable } from '../support/ancestors.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown> };

describe('reparent', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
    await (await testHost.domains()).service('root');
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await createAncestorTable(db, 'sqlite');
  });

  afterEach(async () => {
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  it('moves the rows and their subtrees in one transaction', async () => {
    const Folder = (await db.define({ name: 'Folder', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('folder')(c); Parent('project')(p, 'project_id'); } })) as M;
    const Doc = (await db.define({ name: 'Doc', columns: { folder_id: 'TEXT' }, decorate: (c, p) => { AccessResource('doc')(c); Parent('folder')(p, 'folder_id'); } })) as M;
    await Folder.insert([{ id: 'f1', project_id: 'p1' }, { id: 'f2', project_id: 'p1' }]);
    await Doc.insert({ id: 'd1', folder_id: 'f1' });
    expect(await reparent(Folder as never, ['f1', 'f2'], 'p2')).to.equal(2);
    expect(await ancestorLinks(db.driver())).to.deep.equal(['doc:d1>folder:f1@1', 'doc:d1>project:p2@2', 'folder:f1>project:p2@1', 'folder:f2>project:p2@1']);
    expect(await reparent(Folder as never, [], 'p3')).to.equal(0);
  });

  it('needs the column when the model has several parents, and refuses an unknown one', async () => {
    const Task = (await db.define({ name: 'Task', columns: { project_id: 'TEXT', sprint_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); Parent('sprint', { nullable: true })(p, 'sprint_id'); } })) as M;
    await Task.insert({ id: 't1', project_id: 'p1', sprint_id: 's1' });
    let err: unknown;
    try {
      await reparent(Task as never, ['t1'], 's2');
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect(await reparent(Task as never, ['t1'], null, 'sprint_id')).to.equal(1);
    expect(await ancestorLinks(db.driver())).to.deep.equal(['task:t1>project:p1@1']);
    try {
      await reparent(Task as never, ['t1'], 'x', 'nope');
      expect.fail('expected AuthzConfigError');
    } catch (e) {
      expect(e).to.be.instanceOf(AuthzConfigError);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/ancestors/reparent.test.ts`
Expected: FAIL: `Error: @spinajs/authz-orm: reparent is not implemented yet` (the stub from `api.ts`).

- [ ] **Step 3: Write the implementation**

Create `packages/authz-orm/src/ancestors/reparent.ts`:

```ts
import { AuthzConfigError } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { driverOf } from '../ids.js';
import { entryOf, nameOf } from '../registry.js';

type Updatable = typeof ModelBase & { update(v: object): { whereIn(column: string, values: unknown[]): Promise<unknown> } };

const affected = (r: unknown): number => {
  const n = (r as { RowsAffected?: unknown } | null)?.RowsAffected;
  return typeof n === 'number' ? n : 0;
};

/** The bulk move of design §6.4: one update; AncestorMiddleware recomputes the moved subtrees in its transaction. */
export async function reparent(model: Class<ModelBase>, ids: readonly (string | number)[], newParentId: string | number | null, column?: string): Promise<number> {
  const entry = entryOf(model);
  if (!entry) throw new AuthzConfigError(`reparent: ${nameOf(model)} is not an @AccessResource model`);
  const parent = column === undefined ? (entry.parents.length === 1 ? entry.parents[0] : undefined) : entry.parents.find((p) => p.column === column);
  if (!parent) {
    const names = entry.parents.map((p) => p.column).join(', ') || 'none';
    throw new AuthzConfigError(`reparent: ${nameOf(model)} ${column === undefined ? 'has several @Parent columns; name one' : `has no @Parent column ${column}`} (its @Parent columns: ${names})`);
  }
  if (ids.length === 0) return 0;
  return driverOf(model).transaction(async () => affected(await (model as unknown as Updatable).update({ [parent.column]: newParentId }).whereIn(entry.idColumn, [...ids])));
}
```

In `packages/authz-orm/src/index.ts`, extend the decorators export line so it reads:

```ts
export { AccessResource, Parent, Owner, Self, registerAccessResource } from './decorators.js';
export { reparent } from './ancestors/reparent.js';
```

and in `test/api.test.ts`, add `same<typeof root.reparent, typeof stubs.reparent>(true);` and `'reparent'` to the list of names in the second test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/ancestors/reparent.test.ts test/api.test.ts`
Expected: PASS, `5 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-orm/src packages/authz-orm/test/ancestors/reparent.test.ts packages/authz-orm/test/api.test.ts
git commit -m "feat(authz-orm): reparent for bulk moves"
```

---

### Task 7: CLI `authz:ancestors-verify` and `authz:ancestors-rebuild`

**Files:**
- Create: `packages/authz-orm/src/ancestors/full.ts`, `src/cli/base.ts`, `src/cli/commands/ancestors-verify.ts`, `src/cli/commands/ancestors-rebuild.ts`, `src/config/authz-orm-cli.ts`
- Test: `packages/authz-orm/test/cli/ancestors.test.ts`, `test/cli/discovery.test.ts`

**Interfaces:**
- Consumes: `closeOver` (Task 4), `typesAbove`, `classesOf`, `entryOf`, `registeredTypes` (Task 1), `@spinajs/cli` (`CliCommand`, `Command`, `Argument`; pattern `packages/authz-rbac/src/cli/commands/revoke.ts`), command discovery through `system.dirs.cli` (pattern `packages/authz-rbac/src/config/rbac-cli.ts`; the configuration loads `node_modules/@spinajs/*/lib/<mjs|cjs>/config`, `packages/configuration/src/sources.ts:99`).
- Produces: `expectedRows(driver, type): Promise<AncestorRow[]>`, `actualRows(driver, type)`, `diffRows(expected, actual)`, `listedTypes(driver)` in `full.ts`; commands `AncestorsVerifyCommand`, `AncestorsRebuildCommand` (first export of each command file, as the Cli requires).
- Behaviour: verify prints `missing`, `extra` and `depth` lines (at most 50 per type, then `… and N more`) and a summary line per type, and sets exit code 1 on any difference. Rebuild rewrites each type in its own transaction: delete the type's rows, insert the expected rows in chunks of `ROW_CHUNK`. Both read every row of the type and of the types above it into memory; a type's rows are written through the connection of its first registered class.

- [ ] **Step 1: Write the failing tests**

Create `packages/authz-orm/test/cli/ancestors.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import type { ModelBase } from '@spinajs/orm';

import { AncestorsRebuildCommand } from '../../src/cli/commands/ancestors-rebuild.js';
import { AncestorsVerifyCommand } from '../../src/cli/commands/ancestors-verify.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  return {
    out,
    err,
    code: () => process.exitCode,
    restore: () => {
      console.log = log;
      console.error = error;
      process.exitCode = exitCode;
    },
  };
}

describe('authz:ancestors-verify / authz:ancestors-rebuild', function () {
  this.timeout(60000);
  let db: TestDb;
  let io: ReturnType<typeof capture>;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await createAncestorTable(db, 'sqlite');
    await db.define({ name: 'Project', columns: { org_id: 'TEXT' }, rows: [{ id: 'p1', org_id: 'o1' }], decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } });
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, rows: [{ id: 't1', project_id: 'p1' }, { id: 't2', project_id: null }], decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    io = capture();
  });

  afterEach(async () => {
    io.restore();
    await db.clear();
    await dropAncestorTable(db, 'sqlite');
  });

  const verify = (type?: string) => Object.assign(new AncestorsVerifyCommand(), { Orm: db.orm }).execute(type);
  const rebuild = (type?: string) => Object.assign(new AncestorsRebuildCommand(), { Orm: db.orm }).execute(type);

  it('verify reports missing, extra and wrong-depth rows with exit code 1', async () => {
    await insertLinks(db.driver(), ['task:t1>project:p1@1', 'task:t1>org:o1@3', 'task:t2>project:p9@1']);
    await verify('task');
    expect(io.out).to.include.members(['task: missing task:t1>org:o1@2', 'task: extra task:t2>project:p9@1']);
    expect(io.out.some((l) => l.startsWith('task: depth task:t1>org:o1 expected 2, found 3'))).to.equal(true);
    expect(io.out[io.out.length - 1]).to.equal('task: 1 missing, 1 extra, 1 wrong depth');
    expect(io.code()).to.equal(1);
  });

  it('rebuild rewrites every registered type; verify then passes with exit code 0', async () => {
    await insertLinks(db.driver(), ['task:t2>project:p9@1']);
    await rebuild();
    expect(await ancestorLinks(db.driver())).to.deep.equal(['project:p1>org:o1@1', 'task:t1>org:o1@2', 'task:t1>project:p1@1']);
    expect(io.out).to.include.members(['project: 1 rows', 'task: 2 rows']);
    io.out.length = 0;
    await verify();
    expect(io.out).to.deep.equal(['project: ok', 'task: ok']);
    expect(io.code()).to.equal(undefined);
  });

  it('verify without a type also reports rows of types no model declares', async () => {
    await rebuild();
    await insertLinks(db.driver(), ['ghost:g1>project:p1@1']);
    io.out.length = 0;
    await verify();
    expect(io.out).to.include('ghost: extra ghost:g1>project:p1@1');
    expect(io.code()).to.equal(1);
  });

  it('an unknown type is a usage error with exit code 1', async () => {
    await verify('nope');
    expect(io.err).to.deep.equal(["authz:ancestors: no @AccessResource model has type 'nope'"]);
    expect(io.code()).to.equal(1);
  });
});
```

Create `packages/authz-orm/test/cli/discovery.test.ts`:

```ts
import { META_COMMAND } from '@spinajs/cli';
import { expect } from 'chai';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'mocha';

import ormCli from '../../src/config/authz-orm-cli.js';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('authz-orm cli discovery', function () {
  this.timeout(30000);

  it('adds lib/<mjs|cjs>/cli/commands of @spinajs/authz-orm to system.dirs.cli', () => {
    const dirs = ormCli.system.dirs.cli;
    expect(dirs).to.have.length(2);
    for (const d of dirs) expect(d.split(/[\\/]/).slice(-6)).to.deep.equal(['@spinajs', 'authz-orm', 'lib', 'mjs', 'cli', 'commands']);
  });

  it('finds exactly the two commands: the first export of every built file is a command', async () => {
    const dir = join(PKG_ROOT, 'lib', 'mjs', 'cli', 'commands');
    expect(existsSync(dir)).to.equal(true);
    const names: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const first = Object.values(await import(pathToFileURL(join(dir, f)).href))[0] as object;
      const meta = Reflect.getMetadata(META_COMMAND, first) as { nameAndArgs: string } | undefined;
      expect(meta, f).to.not.equal(undefined);
      names.push(meta!.nameAndArgs.split(' ')[0]);
    }
    expect(names.sort()).to.deep.equal(['authz:ancestors-rebuild', 'authz:ancestors-verify']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/cli/ancestors.test.ts test/cli/discovery.test.ts`
Expected: FAIL with a TSError `Cannot find module '../../src/cli/commands/ancestors-rebuild.js'`.

- [ ] **Step 3: Write `src/ancestors/full.ts`**

```ts
import { AuthzConfigError, resourceKey } from '@spinajs/authz';
import type { ResourceRef, ResourceType } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

import { idText, tableOf } from '../ids.js';
import { classesOf, entryOf, typesAbove } from '../registry.js';
import { closeOver } from './closure.js';
import { ANCESTOR_COLUMNS, AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';
import type { AncestorRow } from './table.js';

const linkKey = (r: AncestorRow): string => `${r.resource_type}:${r.resource_id}>${r.ancestor_type}:${r.ancestor_id}`;

/** Every row of `types` with its parents, read whole from each class table (once per table). */
async function loadParents(driver: OrmDriver, types: readonly ResourceType[]): Promise<{ nodes: Map<string, ResourceRef[]>; ofType: Map<ResourceType, ResourceRef[]> }> {
  const nodes = new Map<string, ResourceRef[]>();
  const ofType = new Map<ResourceType, ResourceRef[]>();
  for (const type of types) {
    const tables = new Set<string>();
    for (const cls of classesOf(type)) {
      const entry = entryOf(cls)!;
      const table = tableOf(cls);
      if (tables.has(table)) continue;
      tables.add(table);
      const rows = (await driver.select().from(table).columns([entry.idColumn, ...new Set(entry.parents.map((p) => p.column))])) as Record<string, unknown>[];
      for (const row of rows) {
        const id = idText(row[entry.idColumn]);
        if (id === undefined || nodes.has(resourceKey({ type, id }))) continue;
        const parents: ResourceRef[] = [];
        for (const p of entry.parents) {
          const pid = idText(row[p.column]);
          if (pid !== undefined) parents.push({ type: p.type, id: pid });
        }
        nodes.set(resourceKey({ type, id }), parents);
        ofType.set(type, [...(ofType.get(type) ?? []), { type, id }]);
      }
    }
  }
  return { nodes, ofType };
}

/** The rows `type` should have: its rows' closure over the types above it, from the @Parent columns. */
export async function expectedRows(driver: OrmDriver, type: ResourceType): Promise<AncestorRow[]> {
  if (classesOf(type).length === 0) return [];
  const { nodes, ofType } = await loadParents(driver, [type, ...typesAbove(type)]);
  const all = [...nodes.keys()].map((k) => {
    const at = k.indexOf(':');
    return { type: k.slice(0, at), id: k.slice(at + 1) };
  });
  const closure = closeOver(all, nodes, new Map());
  const out: AncestorRow[] = [];
  for (const n of ofType.get(type) ?? []) for (const l of closure.get(resourceKey(n)) ?? []) out.push({ resource_type: type, resource_id: String(n.id), ancestor_type: l.type, ancestor_id: l.id, depth: l.depth });
  return out;
}

export async function actualRows(driver: OrmDriver, type: ResourceType): Promise<AncestorRow[]> {
  const rows = (await driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).columns([...ANCESTOR_COLUMNS]).where('resource_type', type)) as Record<string, unknown>[];
  return rows.map((r) => ({ resource_type: String(r.resource_type), resource_id: String(r.resource_id), ancestor_type: String(r.ancestor_type), ancestor_id: String(r.ancestor_id), depth: Number(r.depth) }));
}

/** Resource types that have rows in the table. */
export async function listedTypes(driver: OrmDriver): Promise<ResourceType[]> {
  const rows = (await driver.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).columns(['resource_type']).distinct()) as Record<string, unknown>[];
  return rows.map((r) => String(r.resource_type));
}

export interface RowDiff {
  readonly missing: string[];
  readonly extra: string[];
  readonly depth: string[];
}

export function diffRows(expected: readonly AncestorRow[], actual: readonly AncestorRow[]): RowDiff {
  const want = new Map(expected.map((r) => [linkKey(r), r]));
  const have = new Map(actual.map((r) => [linkKey(r), r]));
  const missing: string[] = [];
  const extra: string[] = [];
  const depth: string[] = [];
  for (const [k, r] of want) {
    const h = have.get(k);
    if (!h) missing.push(`${k}@${r.depth}`);
    else if (h.depth !== r.depth) depth.push(`${k} expected ${r.depth}, found ${h.depth}`);
  }
  for (const [k, r] of have) if (!want.has(k)) extra.push(`${k}@${r.depth}`);
  return { missing: missing.sort(), extra: extra.sort(), depth: depth.sort() };
}

export function requireType(type: string): ResourceType {
  if (classesOf(type).length === 0) throw new AuthzConfigError(`authz:ancestors: no @AccessResource model has type '${type}'`);
  return type;
}
```

`distinct()` is the `SelectQueryBuilder` method behind `IsDistinct` (`builders.ts:1292`); if its name differs in your checkout, read `rows` without it and de-duplicate with a `Set`.

- [ ] **Step 4: Write `src/cli/base.ts`**

```ts
/* eslint-disable no-console */
import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { CliCommand } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { driverOf } from '../ids.js';
import { classesOf } from '../registry.js';

/** The ORM is resolved when the command runs (the Cli boots only the command); tests set `Orm`. */
export abstract class AuthzOrmCliCommand extends CliCommand {
  public Orm?: Orm;

  protected async orm(): Promise<Orm> {
    return (this.Orm ??= (await DI.resolve(Orm)) as Orm);
  }

  /** The connection of the type's first registered class, else the ORM's default. */
  protected async driverFor(type: string): Promise<OrmDriver> {
    const cls = classesOf(type)[0];
    if (cls) return driverOf(cls);
    const d = (await this.orm()).Connections.get('default');
    if (!d) throw new Error('authz:ancestors: the ORM has no default connection');
    return d;
  }

  protected out(line = ''): void {
    console.log(line);
  }

  protected fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
  }

  /** Parses first, then runs the body as SYSTEM; any error becomes one line and exit code 1. */
  protected async command<T>(parse: () => T, run: (parsed: T) => Promise<void>): Promise<void> {
    let parsed: T;
    try {
      await this.orm();
      parsed = parse();
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    }
    try {
      await runWithPrincipal(SYSTEM, () => run(parsed));
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
```

- [ ] **Step 5: Write the commands**

Create `packages/authz-orm/src/cli/commands/ancestors-verify.ts`:

```ts
import { Argument, Command } from '@spinajs/cli';

import { actualRows, diffRows, expectedRows, listedTypes, requireType } from '../../ancestors/full.js';
import { registeredTypes } from '../../registry.js';
import { AuthzOrmCliCommand } from '../base.js';

const MAX_LINES = 50;

@Command('authz:ancestors-verify', 'Compares authz_resource_ancestor with the @Parent columns; exit code 1 on any difference')
@Argument('type', false, 'resource type; default: every registered type and every type the table lists')
export class AncestorsVerifyCommand extends AuthzOrmCliCommand {
  public async execute(type?: string): Promise<void> {
    await this.command(
      () => (type === undefined ? undefined : [requireType(type)]),
      async (types) => {
        let failed = false;
        const all = types ?? [...new Set([...registeredTypes(), ...(await listedTypes(await this.driverFor(registeredTypes()[0] ?? '')))])];
        for (const t of all) {
          const driver = await this.driverFor(t);
          const d = diffRows(await expectedRows(driver, t), await actualRows(driver, t));
          const lines = [...d.missing.map((x) => `missing ${x}`), ...d.extra.map((x) => `extra ${x}`), ...d.depth.map((x) => `depth ${x}`)];
          if (lines.length === 0) {
            this.out(`${t}: ok`);
            continue;
          }
          failed = true;
          for (const l of lines.slice(0, MAX_LINES)) this.out(`${t}: ${l}`);
          if (lines.length > MAX_LINES) this.out(`${t}: … and ${lines.length - MAX_LINES} more`);
          this.out(`${t}: ${d.missing.length} missing, ${d.extra.length} extra, ${d.depth.length} wrong depth`);
        }
        if (failed) process.exitCode = 1;
      },
    );
  }
}
```

Create `packages/authz-orm/src/cli/commands/ancestors-rebuild.ts`:

```ts
import { Argument, Command } from '@spinajs/cli';

import { expectedRows, requireType } from '../../ancestors/full.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE, ROW_CHUNK, chunks } from '../../ancestors/table.js';
import { registeredTypes } from '../../registry.js';
import { AuthzOrmCliCommand } from '../base.js';

@Command('authz:ancestors-rebuild', 'Rewrites authz_resource_ancestor from the @Parent columns, one transaction per type')
@Argument('type', false, 'resource type; default: every registered type')
export class AncestorsRebuildCommand extends AuthzOrmCliCommand {
  public async execute(type?: string): Promise<void> {
    await this.command(
      () => (type === undefined ? registeredTypes() : [requireType(type)]),
      async (types) => {
        for (const t of types) {
          const driver = await this.driverFor(t);
          const rows = await expectedRows(driver, t);
          await driver.transaction(async () => {
            await driver.del().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).where('resource_type', t);
            for (const part of chunks(rows, ROW_CHUNK)) await driver.insert().into(AUTHZ_RESOURCE_ANCESTOR_TABLE).values(part);
          });
          this.out(`${t}: ${rows.length} rows`);
        }
      },
    );
  }
}
```

Create `packages/authz-orm/src/config/authz-orm-cli.ts`:

```ts
import { join, normalize, resolve } from 'path';

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'authz-orm', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), '../', 'node_modules', '@spinajs', 'authz-orm', 'lib', inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

// Only cli/commands: the Cli takes the first export of each file there, so helpers and barrels must stay out.
const authzOrmCli = {
  system: {
    dirs: {
      cli: [...dir('cli/commands')],
    },
  },
};

export default authzOrmCli;
```

In the verify test, the table rows of the `rebuild` case come from `registeredTypes()` = `['project', 'task']` in definition order, so `rebuild` prints `project: 1 rows` before `task: 2 rows`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/cli/ancestors.test.ts test/cli/discovery.test.ts`
Expected: PASS, `6 passing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-orm/src packages/authz-orm/test/cli
git commit -m "feat(authz-orm): authz:ancestors-verify and authz:ancestors-rebuild"
```

---

### Task 8: Runtime guard (design §8)

**Files:**
- Create: `packages/authz-orm/src/guard/env.ts`, `src/guard/middleware.ts`
- Modify: `packages/authz-orm/src/index.ts`, `README.md`
- Test: `packages/authz-orm/test/guard.test.ts`

**Interfaces:**
- Consumes: `marksOf` (Task 1; L4's `.accessible()` / `.unscoped()` set `accessible` / `unscoped`), `storageUnscoped`, `ormLog` (Task 1), `currentPrincipal`, `SYSTEM` (`@spinajs/authz`).
- Produces: `guardMode(config?): 'throw' | 'warn' | 'off'`; `isSingleObjectLoad(query, entry): boolean`; `AccessGuardMiddleware` (`@Injectable(QueryMiddleware)`, `order = 95`).
- Env rule (same reading as `authnAppEnv`, `packages/authn/src/service/boot/env.ts:25-54`, copied: authz-orm does not depend on authn): the env is the configuration's `process.env.APP_ENV`, unless it is `development` and no source named development (`config.Env`, the DI `process.env`'s `APP_ENV`, `process.env.APP_ENV`, `process.env.NODE_ENV`): then it is unset. `normalizeEnvironment(env)` (`@spinajs/configuration`) `'test'` → `throw`, `'dev'` → `warn` (once per call site), anything else or unset → `off`.
- Exempt: a select with `.accessible()` or `.unscoped()` marks, the `SYSTEM` principal (`runAs(SYSTEM, …)`), a request a route marked `@Unscoped(reason)` (authz-http sets `storage.Unscoped`; it is audited there), and a single-object load (overview decision 11): a select whose where statements are exactly one primary-key equality — a `WhereStatement` on `entry.idColumn` with operator `=` and a scalar value (`where(pk, v)`, `wherePk` of `get(v)`, `packages/orm/src/primary-keys.ts:117-133`), or an `InStatement` on it with one value (`whereAnyPk` of `find([v])` / `findOrFail([v])`, `primary-keys.ts:141-155`) — plus only the `IS NULL` defaults `createQuery` adds for `SoftDelete.DeletedAt` and `Archived.ArchivedAt` (`builders.ts:3179-3188`). Any other statement (an `orWhere`, a second column, a nested group, a raw where) makes it a multi-row select. Only `SelectQueryBuilder`s of `@AccessResource` models are checked; a `populate()` of an `@AccessResource` type runs its own select builder (hasMany, many-to-many) and is checked like any other; a belongsTo populate compiles into its parent's join and is not seen (the ESLint rule of L12 covers it at edit time).
- L5 note: suites that run with `APP_ENV=test` and select `@AccessResource` models without the helper fail after this task; L5 adds `.accessible()` / `.unscoped()` there.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/guard.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthzConfigError, SYSTEM, authzStorage, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import type { ModelBase } from '@spinajs/orm';

import { AccessGuardMiddleware } from '../src/guard/middleware.js';
import { guardMode } from '../src/guard/env.js';
import { ormLog } from '../src/host.js';
import { AccessResource } from '../src/index.js';
import { setMarks } from '../src/marker.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
type W = Promise<ModelBase[]> & { first(): Promise<ModelBase | undefined>; where(...a: unknown[]): W; orWhere(...a: unknown[]): W };
type M = typeof ModelBase & { query(): Promise<ModelBase[]> & object; where(...a: unknown[]): W };

describe('authz-orm runtime guard', function () {
  this.timeout(60000);
  let db: TestDb;
  let Task: M;
  let Plain: M;
  const appEnv = process.env.APP_ENV;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
    if (appEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = appEnv;
  });

  beforeEach(async () => {
    Task = (await db.define({ name: 'Task', columns: { title: 'TEXT' }, rows: [{ id: 't1', title: 'a' }, { id: 't2', title: 'b' }], decorate: (c) => AccessResource('task')(c) })) as M;
    Plain = (await db.define({ name: 'Plain', columns: { title: 'TEXT' }, rows: [{ id: 'x', title: 'b' }] })) as M;
  });

  afterEach(async () => {
    testHost.config().unset(['process', 'env', 'APP_ENV']);
    sinon.restore();
    await db.clear();
  });

  const env = (value: string) => testHost.config().set(['process', 'env', 'APP_ENV'], value);
  const as = <T>(p: Principal, fn: () => Promise<T>) => runWithPrincipal(p, fn);

  it('reads the env like authn: test throws, development warns, anything else and unset are off', () => {
    expect(guardMode()).to.equal('off');
    env('test');
    expect(guardMode()).to.equal('throw');
    env('production');
    expect(guardMode()).to.equal('off');
    env('development');
    delete process.env.APP_ENV;
    expect(guardMode(), 'development that no source named is a fallback, so unset').to.equal('off');
    process.env.APP_ENV = 'development';
    expect(guardMode()).to.equal('warn');
  });

  it('in test, a select of an @AccessResource model without the helper is an AuthzConfigError', async () => {
    env('test');
    let err: unknown;
    try {
      await as(alice, async () => await Task.query());
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthzConfigError);
    expect((err as Error).message).to.match(/\.accessible\(permission\), \.unscoped\(reason\) or runAs\(SYSTEM\)/);
  });

  it('lets through SYSTEM, marked builders, route @Unscoped, plain models and writes', async () => {
    env('test');
    expect(await runWithPrincipal(SYSTEM, async () => (await Task.query()).length)).to.equal(2);
    expect(await as(alice, async () => (await Plain.query()).length)).to.equal(1);
    const q = Task.query();
    setMarks(q, { unscoped: 'export' });
    expect(await as(alice, async () => (await q).length)).to.equal(2);
    const r = Task.query();
    setMarks(r, { accessible: 'task:read' });
    expect(await as(alice, async () => (await r).length)).to.equal(2);
    await authzStorage().run({ Principal: alice, Unscoped: 'route' } as never, async () => {
      expect((await Task.query()).length).to.equal(2);
    });
  });

  it('in development, warns once per call site', async () => {
    env('development');
    process.env.APP_ENV = 'development';
    const warn = sinon.stub(ormLog(), 'warn');
    for (let i = 0; i < 3; i++) await as(alice, async () => await Task.query());
    await as(alice, async () => await Task.query());
    expect(warn.callCount).to.equal(2);
    expect(String(warn.firstCall.args[0])).to.match(/guard\.test\.ts/);
  });

  it('does not flag single-object loads by primary key', async () => {
    env('test');
    const T = Task as M & { get(pk: unknown): Promise<ModelBase>; findOrFail(pks: unknown[]): Promise<ModelBase[]> };
    expect(await as(alice, async () => ((await Task.where('id', 't1').first()) as unknown as { id: string }).id)).to.equal('t1');
    expect(await as(alice, async () => ((await T.get('t1')) as unknown as { id: string }).id)).to.equal('t1');
    expect(await as(alice, async () => (await T.findOrFail(['t1'])).length)).to.equal(1);
  });

  it('flags a select that is not exactly one primary-key equality', async () => {
    env('test');
    const T = Task as M & { findOrFail(pks: unknown[]): Promise<ModelBase[]> };
    const attempts: (() => Promise<unknown>)[] = [
      async () => await Task.where('title', 'a').first(),
      async () => await Task.where('id', 't1').orWhere('title', 'b'),
      async () => await Task.where('id', 't1').where('title', 'a'),
      async () => await T.findOrFail(['t1', 't2']),
      async () => await Task.where('id', '!=', 't1'),
    ];
    for (const [i, attempt] of attempts.entries()) {
      let err: unknown;
      try {
        await as(alice, attempt);
      } catch (e) {
        err = e;
      }
      expect(err, `attempt ${i}`).to.be.instanceOf(AuthzConfigError);
    }
  });

  it('is off in production', async () => {
    env('production');
    expect(await as(alice, async () => (await Task.query()).length)).to.equal(2);
  });

  it('is a QueryMiddleware at order 95', () => {
    expect(new AccessGuardMiddleware().order).to.equal(95);
  });
});
```

The first loop runs one call site three times (one warning); the line after it is a second call site (the second warning).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/guard.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/guard/middleware.js'`.

- [ ] **Step 3: Write `src/guard/env.ts`**

```ts
import { Configuration, normalizeEnvironment } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

export type GuardMode = 'throw' | 'warn' | 'off';

interface ConfigSource {
  get<T>(path: string | string[]): T;
  readonly Env?: unknown;
}

// The rule of authnAppEnv (packages/authn/src/service/boot/env.ts): a development the configuration
// fell back to, which no env source names, counts as unset, so a forgotten env never warns in production.
function appEnv(config: ConfigSource | undefined): string | undefined {
  const env = config?.get<unknown>('process.env.APP_ENV');
  if (typeof env !== 'string') return undefined;
  if (env !== 'development') return env;
  const registered = DI.get<NodeJS.ProcessEnv>('process.env');
  return [config?.Env, registered?.APP_ENV, process.env.APP_ENV, process.env.NODE_ENV].includes('development') ? env : undefined;
}

/** `test`: throw; `development`: warn once per call site; any other env, or none: off. */
export function guardMode(config: ConfigSource | undefined = DI.get(Configuration) as unknown as ConfigSource | undefined): GuardMode {
  const env = appEnv(config);
  if (env === undefined) return 'off';
  const n = normalizeEnvironment(env);
  return n === 'test' ? 'throw' : n === 'dev' ? 'warn' : 'off';
}
```

- [ ] **Step 4: Write `src/guard/middleware.ts`**

```ts
import { AuthzConfigError, SYSTEM, currentPrincipal } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { InStatement, QueryMiddleware, SelectQueryBuilder, SqlOperator, WhereStatement, extractModelDescriptor } from '@spinajs/orm';
import type { IQueryStatement, QueryBuilder } from '@spinajs/orm';

import { ormLog, storageUnscoped } from '../host.js';
import { marksOf } from '../marker.js';
import { entryOf, nameOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { guardMode } from './env.js';

const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';

/**
 * Overview decision 11: exactly one primary-key value (`where(pk, v)`, `get(v)`, `findOrFail([v])`) is
 * a single-object load, which the route's check-before covers. The soft-delete and archive IS NULL
 * statements createQuery adds by default do not count.
 */
export function isSingleObjectLoad(query: SelectQueryBuilder, entry: ResourceEntry): boolean {
  const descriptor = extractModelDescriptor(query.Model as never);
  const defaults = [descriptor?.SoftDelete?.DeletedAt, descriptor?.Archived?.ArchivedAt].filter((c): c is string => typeof c === 'string' && c !== '');
  let keys = 0;
  for (const s of query.Statements as IQueryStatement[]) {
    if (s instanceof WhereStatement) {
      if (s.Operator === SqlOperator.NULL && typeof s.Column === 'string' && defaults.includes(s.Column)) continue;
      if (s.Column === entry.idColumn && s.Operator === SqlOperator.EQ && isScalar(s.Value)) {
        keys++;
        continue;
      }
      return false;
    }
    if (s instanceof InStatement) {
      // InStatement keeps its column and values in protected fields (statements.ts:288-302).
      const x = s as unknown as { _column: string; _val: unknown[]; _not: boolean };
      if (x._column === entry.idColumn && !x._not && x._val.length === 1 && isScalar(x._val[0])) {
        keys++;
        continue;
      }
      return false;
    }
    return false;
  }
  return keys === 1;
}

// The builder is built through DI and the ORM's statics, so their frames sit between this hook and the app.
const INTERNAL = /[\\/](di|util|orm|orm-sql|orm-sqlite|orm-postgres|orm-mysql|orm-mssql|authz|authz-orm)[\\/](src|lib)[\\/]|node:internal|node_modules[\\/](typescript-mix|lodash)/;

/** The first stack frame outside the ORM and this package: the app line that built the query. */
function callSite(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').slice(1).map((l) => l.trim());
  return frames.find((f) => f.startsWith('at ') && !INTERNAL.test(f)) ?? 'unknown call site';
}

/** Design §8: reads builders, never changes them. */
@Injectable(QueryMiddleware)
export class AccessGuardMiddleware extends QueryMiddleware {
  public order = 95;

  private readonly sites = new WeakMap<object, string>();
  private readonly warned = new Set<string>();

  afterQueryCreation(query: QueryBuilder): void {
    if (!(query instanceof SelectQueryBuilder) || !entryOf(query.Model)) return;
    // The stack is only worth taking where a warning may need it.
    if (guardMode() === 'warn') this.sites.set(query, callSite(new Error().stack));
  }

  beforeQueryExecution(query: QueryBuilder): void {
    if (!(query instanceof SelectQueryBuilder)) return;
    const entry = entryOf(query.Model);
    if (!entry) return;
    const marks = marksOf(query);
    if (marks?.accessible !== undefined || marks?.unscoped !== undefined) return;
    if (currentPrincipal() === SYSTEM || storageUnscoped() !== undefined) return;
    if (isSingleObjectLoad(query, entry)) return;
    const mode = guardMode();
    if (mode === 'off') return;
    const message = `authz-orm: a select of ${nameOf(query.Model)} (@AccessResource '${entry.type}') runs without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`;
    if (mode === 'throw') throw new AuthzConfigError(message);
    const site = this.sites.get(query) ?? 'unknown call site';
    if (this.warned.has(site)) return;
    this.warned.add(site);
    ormLog().warn(`${message} (${site})`);
  }
}
```

- [ ] **Step 5: Register it and document it**

Append to `packages/authz-orm/src/index.ts`:

```ts
// Registers AccessGuardMiddleware as a QueryMiddleware.
import './guard/middleware.js';
export { AccessGuardMiddleware } from './guard/middleware.js';
export { guardMode } from './guard/env.js';
```

Append to `packages/authz-orm/README.md`:

````md
## Keeping `authz_resource_ancestor` right

- Run the migration `AuthzResourceAncestor_2026_10_14_00_00_00` (connection `default`, like the RBAC
  tables). The table must be in the database of the resource tables and of `authz_assignment`.
- Writes through model builders keep it right: an insert writes the new rows' links; an update of a
  `@Parent` column recomputes the row and its subtree; a delete removes the links, turns undeleted
  children into roots, forgets the authz data at each deleted scope (assignments, links, rules, scope
  attributes) and, after the commit, publishes `AuthzChange` and audits `resource-deleted` as SYSTEM.
  `@Parent` updates and deletes run in a transaction (the caller's, or one the ORM opens).
- Bulk moves: `reparent(Model, ids, newParentId, column?)`. The app checks the new parent first.
- Raw SQL, another service or an import that writes `@Parent` columns: run
  `authz:ancestors-rebuild [type]` afterwards. `authz:ancestors-verify [type]` reports differences
  with exit code 1 (CI, health checks).

## Runtime guard

A select of many rows of an `@AccessResource` model must use `.accessible(permission)`,
`.unscoped(reason)` or run as SYSTEM (`authz().runAs(SYSTEM, reason, fn)`). A load of one row by its
primary key (`where(pk, v)`, `get(v)`, `findOrFail([v])`, `@FromModel`) is a single-object load that the
route's `@Access` check covers, and is not flagged. With `APP_ENV=test` a select without one throws
`AuthzConfigError`; with `APP_ENV=development` it warns once per call site; otherwise it is off.
````

- [ ] **Step 6: Run the tests**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/guard.test.ts`
Expected: PASS, `8 passing`.

`WhereStatement`, `InStatement` and `SqlOperator` are exported from `@spinajs/orm` (`statements.ts:152,288`, `enums.ts:47`); the dialect drivers subclass them, so `instanceof` holds. `where(pk, v)` stores operator `=` (`SqlOperator.EQ`).

Run: `cd packages/authz-orm && npm test`
Expected: PASS, `0 failing`.

- [ ] **Step 7: Commit**

```bash
git add packages/authz-orm/src packages/authz-orm/test/guard.test.ts packages/authz-orm/README.md
git commit -m "feat(authz-orm): runtime guard for selects without .accessible()"
```

---

### Task 9: Domain-boot check of the resource connection (overview decision 21)

**Files:**
- Create: `packages/authz-orm/src/contributor.ts`
- Modify: `packages/authz-orm/src/index.ts`
- Test: `packages/authz-orm/test/contributor.test.ts`

**Interfaces:**
- Consumes: `AuthzContributor` / `AuthzContribution` (`packages/authz/src/host/contributor.ts`; the host calls `contribute(domain)` at every domain boot and turns a throw into `AuthzConfigError` naming the contributor, `packages/authz/src/host/service.ts:422-431`); `registeredClasses`, `entryOf`, `nameOf` (Task 1).
- Produces: `storesConnection(config?): { name: string; key: string }` — the authz stores' connection by the rule of `packages/authz-rbac/src/stores/context.ts:65-79` (`authz.rbac.connection`, else `authz.admin.connection`, else `default`), copied because authz-orm does not depend on authz-rbac; `checkResourceConnections(orm, config?)`; `AuthzOrmContributor` (`@Singleton() @Injectable(AuthzContributor)`), which returns `{}` after the check.
- Rule: every `@AccessResource` model with at least one `@Parent` whose ORM connection is known must use the same driver as the stores' connection; otherwise `AuthzConfigError` naming each model with its connection, the stores' connection and the config key. Boot rule 12 cannot see connections, so the check lives here. Skipped while the ORM is not created yet (`DI.RootContainer.isResolved(Orm)` false) or for a model the ORM has not given a driver.

- [ ] **Step 1: Write the failing test**

Create `packages/authz-orm/test/contributor.test.ts`:

```ts
import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { Orm, OrmDriver } from '@spinajs/orm';

import { AuthzOrmContributor, checkResourceConnections, storesConnection } from '../src/contributor.js';
import { AccessResource, Parent } from '../src/index.js';
import { TestDb } from './support/db.js';

const expect = chai.expect;

const config = (values: Record<string, unknown>) => ({ get: <T>(path: string[]) => values[path.join('.')] as T });

describe('authz-orm resource connection check', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  afterEach(async () => {
    await db.clear();
  });

  it('reads the stores connection like authz-rbac', () => {
    expect(storesConnection(config({}))).to.deep.equal({ name: 'default', key: 'the ORM default connection' });
    expect(storesConnection(config({ 'authz.admin.connection': 'admin' }))).to.deep.equal({ name: 'admin', key: 'authz.admin.connection' });
    expect(storesConnection(config({ 'authz.admin.connection': 'admin', 'authz.rbac.connection': 'rbac' }))).to.deep.equal({ name: 'rbac', key: 'authz.rbac.connection' });
  });

  it('passes when every @Parent model is on the stores connection, refuses one that is not', async () => {
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    await db.define({ name: 'Plain', columns: { title: 'TEXT' }, decorate: (c) => AccessResource('plain')(c) });
    const sqlite = db.driver();
    const other = { Options: { Name: 'other' } } as unknown as OrmDriver;
    const orm = { Connections: new Map<string, OrmDriver>([['default', sqlite], ['sqlite', sqlite], ['other', other]]) } as unknown as Orm;
    expect(() => checkResourceConnections(orm, config({}))).to.not.throw();
    expect(() => checkResourceConnections(orm, config({ 'authz.rbac.connection': 'other' }))).to.throw(AuthzConfigError, /"other" \(authz\.rbac\.connection\).*Task_\d+_\d+ \(connection "sqlite"\)/);
    expect(() => checkResourceConnections(orm, config({ 'authz.rbac.connection': 'nope' }))).to.throw(AuthzConfigError, /no ORM connection named "nope"/);
  });

  it('is a contributor the domain boot runs', async () => {
    expect(DI.getRegisteredTypes(AuthzContributor)).to.include(AuthzOrmContributor);
    await db.define({ name: 'Task', columns: { project_id: 'TEXT' }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } });
    expect(await new AuthzOrmContributor().contribute('root')).to.deep.equal({});
    await (await testHost.domains()).service('root');
    await testHost.resetRoot();
  });
});
```

The Task model's class name is made unique by `TestDb.define` (`Task_<pid>_<n>`), hence the pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/authz-orm && npx ts-mocha -p tsconfig.json test/contributor.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/contributor.js'`.

- [ ] **Step 3: Write `src/contributor.ts`**

```ts
import { AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { Orm, extractModelDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { entryOf, nameOf, registeredClasses } from './registry.js';

interface ConfigSource {
  get<T>(path: string[]): T;
}

/** The connection of the authz stores, by authz-rbac's rule (packages/authz-rbac/src/stores/context.ts:65-79). */
export function storesConnection(config: ConfigSource | undefined = DI.get(Configuration) as unknown as ConfigSource | undefined): { name: string; key: string } {
  const rbac = config?.get<string | undefined>(['authz', 'rbac', 'connection']);
  if (typeof rbac === 'string' && rbac !== '') return { name: rbac, key: 'authz.rbac.connection' };
  const admin = config?.get<string | undefined>(['authz', 'admin', 'connection']);
  if (typeof admin === 'string' && admin !== '') return { name: admin, key: 'authz.admin.connection' };
  return { name: 'default', key: 'the ORM default connection' };
}

/**
 * The list query joins authz_resource_ancestor and authz_assignment with the resource table, and a delete
 * forgets scopes in the statement's transaction: models with @Parent must share the stores' connection.
 */
export function checkResourceConnections(orm: Orm, config?: ConfigSource): void {
  const { name, key } = storesConnection(config);
  const stores = orm.Connections.get(name);
  if (!stores) throw new AuthzConfigError(`authz-orm: ${key} gives ${JSON.stringify(name)}, but there is no ORM connection named ${JSON.stringify(name)} (connections: ${[...orm.Connections.keys()].join(', ')})`);
  const wrong: string[] = [];
  for (const cls of registeredClasses()) {
    if ((entryOf(cls)?.parents.length ?? 0) === 0) continue;
    const driver = extractModelDescriptor(cls as never)?.Driver as OrmDriver | undefined;
    if (driver === undefined || driver === stores) continue;
    wrong.push(`${nameOf(cls)} (connection ${JSON.stringify(driver.Options?.Name)})`);
  }
  if (wrong.length > 0) throw new AuthzConfigError(`authz-orm: @AccessResource models with @Parent must use the authz stores' connection ${JSON.stringify(name)} (${key}), where authz_resource_ancestor and authz_assignment live: ${wrong.join(', ')}`);
}

/** Runs the check at every domain boot; contributes nothing to the boot rules. */
@Singleton()
@Injectable(AuthzContributor)
export class AuthzOrmContributor extends AuthzContributor {
  contribute(_domain: string): AuthzContribution {
    if (DI.RootContainer.isResolved(Orm)) checkResourceConnections(DI.get(Orm) as Orm);
    return {};
  }
}
```

Append to `packages/authz-orm/src/index.ts`:

```ts
// Registers AuthzOrmContributor: the domain boot checks the resource connection.
export { AuthzOrmContributor, checkResourceConnections, storesConnection } from './contributor.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/authz-orm && npm run compile && npx ts-mocha -p tsconfig.json test/contributor.test.ts`
Expected: PASS, `3 passing`.

- [ ] **Step 5: Commit**

```bash
git add packages/authz-orm/src/contributor.ts packages/authz-orm/src/index.ts packages/authz-orm/test/contributor.test.ts
git commit -m "feat(authz-orm): domain boot refuses @Parent models off the authz stores connection"
```

---

### Task 10: Lane verification

- [ ] **Step 1: Package suite and snapshot**

Run: `cd packages/authz-orm && npm test`
Expected: PASS, `0 failing` (Postgres cases pending when it is down).

Run: `cd ../.. && npm run build 2>&1 | tail -3 && node scripts/api-snapshot.mjs --check`
Expected: the snapshot check prints no problem for `authz-orm`. (Until L5 lands, a build failure in `authz-queue` / `configuration-http` is expected and named in the lane hand-off.)

- [ ] **Step 2: Nothing imports the removed API from authz-orm**

Run: `grep -rnE "OrmScope|OrmNativeCompiler|ScopeColumn|authz-orm/native|filterFields|ownsBy" packages/authz-orm/src packages/authz-orm/test`
Expected: no output.

---

## Contract issues found

Resolved by the coordinator in `00-overview.md` and applied here:

1. **Delete clean-up vs the admin backend** (decision 20): with `DbAuthzAdminBackend` the forget runs in the ORM statement's transaction and the DB stores bump `authz_version`; with any other backend it runs after the commit in `backend.transaction()`, with `bumpVersion` there, best effort and logged (Task 5, `cleanup.ts`).
2. **Resource connection** (decision 21): `AuthzOrmContributor` refuses at domain boot an `@AccessResource` model with `@Parent` that is not on the stores' connection (Task 9).
3. **Post-commit hook** (decision 18): Task 5 uses L1's `driver.afterCommit(cb)`; nothing patches `OrmDriver.prototype.transaction`.
4. **Owner type column**: `Owner(opts?: { typeColumn? })`, `registerAccessResource(…, { owner: string | { column, typeColumn? } })`, `ResourceEntry.owner.typeColumn?` (Tasks 1, 3).
5. **Guard and single-object loads** (decision 11): one primary-key equality is not flagged (Task 8).
6. **`reparent`** (decision 22) is an authz-orm export frozen in its `api.ts` (RFC RA3-1), not an `authz()` method.

Still open:

7. **`ResourceEntry` shape.** The names table lists `parents: { property, column, type }[]`; L3's entry adds `nullable` per parent and `registered` (a superset other lanes can ignore).
8. **Task renumbering.** The coordinator's task 4 is split into Tasks 4 (closure engine) and 5 (middleware); `reparent`, CLI and guard are Tasks 6–8, the boot check Task 9. Tasks 1–3 (L5's gate) are unchanged.
