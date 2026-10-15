import * as chai from 'chai';
import 'mocha';

import { AccessDenied, AuthorizationModel, PlanTermSql, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import type { ListPlanRequest, ListSupport, ModelListPlan, PermissionDef, Principal, ResourceType } from '@spinajs/authz';
import { StaticModel, testHost } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { FlagSql } from '../support/flag-sql.js';

const expect = chai.expect;

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'test', attributes: {} });

/** Green rows for everyone, own rows for their owner, never red ones; nobody (user 'eve') gets none. */
class ListModel extends StaticModel {
  listSupport(_p: PermissionDef, _t: ResourceType): ListSupport {
    return true;
  }
  async listPlan(req: ListPlanRequest): Promise<ModelListPlan> {
    if (req.principal.id === 'eve') return { kind: 'abstain' };
    return { kind: 'terms', permit: [{ op: 'test.flag', args: { flag: 'green' } }, { op: 'relation.owner', args: { principals: [{ type: req.principal.type, id: req.principal.id }] } }], deny: [{ op: 'test.flag', args: { flag: 'red' } }] };
  }
}

type Q = Promise<(ModelBase & Record<string, unknown>)[]> & { accessible(p: string): Q; withAccess(p: string[]): Q };
type M = Omit<typeof ModelBase, 'query'> & { query(): Q };

describe('lists through the engine', function () {
  this.timeout(60000);
  let db: TestDb;
  let pg = false;
  const undo: (() => void | Promise<void>)[] = [];

  before(async () => {
    pg = await TestDb.postgresReachable();
    db = await TestDb.open({ postgres: pg });
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    undo.push(testHost.registerInRoot(PlanTermSql, FlagSql));
    const cfg = testHost.config();
    cfg.set(['authz', 'domains', 'lists'], { permissions: { 'task:read': { types: ['task'], list: true }, 'task:update': { types: ['task'], list: true } }, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
    cfg.set(['authz', 'orm', 'domain'], 'lists');
    undo.push(() => cfg.unset(['authz', 'domains', 'lists']), () => cfg.unset(['authz', 'orm', 'domain']));
  });

  // The engine refuses resource types registered after boot, so the domain boots once the model is defined.
  async function bootLists(): Promise<void> {
    const ds = await testHost.domains();
    await ds.service('root');
    const container: IContainer = ds.create('lists', 'root');
    container.register(testHost.instance(new ListModel({ name: 'm1', votes: {} }))).as(AuthorizationModel);
    undo.push(() => container.dispose());
    await ds.service('lists');
  }

  afterEach(async () => {
    for (const fn of undo.splice(0).reverse()) await fn();
    await testHost.resetRoot();
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = (await db.define({ name: 'Task', columns: { flag: 'TEXT', owner: 'TEXT' }, rows: [{ id: 't1', flag: 'green', owner: 'bob' }, { id: 't2', flag: 'blue', owner: 'alice' }, { id: 't3', flag: 'red', owner: 'alice' }, { id: 't4', flag: 'blue', owner: 'bob' }], decorate: (c, p) => { AccessResource('task')(c); Owner()(p, 'owner'); } }, dialect)) as M;
        await bootLists();
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const ids = (rows: ModelBase[]) => rows.map((r) => String((r as unknown as { id: unknown }).id)).sort();

      it('permits green and own rows, denies red ones', async () => {
        expect(ids(await runWithPrincipal(user('alice'), () => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't2']);
        expect(ids(await runWithPrincipal(user('bob'), () => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't4']);
      });

      it('SYSTEM lists everything; a principal no model plans for is AccessDenied', async () => {
        expect(ids(await runWithPrincipal(SYSTEM, () => Task.query().accessible('task:read')))).to.deep.equal(['t1', 't2', 't3', 't4']);
        let err: unknown;
        try {
          await runWithPrincipal(user('eve'), () => Task.query().accessible('task:read'));
        } catch (e) {
          err = e;
        }
        expect(err).to.be.instanceOf(AccessDenied);
      });

      it('withAccess agrees with the list for the same permission', async () => {
        const rows = await runWithPrincipal(user('alice'), () => Task.query().accessible('task:read').withAccess(['task:update']));
        expect(Object.fromEntries(rows.map((r) => [r.id, (r.$access as Record<string, boolean>)['task:update']]))).to.deep.equal({ t1: true, t2: true });
      });
    });
  }
});
