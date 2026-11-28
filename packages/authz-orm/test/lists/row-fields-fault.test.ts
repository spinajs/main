import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import { AuthorizationModel, Authorizer, CORE_FILTER_OPS, FALSE, PermissionRegistryImpl, TRUE, authzStorage, redact, resourceKey, rowFieldsOf, runWithPrincipal } from '@spinajs/authz';
import type { AccessPlan, AuthzService, Decision, DenyReason, ModelCapabilities, PermissionDef, Principal, ResourceRef, ResourceType, Vote } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { OrmResourceAdapter } from '../../src/adapter.js';
import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../../src/ancestors/index.js';
import { AccessResource, PlanTermCompiler } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';

const expect = chai.expect;

/** One atom per flag, as RBAC splits one per role: each flag is its own group of rows. */
class FlagsTerm extends PlanTermCompiler {
  readonly op = 'test.flags';

  apply(args: unknown, where: IWhereBuilder<unknown>): void {
    where.whereIn('flag', [...flagsOf(args)]);
  }

  atoms(args: unknown): readonly unknown[] {
    return flagsOf(args).map((flag) => ({ flags: [flag] }));
  }
}

function flagsOf(args: unknown): string[] {
  const flags: unknown = args !== null && typeof args === 'object' && 'flags' in args ? args.flags : undefined;
  return Array.isArray(flags) ? flags.map(String) : [];
}

class AllowAll extends AuthorizationModel {
  readonly name = 'all';
  readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false };

  init(): void {
    return;
  }

  applies(_def: PermissionDef, _type: ResourceType): boolean {
    return true;
  }

  evaluate(): Vote {
    return { model: 'all', permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
  }
}

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const FIELDS: Record<string, string[]> = { t1: ['id', 'title'], t2: ['id'], t4: ['secret'] };
// Groups in row order: green (t1, t3), red (t2), black (t4).
const plan: AccessPlan = { kind: 'filter', permit: [{ op: 'test.flags', args: { flags: ['green', 'red'] } }], deny: [{ op: 'test.flags', args: { flags: ['black'] } }] };
const ROWS = [
  { id: 't1', flag: 'green', title: 'title-of-t1', secret: 'secret-of-t1' },
  { id: 't2', flag: 'red', title: 'title-of-t2', secret: 'secret-of-t2' },
  { id: 't3', flag: 'green', title: 'title-of-t3', secret: 'secret-of-t3' },
  { id: 't4', flag: 'black', title: 'title-of-t4', secret: 'secret-of-t4' },
];

const MODEL_ERROR: DenyReason = { code: 'model_error' };

const decision = (r: { permission: string; resource: ResourceRef }, reason?: DenyReason): Decision => ({
  allowed: reason === undefined,
  permission: r.permission,
  resource: r.resource,
  principal: { type: 'user', id: 'alice' },
  residual: reason === undefined ? TRUE : FALSE,
  fields: { read: reason === undefined ? FIELDS[r.resource.id ?? ''] : [], write: [] },
  roles: {},
  ...(reason === undefined ? {} : { reason }),
  domain: 'root',
});

type M = typeof ModelBase;

/** `.withFields()` is declared on the select builder class only. */
function select(model: M): SelectQueryBuilder<ModelBase[]> {
  const query = model.query();
  if (!(query instanceof SelectQueryBuilder)) throw new Error(`${model.name}.query() is not a select builder`);
  return query;
}

/** What the caller gets: per row its field set and the row as redact() hands it out; or the rejection. */
type Outcome = { rejected: Error } | { rows: Record<string, { fields: readonly string[] | undefined; json: string }> };

const settle = (list: PromiseLike<readonly ModelBase[]>): Promise<Outcome> =>
  Promise.resolve(list).then(
    (rows) => ({ rows: Object.fromEntries(rows.map((r) => [String(Reflect.get(r, 'id')), { fields: rowFieldsOf(r), json: JSON.stringify(redact(r, { read: [] })) }])) }),
    (e: unknown) => ({ rejected: e instanceof Error ? e : new Error(String(e)) }),
  );

