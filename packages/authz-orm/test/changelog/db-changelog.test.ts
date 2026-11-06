import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError, ChangeLog, changeLog, runWithPrincipal } from '@spinajs/authz';
import type { ChangeEntry, Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { AsyncLocalStorage } from 'node:async_hooks';

import { AuthzChangeLog_2026_11_04_00_00_00, CHANGE_LOG_TABLE, DbChangeLog, POLICY_VERSION_TABLE } from '../../src/index.js';
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
        expect(log.map((c) => c.Name).sort()).to.deep.equal(['actor', 'at', 'key', 'kind', 'op', 'payload', 'seq', 'trace_id']);
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

      it('appends more rows than one insert holds', async () => {
        await append(Array.from({ length: 250 }, (_, i) => ({ kind: 'tuple' as const, op: 'add' as const, key: `k${i}` })));
        const rows = await log.since(0, { limit: 10000 });
        expect(rows.map((r) => r.key)).to.deep.equal(Array.from({ length: 250 }, (_, i) => `k${i}`));
      });
    });
  }
});
