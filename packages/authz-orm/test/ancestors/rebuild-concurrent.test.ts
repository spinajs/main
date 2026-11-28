import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE, AncestorRecord } from '../../src/ancestors/index.js';
import { REBUILD_LOCK_WAIT } from '../../src/ancestors/rebuild-lock.js';
import { AncestorsRebuildCommand } from '../../src/cli/commands/ancestors-rebuild.js';
import { AccessResource, Parent } from '../../src/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { ancestorLinks, createAncestorTable, dropAncestorTable, insertLinks } from '../support/ancestors.js';

const expect = chai.expect;

type M = typeof ModelBase & { insert(v: object | object[]): Promise<unknown>; update(v: object): { where(...a: unknown[]): Promise<unknown> }; destroy(pk: unknown): Promise<unknown> };

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Resolves with the error, or undefined: a promise the test awaits later must not reject unhandled. */
const settled = (p: Promise<unknown>): Promise<unknown> => p.then(
  () => undefined,
  (e: unknown) => e,
);

const TASK_LINKS = (links: readonly string[]) => links.filter((l) => l.startsWith('task:'));

/**
 * Sessions of the test's own database that wait on a lock. MySQL counts from performance_schema.data_lock_waits:
 * information_schema.innodb_trx did not list a session blocked in the first locking statement of its transaction.
 */
const LOCK_WAITERS = new Map<Dialect, string>([
  ['postgres', `SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`],
  ['mysql', `SELECT COUNT(DISTINCT t.PROCESSLIST_ID) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID = w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_DB = DATABASE()`],
]);

/** What the test database's sessions do, for the error of a wait that timed out. */
const LOCK_STATE = new Map<Dialect, string>([
  ['postgres', `SELECT pid, state, wait_event_type, wait_event, LEFT(query, 120) AS query FROM pg_stat_activity WHERE datname = current_database()`],
  ['mysql', `SELECT t.PROCESSLIST_ID AS id, t.PROCESSLIST_COMMAND AS command, t.PROCESSLIST_TIME AS time, t.PROCESSLIST_STATE AS state, (SELECT COUNT(*) FROM performance_schema.data_lock_waits w WHERE w.REQUESTING_THREAD_ID = t.THREAD_ID) AS waits, (SELECT COUNT(*) FROM performance_schema.data_lock_waits w WHERE w.BLOCKING_THREAD_ID = t.THREAD_ID) AS blocks, LEFT(t.PROCESSLIST_INFO, 120) AS query FROM performance_schema.threads t WHERE t.PROCESSLIST_DB = DATABASE()`],
]);