/** The rejection names the type, the permission and the group counts, and no row id or value. */
function expectFault(out: Outcome, faulted: number, groups: number): void {
  if (!('rejected' in out)) throw new Error(`the list resolved: ${JSON.stringify(out.rows)}`);
  const e = out.rejected;
  expect(e.constructor).to.equal(Error);
  expect(e.message).to.equal(`authz-orm: the readable fields of ${faulted} of ${groups} task row group(s) under task:read could not be decided: the engine answered model_error (an engine or adapter fault)`);
  for (const row of ROWS) for (const v of Object.values(row)) if (v !== 'red' && v !== 'green' && v !== 'black') expect(e.message).to.not.include(v);
}

const ALL_FIELDS = { t1: ['id', 'title'], t2: ['id'], t3: ['id', 'title'], t4: [] };

describe('.withFields() when a group of rows is decided by an engine fault', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  let service: AuthzService;
  const undo: (() => void)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermCompiler, FlagsTerm));
    service = await (await testHost.domains()).service('root');
    sinon.stub(service, 'accessPlan').resolves(plan);
  });

  afterEach(async () => {
    sinon.restore();
    for (const fn of undo.splice(0).reverse()) fn();
    DI.RootContainer.uncache(PlanTermCompiler);
    await testHost.resetRoot();
  });

  const as = (fn: () => PromiseLike<readonly ModelBase[]>) => runWithPrincipal(alice, async () => await fn());
  const listWithFields = (model: M) => settle(as(() => select(model).withFields('task:read').unscoped('test')));
  const answer = (deny: Record<string, DenyReason>) =>
    sinon.stub(service, 'checkAll').callsFake(async (_p, requests) => requests.map((r) => decision(r, r.resource.id === undefined ? undefined : deny[r.resource.id])));

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(`${dialect}, the decisions stubbed`, () => {
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = await db.define({ name: 'Task', columns: { flag: 'TEXT', title: 'TEXT', secret: 'TEXT' }, rows: ROWS, decorate: (c) => AccessResource('task')(c) }, dialect);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('rejects the whole list when one group is a model_error deny, never handing its rows out blank', async () => {
        answer({ t2: MODEL_ERROR, t4: { code: 'no_access' } });

        expectFault(await listWithFields(Task), 1, 3);
      });

      it('rejects when the faulted group is the first or the last of the batch', async () => {
        answer({ t1: MODEL_ERROR });
        expectFault(await listWithFields(Task), 1, 3);

        sinon.restore();
        sinon.stub(service, 'accessPlan').resolves(plan);
        answer({ t4: { code: 'model_error', model: 'rbac' } });
        expectFault(await listWithFields(Task), 1, 3);
      });

      it('counts every faulted group', async () => {
        answer({ t1: MODEL_ERROR, t4: MODEL_ERROR });

        expectFault(await listWithFields(Task), 2, 3);
      });

      it(".accessible() under fields: 'filter-rows' rejects the same way", async () => {
        answer({ t2: MODEL_ERROR });

        expectFault(await settle(as(() => authzStorage().run({ ...authzStorage().getStore(), AuthzRowFields: true }, async () => await Task.query().accessible('task:read')))), 1, 2);
      });

      it('a list of one group rejects when that group faulted', async () => {
        answer({ t2: MODEL_ERROR });

        expectFault(await settle(as(() => select(Task).where('flag', 'red').withFields('task:read').unscoped('test'))), 1, 1);
      });

      it('rejects when the field plan itself is a model_error none plan', async () => {
        sinon.restore();
        sinon.stub(service, 'accessPlan').resolves({ kind: 'none', reason: { code: 'model_error', model: 'rbac' } });
        const checkAll = answer({});

        const out = await listWithFields(Task);
        if (!('rejected' in out)) throw new Error(`the list resolved: ${JSON.stringify(out.rows)}`);
        expect(out.rejected.constructor).to.equal(Error);
        expect(out.rejected.message).to.equal('authz-orm: the readable fields of task rows under task:read could not be decided: the field plan answered model_error (an engine or adapter fault)');
        expect(checkAll.callCount).to.equal(0);
      });

      it('keeps a none field plan for an ordinary reason', async () => {
        sinon.restore();
        sinon.stub(service, 'accessPlan').resolves({ kind: 'none', reason: { code: 'no_access' } });
        answer({});

        expect(await listWithFields(Task)).to.deep.equal({ rows: Object.fromEntries(ROWS.map((r) => [r.id, { fields: [], json: '{}' }])) });
      });

      it('a model_error none field plan over no row resolves empty', async () => {
        sinon.restore();
        sinon.stub(service, 'accessPlan').resolves({ kind: 'none', reason: { code: 'model_error', model: 'rbac' } });
        answer({});

        expect(await settle(as(() => select(Task).where('flag', 'none-such').withFields('task:read').unscoped('test')))).to.deep.equal({ rows: {} });
      });

      // policy_error: rule codes from configuration are free strings, so a code may end in _error and still be a decided deny.
      for (const code of ['no_access', 'residual_false', 'unknown_resource', 'invalid_request', 'role_denied', 'policy_error']) {
        it(`keeps an ordinary ${code} deny: that group reads no field, the others theirs`, async () => {
          answer({ t4: { code } });

          expect(await listWithFields(Task)).to.deep.equal({
            rows: {
              t1: { fields: ['id', 'title'], json: '{"id":"t1","title":"title-of-t1"}' },
              t2: { fields: ['id'], json: '{"id":"t2"}' },
              t3: { fields: ['id', 'title'], json: '{"id":"t3","title":"title-of-t3"}' },
              t4: { fields: [], json: '{}' },
            },
          });
        });
      }

      it('leaves allowed groups as they are', async () => {
        answer({});

        const out = await listWithFields(Task);
        if (!('rows' in out)) throw out.rejected;
        expect(Object.fromEntries(Object.entries(out.rows).map(([id, r]) => [id, r.fields]))).to.deep.equal({ ...ALL_FIELDS, t4: ['secret'] });
      });
    });
  }

  describe('sqlite, the real engine over the ORM adapter', () => {
    let Task: M;
    let authorizer: Authorizer;
    const logged: string[] = [];

    beforeEach(async () => {
      await createAncestorTable(db, 'sqlite');
      Task = await db.define({ name: 'Task', columns: { flag: 'TEXT', title: 'TEXT', secret: 'TEXT' }, rows: ROWS, decorate: (c) => AccessResource('task')(c) });
      const registry = new PermissionRegistryImpl();
      registry.register([{ name: 'task:read', types: ['task'] }], 'row-fields-fault');
      registry.freeze();
      logged.length = 0;
      authorizer = new Authorizer({
        domain: 'root',
        models: [new AllowAll()],
        registry,
        adapters: [new OrmResourceAdapter()],
        log: { error: (_f: unknown, text: string) => logged.push(text), warn: () => undefined, debug: () => undefined },
      });
      sinon.stub(service, 'checkAll').callsFake((p, requests) => authorizer.checkAll(p, requests));
    });

    afterEach(async () => {
      await db.clear();
      await dropAncestorTable(db, 'sqlite');
    });

    it('answers every group when the adapter works', async () => {
      const out = await listWithFields(Task);
      if (!('rows' in out)) throw out.rejected;
      expect(Object.fromEntries(Object.entries(out.rows).map(([id, r]) => [id, r.fields]))).to.deep.equal({ t1: ['*', '!Password'], t2: ['*', '!Password'], t3: ['*', '!Password'], t4: ['*', '!Password'] });
      expect(logged).to.deep.equal([]);
    });

    it('rejects the list when the ancestor read of one group fails', async () => {
      const read = sinon.stub(OrmResourceAdapter.prototype, 'ancestorsMany').callThrough();
      read.withArgs(sinon.match((refs: readonly ResourceRef[]) => refs.some((r) => resourceKey(r) === 'task:t2'))).rejects(new Error('SQLITE_IOERR simulated'));

      expectFault(await listWithFields(Task), 1, 3);
    });

    it('rejects the list on a real SQL error: the ancestor table is gone', async () => {
      await db.raw(`ALTER TABLE ${AUTHZ_RESOURCE_ANCESTOR_TABLE} RENAME TO ${AUTHZ_RESOURCE_ANCESTOR_TABLE}_gone`);
      try {
        expectFault(await listWithFields(Task), 3, 3);
        expect(logged.some((l) => l.includes('failed'))).to.equal(true);
      } finally {
        await db.raw(`ALTER TABLE ${AUTHZ_RESOURCE_ANCESTOR_TABLE}_gone RENAME TO ${AUTHZ_RESOURCE_ANCESTOR_TABLE}`);
      }
    });
  });
});
