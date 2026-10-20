import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { ModelBase, QueryBuilder } from '@spinajs/orm';

import { AccessResource, Owner, Relation, Self } from '../../src/index.js';
import type { PlanTermCompiler } from '../../src/plan/index.js';
import { entryOf } from '../../src/registry.js';
import { RelationColumnTerm, RelationOwnerTerm, RelationSelfTerm, planRow } from '../../src/lists/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

type Resource = typeof ModelBase & { query(): QueryBuilder };
const p = (type: string, id: string) => ({ type, id });

describe('relation.owner / relation.self / relation.column terms', function () {
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
      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      afterEach(async () => {
        await db.clear();
      });

      async function ids(model: Resource, compiler: PlanTermCompiler, args: unknown): Promise<string[]> {
        const row = planRow(model.query(), entryOf(model)!);
        const rows = (await db
          .driver(dialect)
          .select()
          .from(db.table(model))
          .where(function () {
            compiler.apply(args, this, row);
          })
          .asRaw()) as { id: unknown }[];
        return rows.map((r) => String(r.id)).sort();
      }

      it('relation.owner without a type column: user principals against the column as text', async () => {
        const Task = (await db.define(
          {
            name: 'Task',
            columns: { owner_id: 'INTEGER' },
            rows: [
              { id: 'a', owner_id: 1 },
              { id: 'b', owner_id: 2 },
            ],
            decorate: (c, proto) => {
              AccessResource('task')(c);
              Owner()(proto, 'owner_id');
            },
          },
          dialect,
        )) as Resource;
        const owner = new RelationOwnerTerm();
        expect(await ids(Task, owner, { principals: [p('user', '1'), p('user', 'x'), p('agent', '2')] })).to.deep.equal(['a']);
        expect(await ids(Task, owner, { principals: [p('agent', '2')] })).to.deep.equal([]);
      });

      it('relation.owner with a type column: type and id', async () => {
        const Job = (await db.define(
          {
            name: 'Job',
            columns: { initiator_id: 'TEXT', initiator_type: 'TEXT' },
            rows: [
              { id: 'j1', initiator_id: 'alice', initiator_type: 'user' },
              { id: 'j2', initiator_id: 'bot', initiator_type: 'agent' },
              { id: 'j3', initiator_id: 'bob', initiator_type: 'user' },
              { id: 'j4', initiator_id: 'alice', initiator_type: 'agent' },
            ],
            decorate: (c, proto) => {
              AccessResource('job')(c);
              Owner({ typeColumn: 'initiator_type' })(proto, 'initiator_id');
            },
          },
          dialect,
        )) as Resource;
        expect(await ids(Job, new RelationOwnerTerm(), { principals: [p('user', 'alice'), p('agent', 'bot')] })).to.deep.equal(['j1', 'j2']);
        expect(await ids(Job, new RelationOwnerTerm(), { principals: [] })).to.deep.equal([]);
      });

      it('relation.self: the self column against user principals', async () => {
        const Account = (await db.define(
          {
            name: 'Account',
            columns: { Uuid: 'TEXT' },
            rows: [
              { id: '1', Uuid: 'u1' },
              { id: '2', Uuid: 'u2' },
            ],
            decorate: (c, proto) => {
              AccessResource('account')(c);
              Self()(proto, 'Uuid');
            },
          },
          dialect,
        )) as Resource;
        expect(await ids(Account, new RelationSelfTerm(), { principals: [p('user', 'u1'), p('agent', 'u2')] })).to.deep.equal(['1']);
      });

      it('refuses malformed args and a type without the relation', async () => {
        const Plain = (await db.define({ name: 'Plain', columns: {}, decorate: (c) => AccessResource('plain')(c) }, dialect)) as Resource;
        const row = planRow(Plain.query(), entryOf(Plain)!);
        const where = db.driver(dialect).select().from(db.table(Plain));
        const owner = new RelationOwnerTerm();
        for (const bad of [null, {}, { principals: 'alice' }, { principals: [{ type: 'user' }] }, { principals: [{ type: 'user', id: 1 }] }]) {
          expect(() => owner.apply(bad, where, row), JSON.stringify(bad)).to.throw(AuthzConfigError);
        }
        expect(() => owner.apply({ principals: [] }, where, row)).to.throw(AuthzConfigError, /no owner column/);
        expect(() => new RelationSelfTerm().apply({ principals: [] }, where, row)).to.throw(AuthzConfigError, /no self column/);
      });

      it('relation.column: the named relation like owner, with or without a type column', async () => {
        const Task = (await db.define(
          {
            name: 'Task',
            columns: { assignee_id: 'TEXT', reviewer_id: 'TEXT', reviewer_type: 'TEXT' },
            rows: [
              { id: 'a', assignee_id: 'alice', reviewer_id: 'bot', reviewer_type: 'agent' },
              { id: 'b', assignee_id: 'bob', reviewer_id: 'bot', reviewer_type: 'user' },
            ],
            decorate: (c, proto) => {
              AccessResource('task')(c);
              Relation('assignee')(proto, 'assignee_id');
              Relation('reviewer', { typeColumn: 'reviewer_type' })(proto, 'reviewer_id');
            },
          },
          dialect,
        )) as Resource;
        const column = new RelationColumnTerm();
        expect(await ids(Task, column, { relation: 'assignee', principals: [p('user', 'alice'), p('agent', 'bob')] })).to.deep.equal(['a']);
        expect(await ids(Task, column, { relation: 'reviewer', principals: [p('agent', 'bot')] })).to.deep.equal(['a']);
        expect(await ids(Task, column, { relation: 'reviewer', principals: [] })).to.deep.equal([]);
      });

      it('relation.column refuses malformed args, an undeclared relation and inherited object members', async () => {
        const Task = (await db.define(
          {
            name: 'Task',
            columns: { assignee_id: 'TEXT' },
            decorate: (c, proto) => {
              AccessResource('task')(c);
              Owner()(proto, 'assignee_id');
              Relation('assignee')(proto, 'assignee_id');
            },
          },
          dialect,
        )) as Resource;
        const row = planRow(Task.query(), entryOf(Task)!);
        const where = db.driver(dialect).select().from(db.table(Task));
        const column = new RelationColumnTerm();
        expect(row.relation('assignee')).to.deep.equal({ column: 'assignee_id' });
        expect(() => column.apply({ principals: [] }, where, row)).to.throw(AuthzConfigError, /relation.column args/);
        for (const name of ['missing', 'owner', 'constructor', 'toString']) {
          if (name !== 'owner') expect(row.relation(name)).to.equal(undefined);
          expect(() => column.apply({ relation: name, principals: [] }, where, row), name).to.throw(AuthzConfigError, new RegExp(`no column relation '${name}'`));
        }
      });
    });
  }
});
