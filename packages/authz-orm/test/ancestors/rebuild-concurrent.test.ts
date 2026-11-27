import * as chai from 'chai';
import 'mocha';
import sinon from 'sinon';

import type { ModelBase, OrmDriver } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from '../../src/ancestors/index.js';
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

/** Sessions of the test's own database that wait on a lock. */
const LOCK_WAITERS = new Map<Dialect, string>([
  ['postgres', `SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`],
  ['mysql', `SELECT COUNT(*) AS n FROM information_schema.innodb_trx t JOIN information_schema.processlist p ON p.id = t.trx_mysql_thread_id WHERE t.trx_state = 'LOCK WAIT' AND p.db = DATABASE()`],
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

        const hold = dialect === 'sqlite' ? undefined : holdRow(driver, 'task:n0');
        await hold?.ready;
        const started = Date.now();
        const run = settled(rebuild('task'));
        let done = false;
        void run.then(() => (done = true));
        const seen = new Set<string>();
        let slowest = 0;
        let reads = 0;
        if (hold) {
          await untilWaiting(1, run);
          const t = Date.now();
          expect(await view(), 'a reader while the rebuild holds its locks').to.equal(old);
          slowest = Date.now() - t;
          hold.release();
        }
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
        // SQLite runs a statement outside the transaction only after it ends. MySQL does not block the reader, but its read
        // rebuilds the old rows from the undo log while the DELETE is uncommitted, which took up to 1.9 s on a loaded machine.
        const bound = dialect === 'postgres' ? 1000 : took;
        process.stdout.write(`      [${dialect}] rebuild of 5,004 links ${took} ms, ${reads} reads, slowest read ${slowest} ms (bound ${bound} ms)\n`);
        expect(slowest).to.be.at.most(bound);
      });

      describe('with a second connection', () => {
        before(function () {
          if (dialect === 'sqlite') this.skip();
        });

        it('a move of a parent waits for the rebuild and then rewrites the rows the rebuild repaired below it', async () => {
          await db.raw(`DELETE FROM ${AUTHZ_RESOURCE_ANCESTOR_TABLE} WHERE resource_type = 'task' AND resource_id = 't2'`, [], dialect);
          const hold = holdRow(driver, 'task:t1');
          await hold.ready;
          const run = settled(rebuild('task'));
          await untilWaiting(1, run);
          const move = settled(Project.update({ org_id: 'o2' }).where('id', 'p1'));
          await untilWaiting(2, move, run);
          hold.release();
          expect(await move, 'the move fails').to.equal(undefined);
          expect(await run).to.equal(undefined);
          await hold.done;
          expect(err).to.deep.equal([]);
          expect(await expectQuietRebuildAgrees()).to.deep.equal(['project:p1>org:o2@1', 'project:p2>org:o2@1', 'task:t1>org:o2@2', 'task:t1>project:p1@1', 'task:t2>org:o2@2', 'task:t2>project:p1@1']);
        });

        it('a move in flight when the rebuild starts commits first, without a deadlock, and the rebuild reads it', async () => {
          const hold = holdRow(driver, 'task:t1');
          await hold.ready;
          const between = gate();
          const resume = gate();
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
          await hold.done;
          expect(err).to.deep.equal([]);
          expect(TASK_LINKS(await expectQuietRebuildAgrees())).to.deep.equal(['task:t1>org:o2@2', 'task:t1>project:p2@1', 'task:t2>org:o1@2', 'task:t2>project:p1@1']);
        });

        it('a delete of a parent waits for the rebuild; the rows below it lose that parent', async () => {
          const hold = holdRow(driver, 'task:t1');
          await hold.ready;
          const run = settled(rebuild('task'));
          await untilWaiting(1, run);
          const remove = settled((async () => void (await Project.destroy('p1')))());
          await untilWaiting(2, remove, run);
          hold.release();
          expect(await remove, 'the delete fails').to.equal(undefined);
          expect(await run).to.equal(undefined);
          await hold.done;
          expect(err).to.deep.equal([]);
          // What the writes alone leave. A rebuild of the quiet database links t1 and t2 to the deleted id p1 again (see "A rebuild links children to a deleted parent").
          expect(await ancestorLinks(driver)).to.deep.equal(['project:p2>org:o2@1']);
        });

        it('two rebuilds at once: the second waits for the first, both succeed', async () => {
          const hold = holdRow(driver, 'task:t1');
          await hold.ready;
          const first = settled(rebuild('task'));
          await untilWaiting(1, first);
          const second = settled(rebuild());
          await untilWaiting(2, first, second);
          hold.release();
          expect(await first).to.equal(undefined);
          expect(await second).to.equal(undefined);
          await hold.done;
          expect(err).to.deep.equal([]);
          expect(out).to.include.members(['task: 4 rows', 'project: 2 rows']);
          await expectQuietRebuildAgrees();
        });

        it('six rebuilds at once, five times: none fails', async () => {
          // Without a self-exclusive lock, rebuilds that both hold the ancestor table's lock deadlock on their DELETEs.
          for (let round = 0; round < 5; round++) await Promise.all(Array.from({ length: 6 }, (_, i) => rebuild(i % 2 === 0 ? 'task' : undefined)));
          expect(err).to.deep.equal([]);
          await expectQuietRebuildAgrees();
        });
      });

      /** A transaction on a connection of its own that holds the row lock of `ref`'s first ancestor row until `release()`. */
      function holdRow(d: OrmDriver, ref: string): { ready: Promise<void>; release: () => void; done: Promise<unknown> } {
        const [type, id] = ref.split(':');
        const ready = gate();
        const release = gate();
        const done = settled(
          d.transaction(async () => {
            await d.select().from(AUTHZ_RESOURCE_ANCESTOR_TABLE).where('resource_type', type).where('resource_id', id).forUpdate();
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
          if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions wait on a lock after 30 s`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    });
  }
});
