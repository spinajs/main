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
        await db.define(
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
