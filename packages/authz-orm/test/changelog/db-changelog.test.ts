import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, ChangeLog, changeLog, runWithPrincipal } from '@spinajs/authz';
import type { ChangeEntry, Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { AsyncLocalStorage } from 'node:async_hooks';

import { AuthzChangeLog_2026_11_04_00_00_00, CHANGE_LOG_TABLE, ChangeLogRecord, DbChangeLog, POLICY_VERSION_TABLE, changeLogPrecisionMs } from '../../src/index.js';
import { AUDIT_CONNECTION, AuthzDecisionLogFacts_2026_11_06_00_00_00, AuthzDecisionLog_2026_11_04_00_00_00, DbDecisionLog, readDecisionRecord } from '../../src/audit/index.js';
import { TestDb } from '../support/db.js';
import type { Dialect } from '../support/db.js';
import { createChangeLogTables, dropChangeLogTables } from '../support/changelog.js';

const expect = chai.expect;

const ALICE: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

describe('DbChangeLog', function () {
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

  it('the migration is registered on the authz connection', () => {
    expect(DI.getRegisteredTypes('__migrations__')).to.include(AuthzChangeLog_2026_11_04_00_00_00);
    expect((AuthzChangeLog_2026_11_04_00_00_00 as unknown as Record<symbol, { Connection: string }>)[MIGRATION_DESCRIPTION_SYMBOL].Connection).to.equal('authz');
  });

  it('is the ChangeLog of an app that loads authz-orm, one instance', () => {
    expect(changeLog()).to.be.instanceOf(DbChangeLog);
    expect(DI.resolve(ChangeLog)).to.equal(changeLog());
  });

  it('covers a kind only once a store tracks it', () => {
    const log = new DbChangeLog();
    expect(log.covers('assignment')).to.equal(false);
    log.track('assignment');
    expect(log.covers('assignment')).to.equal(true);
    expect(log.covers('tuple')).to.equal(false);
  });

  for (const dialect of ['sqlite', 'postgres'] as const satisfies readonly Dialect[]) {
    describe(dialect, () => {
      let driver: OrmDriver;
      const log = new DbChangeLog();

      const append = (entries: ChangeEntry[], fail = false) =>
        driver
          .transaction(async () => {
            await log.append(entries);
            if (fail) throw new Error('roll back');
          })
          .catch((e: Error) => {
            if (!fail) throw e;
          });

      before(function () {
        if (dialect === 'postgres' && !pg) this.skip();
      });

      beforeEach(async () => {
        driver = db.driver(dialect);
        await createChangeLogTables(db, dialect);
      });

      afterEach(async () => {
        await dropChangeLogTables(db, dialect);
      });

      it('the migration creates both tables', async () => {
        const log = await driver.tableInfo(CHANGE_LOG_TABLE, driver.Options.Database);
        expect(log.map((c) => c.Name).sort()).to.deep.equal(['actor', 'at', 'before', 'key', 'kind', 'op', 'payload', 'seq', 'trace_id']);
        expect(log.filter((c) => c.PrimaryKey).map((c) => c.Name)).to.deep.equal(['seq']);
        const versions = await driver.tableInfo(POLICY_VERSION_TABLE, driver.Options.Database);
        expect(versions.map((c) => c.Name).sort()).to.deep.equal(['first_seen_at', 'ir', 'policy_hash']);
      });

      it('refuses to append outside a transaction', async () => {
        const err = await rejection(log.append([{ kind: 'tuple', op: 'add', key: 'k' }]));
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.match(/transaction/);
        expect(await log.since(0)).to.deep.equal([]);
      });

      it('appends in order, with the actor, the current principal and the trace id', async () => {
        const at = new Date('2026-10-03T09:14:07.000Z');
        const store = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>;
        await store.run({ traceId: TRACE }, () =>
          runWithPrincipal(ALICE, () =>
            append([
              { kind: 'tuple', op: 'add', key: 'k1', payload: { a: [1, 'x'] }, at },
              { kind: 'assignment', op: 'remove', key: 'k2', actor: 'user:bob' },
            ]),
          ),
        );
        await append([{ kind: 'rule', op: 'put', key: 'k3' }]);

        const rows = await log.since(0);
        expect(rows.map((r) => [r.kind, r.op, r.key, r.actor, r.traceId])).to.deep.equal([
          ['tuple', 'add', 'k1', 'user:alice', TRACE],
          ['assignment', 'remove', 'k2', 'user:bob', TRACE],
          ['rule', 'put', 'k3', 'unattended:unattended', null],
        ]);
        expect(rows[0].payload).to.deep.equal({ a: [1, 'x'] });
        expect(rows[1].payload).to.equal(null);
        expect(rows[0].at.toISOString()).to.equal(at.toISOString());
        expect(rows[0].seq).to.be.a('number');
        expect(rows[1].seq).to.be.greaterThan(rows[0].seq);
        expect(rows[2].seq).to.be.greaterThan(rows[1].seq);
      });

      it('a rolled-back transaction leaves no change', async () => {
        await append([{ kind: 'tuple', op: 'add', key: 'k1' }], true);
        expect(await log.since(0)).to.deep.equal([]);
      });

      it('refuses an entry the table cannot hold', async () => {
        for (const bad of [{ kind: 'nope', op: 'add', key: 'k' }, { kind: 'tuple', op: 'move', key: 'k' }, { kind: 'tuple', op: 'add', key: '' }, { kind: 'tuple', op: 'add', key: 'k'.repeat(256) }]) {
          const err = await rejection(append([bad as ChangeEntry]));
          expect(err).to.be.instanceOf(AuthzConfigError);
        }
      });

      it('since() and until() narrow by seq, instant, kinds, after and limit', async () => {
        const t = (s: string) => new Date(`2026-10-0${s}T00:00:00.000Z`);
        await append([
          { kind: 'tuple', op: 'add', key: 'a', at: t('1') },
          { kind: 'assignment', op: 'add', key: 'b', at: t('2') },
          { kind: 'tuple', op: 'remove', key: 'a', at: t('3') },
          { kind: 'column', op: 'put', key: 'doc:1#parent', at: t('4') },
        ]);
        const all = await log.since(0);
        const keys = (rows: readonly { key: string; op: string }[]) => rows.map((r) => `${r.op}:${r.key}`);

        expect(keys(await log.since(all[1].seq))).to.deep.equal(['remove:a', 'put:doc:1#parent']);
        expect(keys(await log.since(0, { kinds: ['tuple'] }))).to.deep.equal(['add:a', 'remove:a']);
        expect(keys(await log.since(0, { limit: 2 }))).to.deep.equal(['add:a', 'add:b']);
        expect(keys(await log.since(0, { after: all[2].seq }))).to.deep.equal(['put:doc:1#parent']);
        expect(await log.since(0, { kinds: [] })).to.deep.equal([]);
        expect(keys(await log.until(t('2')))).to.deep.equal(['add:a', 'add:b']);
        expect(keys(await log.until(t('3'), { kinds: ['tuple'], after: all[0].seq }))).to.deep.equal(['remove:a']);
        expect(await rejection(log.since(0, { limit: 10001 }))).to.be.instanceOf(AuthzConfigError);
      });

      it('afterInstant() answers the changes after an instant, in seq order, paged like since()', async () => {
        const t = (s: string) => new Date(`2026-10-0${s}T00:00:00.000Z`);
        await append([
          { kind: 'tuple', op: 'add', key: 'a', at: t('3') },
          { kind: 'tuple', op: 'add', key: 'b', at: t('1') },
          { kind: 'assignment', op: 'add', key: 'c', at: t('2') },
          { kind: 'tuple', op: 'remove', key: 'a', at: t('4') },
        ]);
        const keys = (rows: readonly { key: string; op: string }[]) => rows.map((r) => `${r.op}:${r.key}`);
        expect(keys(await log.afterInstant(t('1')))).to.deep.equal(['add:a', 'add:c', 'remove:a']);
        expect(keys(await log.afterInstant(t('2'), { kinds: ['tuple'] }))).to.deep.equal(['add:a', 'remove:a']);
        const [first] = await log.afterInstant(t('1'), { limit: 1 });
        expect(keys(await log.afterInstant(t('1'), { after: first.seq }))).to.deep.equal(['add:c', 'remove:a']);
        expect(await log.afterInstant(t('4'))).to.deep.equal([]);
      });

      it('latest answers the last change at or before an instant per key', async () => {
        const t = (s: string) => new Date(`2026-10-0${s}T00:00:00.000Z`);
        await append([
          { kind: 'tuple', op: 'add', key: 'k1', at: t('1'), payload: 1 },
          { kind: 'tuple', op: 'put', key: 'k1', at: t('2'), payload: 2 },
          { kind: 'assignment', op: 'put', key: 'k1', at: t('2') },
          { kind: 'tuple', op: 'put', key: 'k1', at: t('3'), payload: 3 },
          { kind: 'tuple', op: 'add', key: 'k2', at: t('4'), payload: 4 },
        ]);
        const summary = (m: ReadonlyMap<string, { at: Date; payload: unknown; before: unknown }>) => Object.fromEntries([...m].map(([k, r]) => [k, [r.at.toISOString(), r.payload, r.before]]));
        expect(summary(await log.latest('tuple', ['k1', 'k2', 'k3'], t('2')))).to.deep.equal({ k1: [t('2').toISOString(), 2, null] });
        expect(summary(await log.latest('tuple', ['k1', 'k2', 'k1']))).to.deep.equal({ k1: [t('3').toISOString(), 3, null], k2: [t('4').toISOString(), 4, null] });
        expect((await log.latest('tuple', [])).size).to.equal(0);
      });

      it('latest batches more keys than one query holds', async () => {
        await append(Array.from({ length: 1201 }, (_, i) => ({ kind: 'rule' as const, op: 'add' as const, key: `r${i}` })));
        const found = await log.latest('rule', Array.from({ length: 1201 }, (_, i) => `r${i}`));
        expect(found.size).to.equal(1201);
        expect(found.get('r1200')!.key).to.equal('r1200');
      });

      it('reads the before column as JSON, null when the store logged none', async () => {
        await append([{ kind: 'rule', op: 'put', key: 'r1', payload: { v: 2 } }]);
        const [row] = await log.since(0);
        expect(row.before).to.equal(null);
        await ChangeLogRecord.update({ before: JSON.stringify({ v: 1 }) }).where('seq', row.seq);
        expect((await log.since(0))[0].before).to.deep.equal({ v: 1 });
      });

      it('writes the before-image an entry carries', async () => {
        await append([
          { kind: 'rule', op: 'put', key: 'r1', payload: { v: 2 }, before: { v: 1 } },
          { kind: 'rule', op: 'remove', key: 'r1', payload: { v: 2 }, before: undefined },
        ]);
        expect((await log.since(0)).map((c) => c.before)).to.deep.equal([{ v: 1 }, null]);
      });

      it('keeps instants to the precision changeLogPrecisionMs gives, on the changelog and the decision log', async () => {
        const precision = changeLogPrecisionMs(driver);
        expect(precision).to.equal(1);
        const at = new Date('2026-10-03T09:14:07.123Z');
        await append([{ kind: 'tuple', op: 'add', key: 'p', at }]);
        const [row] = await log.since(0);
        expect(Math.abs(row.at.getTime() - at.getTime())).to.be.below(precision);

        const migrations = [new AuthzDecisionLog_2026_11_04_00_00_00(), new AuthzDecisionLogFacts_2026_11_06_00_00_00()];
        db.orm.Connections.set(AUDIT_CONNECTION, driver);
        try {
          for (const m of migrations) await m.up(driver);
          await db.orm.reloadTableInfo();
          const id = '0192f0c4-7a10-7c3e-9b2a-1f2e3d4c5b70';
          await new DbDecisionLog().write([{ id, at: at.toISOString(), loggedAt: '2026-10-03T09:14:07.456Z', domain: 'root', principal: 'user:a', permission: 'doc:read', resource: { type: 'doc', id: 'd' }, allowed: true, cached: false, policyHash: 'unknown', modelVersions: {}, inputsHash: 'a'.repeat(64) }]);
          const read = (await readDecisionRecord(id))!.record;
          expect(Math.abs(Date.parse(read.at) - at.getTime())).to.be.below(precision);
          expect(Math.abs(Date.parse(read.loggedAt!) - Date.parse('2026-10-03T09:14:07.456Z'))).to.be.below(precision);
        } finally {
          await migrations[0].down(driver);
          db.orm.Connections.delete(AUDIT_CONNECTION);
        }
      });

      it('appends more rows than one insert holds', async () => {
        await append(Array.from({ length: 250 }, (_, i) => ({ kind: 'tuple' as const, op: 'add' as const, key: `k${i}` })));
        const rows = await log.since(0, { limit: 10000 });
        expect(rows.map((r) => r.key)).to.deep.equal(Array.from({ length: 250 }, (_, i) => `k${i}`));
      });
    });
  }
});