// With a second connection, a scenario holds the rebuild with a row lock on one of its ancestor rows: on PostgreSQL its
// DELETE waits there, after it locked and read; on MySQL its lock of the ancestor table waits there.
describe('authz:ancestors-rebuild while the application writes', function () {
  this.timeout(120000);
  let db: TestDb;
  const reachable = new Set<Dialect>(['sqlite']);

  before(async () => {
    if (await TestDb.postgresReachable()) reachable.add('postgres');
    if (await TestDb.mysqlReachable()) reachable.add('mysql');
    db = await TestDb.open({ postgres: reachable.has('postgres'), mysql: reachable.has('mysql') });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let out: string[];
      let err: string[];
      let stubs: sinon.SinonStub[];
      let Project: M;
      let Task: M;
      let driver: OrmDriver;

      before(function () {
        if (!reachable.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        await createAncestorTable(db, dialect);
        out = [];
        err = [];
        stubs = [sinon.stub(console, 'log').callsFake((...a: unknown[]) => void out.push(a.join(' '))), sinon.stub(console, 'error').callsFake((...a: unknown[]) => void err.push(a.join(' ')))];
        driver = db.driver(dialect);
        const text = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
        Project = (await db.define({ name: 'Project', columns: { org_id: text }, decorate: (c, p) => { AccessResource('project')(c); Parent('org')(p, 'org_id'); } }, dialect)) as M;
        Task = (await db.define({ name: 'Task', columns: { project_id: text, title: text }, decorate: (c, p) => { AccessResource('task')(c); Parent('project')(p, 'project_id'); } }, dialect)) as M;
        await Project.insert([{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o2' }]);
        await Task.insert([{ id: 't1', project_id: 'p1' }, { id: 't2', project_id: 'p1' }]);
      });

      afterEach(async () => {
        for (const s of stubs) s.restore();
        process.exitCode = undefined;
        await db.clear();
        await dropAncestorTable(db, dialect);
      });

      const rebuild = (type?: string, options?: { prune?: boolean }) => Object.assign(new AncestorsRebuildCommand(), { Orm: db.orm }).execute(type, options);

      /** Runs `fn` when the rebuild opens its (first) transaction, before the transaction begins. */
      const asTheRebuildBegins = (fn: () => Promise<unknown>): void => {
        const original = driver.transaction.bind(driver);
        const stub = sinon.stub(driver, 'transaction').callsFake(async (cb, options) => {
          stub.restore();
          await fn();
          return original(cb, options);
        });
      };

      /** The table after the scenario must be what a rebuild of the quiet database writes, row for row. */
      const expectQuietRebuildAgrees = async (): Promise<string[]> => {
        const after = await ancestorLinks(driver);
        await rebuild();
        expect(err, 'the rebuild of the quiet database fails').to.deep.equal([]);
        expect(await ancestorLinks(driver), 'the table differs from a rebuild of the quiet database').to.deep.equal(after);
        return after;
      };

      it('a move committed as the rebuild opens its transaction is in the rebuilt rows', async () => {
        asTheRebuildBegins(() => Task.update({ project_id: 'p2' }).where('id', 't1'));
        await rebuild('task');
        expect(err).to.deep.equal([]);
        expect(TASK_LINKS(await expectQuietRebuildAgrees())).to.deep.equal(['task:t1>org:o2@2', 'task:t1>project:p2@1', 'task:t2>org:o1@2', 'task:t2>project:p1@1']);
      });

      it('a link written as the rebuild opens its transaction is checked, not dropped', async () => {
        const before = await ancestorLinks(driver);
        asTheRebuildBegins(() => insertLinks(driver, ['task:t1>tenant:acme@1']));
        await rebuild('task');
        expect(err.join('\n')).to.contain('task: rows link to tenant, which no @Parent of task names in this process');
        expect(process.exitCode).to.equal(1);
        expect(await ancestorLinks(driver)).to.deep.equal([...before, 'task:t1>tenant:acme@1'].sort());
      });

      it('a reader during a rebuild of 5,000 links sees the old rows or the new ones, never a mix', async () => {
        const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `n${i}`, project_id: 'p2' }));
        for (let i = 0; i < rows.length; i += 250) await driver.insert().into(db.table(Task)).values(rows.slice(i, i + 250));
        await rebuild('task');
        await db.raw(`UPDATE ${TestDb.quote(db.table(Project), dialect)} SET org_id = 'o3' WHERE id = 'p2'`, [], dialect);
        const view = async (): Promise<string> => {
          const counts = (await db.raw(`SELECT ancestor_type, ancestor_id, COUNT(*) AS n FROM ${AUTHZ_RESOURCE_ANCESTOR_TABLE} WHERE resource_type = 'task' AND resource_id LIKE 'n%' GROUP BY ancestor_type, ancestor_id`, [], dialect)) as { ancestor_type: string; ancestor_id: string; n: unknown }[];
          return counts.map((c) => `${c.ancestor_type}:${c.ancestor_id}=${Number(c.n)}`).sort().join(' ');
        };
        const old = 'org:o2=2500 project:p2=2500';
        const rebuilt = 'org:o3=2500 project:p2=2500';
        expect(await view()).to.equal(old);

        const { deleted, resume } = holdAfterDelete();
        const started = Date.now();
        const run = settled(rebuild('task'));
        let done = false;
        void run.then(() => (done = true));
        await deleted.wait;
        const t0 = Date.now();
        const held = view();
        const answer = await Promise.race([held, new Promise<string>((resolve) => setTimeout(() => resolve('no answer'), dialect === 'sqlite' ? 300 : 10000))]);
        let slowest = dialect === 'sqlite' ? 0 : Date.now() - t0;
        resume.open();
        // SQLite in one process runs a statement outside the transaction only after it ends; PostgreSQL and MySQL answer at once.
        expect(answer, 'a reader while the rebuild has deleted and not yet inserted').to.equal(dialect === 'sqlite' ? 'no answer' : old);
        expect(await held, 'the reader the rebuild held back').to.equal(dialect === 'sqlite' ? rebuilt : old);
        const seen = new Set<string>();
        let reads = 0;
        while (!done) {
          const t = Date.now();
          seen.add(await view());
          slowest = Math.max(slowest, Date.now() - t);
          reads++;
        }
        const took = Date.now() - started;
        expect(await run).to.equal(undefined);
        expect(err).to.deep.equal([]);
        expect([...seen].filter((v) => v !== old && v !== rebuilt), 'a reader saw a partial table').to.deep.equal([]);
        expect(await view()).to.equal(rebuilt);
        process.stdout.write(`      [${dialect}] rebuild of 5,004 links ${took} ms, ${reads} reads, slowest read ${slowest} ms\n`);
        // MySQL's read rebuilds the deleted rows from the undo log, which took up to 1.9 s on a loaded machine: no fixed bound there.
        if (dialect === 'postgres') expect(slowest).to.be.at.most(1000);
      });

      describe('with a second connection', () => {
        before(function () {
          if (dialect === 'sqlite') this.skip();
        });

        // A hold that outlasts 5 s on a loaded machine would otherwise fail a scenario with the rebuild's lock timeout.
        beforeEach(() => {
          REBUILD_LOCK_WAIT.seconds = 60;
        });

        afterEach(() => {
          REBUILD_LOCK_WAIT.seconds = 5;
        });

        it('a move of a parent waits for the rebuild and then rewrites the rows the rebuild repaired below it', async () => {
          await db.raw(`DELETE FROM ${AUTHZ_RESOURCE_ANCESTOR_TABLE} WHERE resource_type = 'task' AND resource_id = 't2'`, [], dialect);
          const hold = holdRow(driver, 'task:t1');
          try {
            await hold.ready;
            const run = settled(rebuild('task'));
            await untilWaiting(1, run);
            const move = settled(Project.update({ org_id: 'o2' }).where('id', 'p1'));
            await untilWaiting(2, move, run);
            hold.release();
            expect(await move, 'the move fails').to.equal(undefined);
            expect(await run).to.equal(undefined);
          } finally {
            hold.release();
            await hold.done;
          }
          expect(err).to.deep.equal([]);
          expect(await expectQuietRebuildAgrees()).to.deep.equal(['project:p1>org:o2@1', 'project:p2>org:o2@1', 'task:t1>org:o2@2', 'task:t1>project:p1@1', 'task:t2>org:o2@2', 'task:t2>project:p1@1']);
        });

        it('a move in flight when the rebuild starts commits first, without a deadlock, and the rebuild reads it', async () => {
          const hold = holdRow(driver, 'task:t1');
          const between = gate();
          const resume = gate();
          try {
            await hold.ready;
            const move = settled(
              driver.transaction(async () => {
                await Task.update({ title: 'renamed' }).where('id', 't1');
                between.open();
                await resume.wait;
                await Task.update({ project_id: 'p2' }).where('id', 't1');
              }),
            );
            await between.wait;
            const run = settled(rebuild('task'));
            await untilWaiting(1, run);
            resume.open();
            await untilWaiting(2, move, run);
            hold.release();
            expect(await move, 'the move fails').to.equal(undefined);
            expect(await run).to.equal(undefined);
          } finally {
            resume.open();
            hold.release();
            await hold.done;
          }
          expect(err).to.deep.equal([]);
          expect(TASK_LINKS(await expectQuietRebuildAgrees())).to.deep.equal(['task:t1>org:o2@2', 'task:t1>project:p2@1', 'task:t2>org:o1@2', 'task:t2>project:p1@1']);
        });

        it('a delete of a parent waits for the rebuild; the rows below it lose that parent', async () => {
          const hold = holdRow(driver, 'task:t1');
          try {
            await hold.ready;
            const run = settled(rebuild('task'));
            await untilWaiting(1, run);
            const remove = settled((async () => void (await Project.destroy('p1')))());
            await untilWaiting(2, remove, run);
            hold.release();
            expect(await remove, 'the delete fails').to.equal(undefined);
            expect(await run).to.equal(undefined);
          } finally {
            hold.release();
            await hold.done;
          }
          expect(err).to.deep.equal([]);
          expect(await expectQuietRebuildAgrees()).to.deep.equal(['project:p2>org:o2@1']);
        });

        it('two rebuilds at once: the second waits for the first, both succeed', async () => {
          const hold = holdRow(driver, 'task:t1');
          try {
            await hold.ready;
            const first = settled(rebuild('task'));
            await untilWaiting(1, first);
            const second = settled(rebuild());
            await untilWaiting(2, first, second);
            hold.release();
            expect(await first).to.equal(undefined);
            expect(await second).to.equal(undefined);
          } finally {
            hold.release();
            await hold.done;
          }
          expect(err).to.deep.equal([]);
          expect(out).to.include.members(['task: 4 rows', 'project: 2 rows']);
          await expectQuietRebuildAgrees();
        });

        it('on PostgreSQL a second rebuild waits for the first at most the lock timeout, then fails and changes nothing', async function () {
          if (dialect !== 'postgres') this.skip();
          REBUILD_LOCK_WAIT.seconds = 1;
          const { deleted, resume } = holdAfterDelete();
          try {
            const first = settled(rebuild('task'));
            await deleted.wait;
            const second = settled(rebuild('task'));
            await untilWaiting(1, second);
            await second;
            expect(err.join('\n')).to.contain('task: could not lock the tables of the rebuild within 1 s: a transaction is writing them, or another rebuild is running; nothing of task was changed');
            resume.open();
            expect(await first).to.equal(undefined);
          } finally {
            resume.open();
          }
          err.length = 0;
          await expectQuietRebuildAgrees();
        });

        it('on PostgreSQL a rebuild whose DELETE waits past the lock timeout on a row an application holds fails with its own message', async function () {
          if (dialect !== 'postgres') this.skip();
          REBUILD_LOCK_WAIT.seconds = 1;
          const before = await ancestorLinks(driver);
          const hold = holdRow(driver, 'task:t1');
          try {
            await hold.ready;
            await rebuild('task');
          } finally {
            hold.release();
            await hold.done;
          }
          expect(err.join('\n')).to.contain('task: could not lock the tables of the rebuild within 1 s');
          expect(await ancestorLinks(driver)).to.deep.equal(before);
        });

        it('two rebuilds of types that declare the same parents in opposite orders do not deadlock', async () => {
          const text = dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
          const A = (await db.define({ name: 'A', columns: {}, decorate: (c) => AccessResource('a')(c) }, dialect)) as M;
          const B = (await db.define({ name: 'B', columns: {}, decorate: (c) => AccessResource('b')(c) }, dialect)) as M;
          const X = (await db.define({ name: 'X', columns: { a_id: text, b_id: text }, decorate: (c, p) => { AccessResource('x')(c); Parent('a')(p, 'a_id'); Parent('b')(p, 'b_id'); } }, dialect)) as M;
          const Y = (await db.define({ name: 'Y', columns: { a_id: text, b_id: text }, decorate: (c, p) => { AccessResource('y')(c); Parent('b')(p, 'b_id'); Parent('a')(p, 'a_id'); } }, dialect)) as M;
          await A.insert({ id: 'a1' });
          await B.insert({ id: 'b1' });
          await X.insert({ id: 'x1', a_id: 'a1', b_id: 'b1' });
          await Y.insert({ id: 'y1', a_id: 'a1', b_id: 'b1' });
          // In creation order, x would lock [x, a, b] and y [y, b, a]: on MySQL, where these locks are exclusive, a cycle.
          const hold = holdRow(driver, 'a1', db.table(A));
          try {
            await hold.ready;
            const first = settled(rebuild('x'));
            await untilWaiting(1, first);
            const second = settled(rebuild('y'));
            await untilWaiting(2, first, second);
            hold.release();
            expect(await first).to.equal(undefined);
            expect(await second).to.equal(undefined);
          } finally {
            hold.release();
            await hold.done;
          }
          expect(err).to.deep.equal([]);
          await expectQuietRebuildAgrees();
        });

        it('on PostgreSQL a rebuild that cannot lock its tables in time gives up, changes nothing, and the writers queued behind it go on', async function () {
          if (dialect !== 'postgres') this.skip();
          REBUILD_LOCK_WAIT.seconds = 1;
          const before = await ancestorLinks(driver);
          const opened = gate();
          const close = gate();
          const open = settled(
            driver.transaction(async () => {
              await Task.update({ title: 'open' }).where('id', 't1');
              opened.open();
              await close.wait;
            }),
          );
          try {
            await opened.wait;
            const started = Date.now();
            let gaveUpAfter = Infinity;
            const run = settled(rebuild('task')).then(() => (gaveUpAfter = Date.now() - started));
            await untilWaiting(1, run);
            const behind = settled(Task.update({ title: 'behind' }).where('id', 't2'));
            await untilWaiting(2, behind, run);
            const first = await Promise.race([behind.then(() => 'the writer went on'), new Promise<string>((resolve) => setTimeout(() => resolve('the writer still waits'), 20000))]);
            close.open();
            await open;
            await run;
            expect(first, 'a writer queued behind the waiting rebuild while the long transaction stays open').to.equal('the writer went on');
            expect(await behind).to.equal(undefined);
            expect(err.join('\n')).to.contain('task: could not lock the tables of the rebuild within 1 s');
            expect(process.exitCode).to.equal(1);
            expect(gaveUpAfter).to.be.below(10000);
            expect(await ancestorLinks(driver)).to.deep.equal(before);
          } finally {
            close.open();
            await open;
          }
        });

        it('six rebuilds at once, five times: none fails', async () => {
          // Without a self-exclusive lock, rebuilds that both hold the ancestor table's lock deadlock on their DELETEs.
          for (let round = 0; round < 5; round++) await Promise.all(Array.from({ length: 6 }, (_, i) => rebuild(i % 2 === 0 ? 'task' : undefined)));
          expect(err).to.deep.equal([]);
          await expectQuietRebuildAgrees();
        });
      });

      /**
       * Holds the rebuild after its DELETE ran and before its INSERT, every lock taken. The reads start from the test's own
       * flow: started inside the stub, they would join the rebuild's transaction.
       */
      function holdAfterDelete(): { deleted: { wait: Promise<void> }; resume: { open: () => void } } {
        const deleted = gate();
        const resume = gate();
        const destroy = AncestorRecord.destroy.bind(AncestorRecord);
        const stub = sinon.stub(AncestorRecord, 'destroy').callsFake((...args) => {
          stub.restore();
          const query = destroy(...args);
          const then = query.then.bind(query);
          query.then = (onDone, onFail) =>
            then((result) => {
              deleted.open();
              return resume.wait.then(() => result);
            }).then(onDone, onFail);
          return query;
        });
        return { deleted, resume };
      }

      /** A transaction on a connection of its own that holds a row lock until `release()`: `ref`'s ancestor rows, or the row `ref` of `table`. */
      function holdRow(d: OrmDriver, ref: string, table?: string): { ready: Promise<void>; release: () => void; done: Promise<unknown> } {
        const [type, id] = ref.split(':');
        const ready = gate();
        const release = gate();
        const done = settled(
          d.transaction(async () => {
            if (table === undefined) await d.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).where('resource_type', type).where('resource_id', id).forUpdate();
            else await d.select().from(table).where('id', ref).forUpdate();
            ready.open();
            await release.wait;
          }),
        );
        return { ready: ready.wait, release: release.open, done };
      }

      /** Until `n` sessions of this database wait on a lock, or one of `ends` settles (a run that does not wait on the base). */
      async function untilWaiting(n: number, ...ends: Promise<unknown>[]): Promise<void> {
        let ended = false;
        void Promise.race(ends).then(() => (ended = true));
        const deadline = Date.now() + 30000;
        for (;;) {
          const rows = (await db.raw(LOCK_WAITERS.get(dialect) ?? 'SELECT 0 AS n', [], dialect)) as { n: unknown }[];
          if (ended || Number(rows[0].n) >= n) return;
          if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions wait on a lock after 30 s; sessions: ${JSON.stringify(await db.raw(LOCK_STATE.get(dialect) ?? 'SELECT 0 AS n', [], dialect))}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    });
  }
});
