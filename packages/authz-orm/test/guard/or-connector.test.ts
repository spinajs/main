import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, TRUE, authzStorage } from '@spinajs/authz';
import type { Decision, Principal } from '@spinajs/authz';
import { testHost } from '@spinajs/authz-testing';
import { Archived, BelongsTo, SoftDelete } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };

type Page = { orderBy: Array<[string, 'asc' | 'desc']>; limit: number; after?: string };
type W = PromiseLike<ModelBase[]> & {
  first(): Promise<ModelBase | undefined>;
  selectCount(): Promise<number>;
  where(...a: unknown[]): W;
  orWhere(...a: unknown[]): W;
  withDeleted(): W;
  withArchived(): W;
  order(column: string): W;
  unscoped(reason: string): W;
  paginate(page: Page): Promise<{ items: ModelBase[]; next: string | null }>;
  stream(options: { batchSize: number }): AsyncIterable<ModelBase>;
};
type M = typeof ModelBase & { query(): W; where(...a: unknown[]): W; get(pk: unknown): Promise<ModelBase>; findOrFail(pks: unknown[]): Promise<ModelBase[]> };

// The route's check-before allowed alice to read t1 unconditionally; t2 is bob's row.
const decided = { allowed: true, permission: 'task:read', resource: { type: 'task', id: 't1' }, residual: TRUE } as unknown as Decision;
const inRoute = <T>(fn: () => PromiseLike<T>) => authzStorage().run({ Principal: alice, AuthzDecision: decided }, async () => fn());

const settle = async (fn: () => PromiseLike<unknown>): Promise<unknown> => {
  try {
    return await inRoute(fn);
  } catch (e) {
    return e;
  }
};

const ids = (rows: unknown): string[] => (rows as { id: string }[]).map((r) => r.id).sort();

describe('authz-orm guard: an OR connector makes a select a list', function () {
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
      let Task: M;

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        Task = await db.define(
          {
            name: 'Task',
            columns: { owner: 'TEXT', deleted_at: 'TEXT', archived_at: 'TEXT' },
            rows: [
              { id: 't1', owner: 'alice' },
              { id: 't2', owner: 'bob' },
            ],
            decorate: (c, proto) => {
              AccessResource('task')(c);
              (SoftDelete() as PropertyDecorator)(proto, 'deleted_at');
              (Archived() as PropertyDecorator)(proto, 'archived_at');
            },
          },
          dialect,
        );
        testHost.config().set(['process', 'env', 'APP_ENV'], 'test');
      });

      afterEach(async () => {
        testHost.config().unset(['process', 'env', 'APP_ENV']);
        await db.clear();
      });

      // The scopes compile ANDed with the rest: `deleted_at IS NULL AND archived_at IS NULL AND id = ?` reads one row.
      it('lets an orWhere on the primary key after the soft-delete and archive scopes through: it reads that row only', async () => {
        expect(ids(await inRoute(() => Task.query().orWhere('id', 't1')))).to.deep.equal(['t1']);
        expect(ids(await inRoute(() => Task.query().withDeleted().orWhere('id', 't1')))).to.deep.equal(['t1']);
        expect(((await inRoute(() => Task.query().orWhere('id', 't1').first())) as unknown as { id: string }).id).to.equal('t1');
        expect(await inRoute(() => Task.query().orWhere('id', 't1').selectCount())).to.equal(1);
      });

      it("flags an orWhere that can read more than one row: bob's row is not returned", async () => {
        expect(await settle(() => Task.query().orWhere('id', 't1').orWhere('id', 't2'))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Task.where('id', 't1').orWhere('owner', 'bob'))).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Task.where('id', 't1').orWhere('owner', 'bob').first())).to.be.instanceOf(AuthzConfigError);
        expect(await settle(() => Task.where('id', 't1').orWhere('owner', 'bob').selectCount())).to.be.instanceOf(AuthzConfigError);
      });

      it('flags a primary-key load widened by an orWhere on the soft-delete column', async () => {
        expect(await settle(() => Task.where('id', 't1').orWhere('deleted_at', null))).to.be.instanceOf(AuthzConfigError);
      });

      it('flags a condition of its own on the soft-delete column next to the key: only the scopes do not count', async () => {
        expect(await settle(() => Task.query().orWhere('id', 't1').whereNull('deleted_at'))).to.be.instanceOf(AuthzConfigError);
      });

      it('still lets single-object loads through, an orWhere that is the only statement included', async () => {
        expect(((await inRoute(() => Task.where('id', 't1').first())) as unknown as { id: string }).id).to.equal('t1');
        expect(((await inRoute(() => Task.get('t1'))) as unknown as { id: string }).id).to.equal('t1');
        expect(ids(await inRoute(() => Task.findOrFail(['t1'])))).to.deep.equal(['t1']);
        expect(ids(await inRoute(() => Task.query().withDeleted().withArchived().orWhere('id', 't1')))).to.deep.equal(['t1']);
      });

      // A later page ANDs the keyset predicate past the cursor, which only narrows, so it does not count either.
      const byId: Page['orderBy'] = [['id', 'asc']];
      const pastT1 = async () => (await inRoute(() => Task.query().unscoped('cursor for the test').paginate({ orderBy: byId, limit: 1 }))).next ?? undefined;

      it('lets every page and the keyset stream of a primary-key load through: one row each', async () => {
        const after = await pastT1();
        expect(ids((await inRoute(() => Task.where('id', 't1').paginate({ orderBy: byId, limit: 1 }))).items)).to.deep.equal(['t1']);
        expect(ids((await inRoute(() => Task.where('id', 't2').paginate({ orderBy: byId, limit: 1, after }))).items)).to.deep.equal(['t2']);

        const streamed: ModelBase[] = [];
        await inRoute(async () => {
          for await (const row of Task.where('id', 't1').order('id').stream({ batchSize: 1 })) streamed.push(row);
        });
        expect(ids(streamed)).to.deep.equal(['t1']);
      });

      it('lets a lazy belongsTo load of the one related row through, and flags a callback that makes it a list', async () => {
        const Note = await db.define(
          {
            name: 'Note',
            columns: { task_id: 'TEXT' },
            rows: [{ id: 'n1', task_id: 't1' }],
            decorate: (_c, proto) => (BelongsTo(Task, 'task_id', 'id') as PropertyDecorator)(proto, 'Task'),
          },
          dialect,
        );
        type Lazy = { Task: { Value?: { id: string }; populate(callback?: (this: W) => void): Promise<void> } };
        const note = (await Note.where('id', 'n1').first()) as unknown as Lazy;

        await inRoute(() => note.Task.populate());
        expect(note.Task.Value?.id).to.equal('t1');
        expect(
          await settle(() =>
            note.Task.populate(function () {
              this.where('owner', 'bob').orWhere('owner', 'alice');
            }),
          ),
        ).to.be.instanceOf(AuthzConfigError);
      });

      it('flags a list on a later page', async () => {
        const after = await pastT1();
        for (const list of [() => Task.query(), () => Task.where('owner', 'bob'), () => Task.where('id', 't1').orWhere('id', 't2')]) {
          expect(await settle(() => list().paginate({ orderBy: byId, limit: 1, after }))).to.be.instanceOf(AuthzConfigError);
        }
      });
    });
  }
});
