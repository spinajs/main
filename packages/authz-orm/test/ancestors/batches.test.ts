import * as chai from 'chai';
import 'mocha';

import type { ResourceRef } from '@spinajs/authz';
import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { readParents } from '../../src/ancestors/store.js';
import { AccessResource, Parent } from '../../src/index.js';
import { findRows } from '../../src/rows.js';
import { readAncestors } from '../../src/ancestors/read.js';
import { rebuildNodes, removeNodes } from '../../src/ancestors/rebuild.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable } from '../support/ancestors.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';

const expect = chai.expect;

const COUNT = 2500;

type M = typeof ModelBase & { insert(v: object): Promise<unknown> };

/** The result of `fn` and the number of statements `driver` executed while it ran. */
async function statements<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const spied = driver as unknown as { execute: (this: unknown, ...args: unknown[]) => Promise<unknown> };
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

      it('findRows loads every row of a class in one statement', async () => {
        const { result, count } = await statements(db.driver(dialect), () => findRows(tasks()));
        expect(count).to.equal(1);
        expect(result.size).to.equal(COUNT);
      });

      it('writes and reads the ancestor rows of every task in one statement per step', async () => {
        const d = db.driver(dialect);
        // the tasks' parents, the tasks' own rows (none) and their projects' rows (none), the delete, the insert
        expect((await statements(d, () => rebuildNodes(d, tasks()))).count).to.equal(5);

        const { result, count } = await statements(d, () => readAncestors(tasks()));
        expect(count).to.equal(1);
        expect(result.size).to.equal(COUNT);
        expect(result.get('task:2500')!.map((r) => [r.ancestor_type, r.ancestor_id, r.depth])).to.deep.equal([['project', 'p2500', 1]]);

        // the rows below the tasks (none), the delete
        expect((await statements(d, () => removeNodes(d, tasks()))).count).to.equal(2);
        expect(await ancestorLinks(d)).to.deep.equal([]);
      });

      it('reads which parents exist in one more statement per class table of a registered parent type', async () => {
        const Project = await db.define({ name: 'Project', columns: {}, decorate: (c) => AccessResource('project')(c) }, dialect);
        const ids = Array.from({ length: COUNT - 1 }, (_, i) => `p${i + 1}`);
        await db.raw(`INSERT INTO "${db.table(Project)}" ("id") VALUES ${ids.map((_, i) => (dialect === 'postgres' ? `($${i + 1})` : '(?)')).join(', ')}`, ids, dialect);
        const d = db.driver(dialect);
        // the tasks' parents, which of the projects exist, the tasks' own rows and their projects' rows, the delete, the insert
        expect((await statements(d, () => rebuildNodes(d, tasks()))).count).to.equal(6);

        const links = await ancestorLinks(d);
        expect(links).to.have.length(COUNT - 1);
        expect(links).to.include('task:2499>project:p2499@1');
        expect(links.filter((l) => l.startsWith('task:2500>'))).to.deep.equal([]);
      });

      it('an insert of a type a @Parent column names reads that column once more', async () => {
        const Project = (await db.define({ name: 'Project', columns: {}, decorate: (c) => AccessResource('project')(c) }, dialect)) as M;
        const Note = (await db.define({ name: 'Note', columns: {}, decorate: (c) => AccessResource('note')(c) }, dialect)) as M;
        const d = db.driver(dialect);
        const note = (await statements(d, () => Note.insert({ id: 'n1' }))).count;
        // A root type no column names is not observed. One that a column names: the capture's key read, then the children (no task names p0).
        expect((await statements(d, () => Project.insert({ id: 'p0' }))).count).to.equal(note + 2);

        const task = (await statements(d, () => (Task as M).insert({ id: 9001, project_id: 'p0' }))).count;
        await db.define({ name: 'Step', columns: { task_id: 'INTEGER' }, decorate: (c, p) => { AccessResource('step')(c); Parent('task')(p, 'task_id'); } }, dialect);
        expect((await statements(d, () => (Task as M).insert({ id: 9002, project_id: 'p0' }))).count).to.equal(task + 1);
      });
    });
  }
});
