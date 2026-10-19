import * as chai from 'chai';
import 'mocha';

import type { ResourceRef } from '@spinajs/authz';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { readParents } from '../../src/ancestors/store.js';
import { stillThere } from '../../src/ancestors/targets.js';
import { AccessResource, Parent, entryOf } from '../../src/index.js';
import { findRows } from '../../src/rows.js';
import { createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

const COUNT = 2500;

/** The result of `fn` and the number of statements `driver` executed while it ran. */
async function statements<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const spied = driver as unknown as { execute(...args: unknown[]): Promise<unknown> };
  const original = spied.execute;
  let count = 0;
  spied.execute = function (this: unknown, ...args: unknown[]) {
    count++;
    return original.apply(this, args);
  };
  try {
    return { result: await fn(), count };
  } finally {
    delete (spied as unknown as Record<string, unknown>).execute;
  }
}

/** Task rows 1..count, task i under project p<i>, in one INSERT. */
async function insertTasks(db: TestDb, model: typeof ModelBase, dialect: Dialect, count: number): Promise<void> {
  const params: unknown[] = [];
  const rows: string[] = [];
  for (let i = 1; i <= count; i++) {
    rows.push(dialect === 'postgres' ? `($${params.length + 1}, $${params.length + 2})` : '(?, ?)');
    params.push(i, `p${i}`);
  }
  await db.raw(`INSERT INTO "${db.table(model)}" ("id", "project_id") VALUES ${rows.join(', ')}`, params, dialect);
}

describe('reads of many resources', function () {
  this.timeout(120000);
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
      let Task: typeof ModelBase;
      const tasks = (): ResourceRef[] => Array.from({ length: COUNT }, (_, i) => ({ type: 'task', id: String(i + 1) }));

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        Task = await db.define(
          {
            name: 'Task',
            columns: { id: 'INTEGER', project_id: 'TEXT' },
            decorate: (c, p) => {
              AccessResource('task')(c);
              Parent('project')(p, 'project_id');
            },
          },
          dialect,
        );
        await insertTasks(db, Task, dialect, COUNT);
      });

      afterEach(async () => {
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      it('readParents reads every row of a class in one statement', async () => {
        const d = db.driver(dialect);
        const { result, count } = await statements(d, () => readParents(d, [...tasks(), { type: 'task', id: 'not-a-number' }]));
        expect(count).to.equal(1);
        expect(result.size).to.equal(COUNT);
        expect(result.get('task:2500')).to.deep.equal([{ type: 'project', id: 'p2500' }]);
      });

      it('stillThere checks every ref in one statement', async () => {
        const d = db.driver(dialect);
        const { result, count } = await statements(d, () => stillThere(d, Task, entryOf(Task)!, [...tasks(), { type: 'task', id: '999999' }]));
        expect(count).to.equal(1);
        expect(result.size).to.equal(COUNT);
        expect(result.has('999999')).to.equal(false);
      });

      it('findRows loads every row of a class in one statement', async () => {
        const { result, count } = await statements(db.driver(dialect), () => findRows(tasks()));
        expect(count).to.equal(1);
        expect(result.size).to.equal(COUNT);
      });
    });
  }
});
