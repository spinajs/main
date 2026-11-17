import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { AuditConfigError, AuditWriteFailed, audit, payloadHash, trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { TableAuditStore } from '../src/index.js';
import { DIALECTS, TestDb } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const TABLE = 'audit_t';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const trailOf = (dialect: string): string => `t_${dialect}`;
const missingOf = (dialect: string): string => `m_${dialect}`;
const lostOf = (dialect: string): string => `l_${dialect}`;
const TRAILS = Object.fromEntries(
  DIALECTS.flatMap((d) => [
    [trailOf(d), { connection: d, table: TABLE, onFailure: 'reject', retry: { attempts: 1, delay: 1 } }],
    // Three tries: a joined write must still be tried once only.
    [missingOf(d), { connection: d, table: 'audit_missing', onFailure: 'reject', retry: { attempts: 3, delay: 1 } }],
    [lostOf(d), { connection: d, table: 'audit_missing', onFailure: 'continue', retry: { attempts: 3, delay: 1 } }],
  ]),
);
const SPARE = { Driver: 'orm-driver-sqlite', Name: 'spare', Filename: ':memory:' };
// Short, so a confirmed write that waits for the caller's transaction fails here instead of hanging the suite.
const CONFIRM_TIMEOUT_MS = 3000;
// Drivers that serve one outermost transaction at a time (supportedFeatures().concurrentTransactions === false).
const SINGLE: readonly string[] = ['sqlite', 'pglite'];

describe('TableAuditStore', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ trails: TRAILS, confirmTimeoutMs: CONFIRM_TIMEOUT_MS }, { connections: [SPARE] });
  });

  after(async () => {
    await db?.close();
  });

  it('records on the default trail, in the table the package migration created', async () => {
    await audit().record({ kind: 'custom', action: 'contract.signed' }, { mode: 'confirmed' });
    expect((await db.rows('sqlite', 'audit_event')).map((r) => r.action)).to.deep.eq(['contract.signed']);
    expect(db.connectionName('sqlite')).to.eq('sqlite');
    expect(TestDb.dialects()).to.include.members(['sqlite', 'pglite']);
    expect(db.driver('spare').Options.Name).to.eq('spare');
  });

  it('refuses a trail whose connection names no ORM connection on the append itself', async () => {
    const trail = { ...trailConfig(trailOf('sqlite')), connection: 'nowhere' };
    const event: AuditEvent = { id: 'e1', at: new Date(), kind: 'custom', action: 'x', outcome: 'ok', actor: 'system:test', data: {} };
    await expect(new TableAuditStore().append({ trail, events: [event] })).to.be.rejectedWith(AuditConfigError, 'audit: no ORM connection "nowhere"');
  });

  it('joins the caller only inside a transaction open on a single-connection driver, and never for a connection it cannot find', async () => {
    const store = new TableAuditStore();
    const sqlite = trailConfig(trailOf('sqlite'));
    expect(store.joinsCaller(sqlite, undefined)).to.eq(false);
    await db.driver('sqlite').transaction(async () => {
      expect(store.joinsCaller(sqlite, undefined)).to.eq(true);
      expect(store.joinsCaller(sqlite, 'nowhere')).to.eq(false);
      expect(store.joinsCaller({ ...sqlite, connection: 'nowhere' }, undefined)).to.eq(false);
      // The transaction is open on sqlite, not on the connection the write names.
      expect(store.joinsCaller(sqlite, 'spare')).to.eq(false);
      await expect(audit().record({ kind: 'custom', action: 'x' }, { trail: trailOf('sqlite'), connection: 'nowhere' })).to.be.rejectedWith(AuditConfigError, 'audit: no ORM connection "nowhere"');
    });
  });

  it("writes a confirmed event on the connection the write names instead of the trail's", async function () {
    if (!db.has('pglite')) this.skip();
    // audit_t does not exist on sqlite here, the connection of this trail.
    await db.migrate('pglite', TABLE);
    await audit().record({ kind: 'custom', action: 'moved' }, { trail: trailOf('sqlite'), connection: 'pglite' });
    expect((await db.rows('pglite', TABLE)).map((r) => r.action)).to.deep.eq(['moved']);
    await db.drop('pglite', TABLE);
  });

  for (const dialect of DIALECTS) {
    describe(dialect, () => {
      const trail = trailOf(dialect);

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        await db.migrate(dialect, TABLE);
      });

      afterEach(async () => {
        await db.drop(dialect, TABLE);
      });

      it('stores every field, the payload as canonical JSON and its hash', async () => {
        const request = { Principal: { type: 'user', id: 'u1', authn: { impersonator: { type: 'user', id: 'admin' } } }, traceId: TRACE, realIp: '10.0.0.7' };
        const input = { kind: 'read', action: 'patient.read', subject: { type: 'patient', id: '17' }, dataSubject: 'person:9', data: { columns: ['ssn'], because: 'ward round' } } as const;
        await (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).run(request, () => audit().record(input, { trail }));

        const [row] = await db.rows(dialect, TABLE);
        const data = '{"because":"ward round","columns":["ssn"]}';
        expect(row).to.include({ kind: 'read', action: 'patient.read', subject_type: 'patient', subject_id: '17', outcome: 'ok', actor: 'user:u1', on_behalf_of: 'user:admin', trace_id: TRACE, origin: '10.0.0.7', tenant: null, decision_id: null, idempotency_key: null, data_subject: 'person:9', data });
        expect(row.data_hash).to.eq(createHash('sha256').update(data).digest('hex'));
        expect(row.data_hash).to.eq(payloadHash(input.data));
        expect(row.id).to.match(/^[0-9a-f-]{36}$/);
      });

      it('keeps a payload that Postgres jsonb would refuse: a NUL character and a lone surrogate', async () => {
        const data = { nul: 'a\u0000b', lone: 'x\ud800y' };
        await audit().record({ kind: 'custom', action: 'odd.text', data }, { trail });
        const [event] = await audit().trail(trail).since(0);
        expect(event.data).to.deep.eq(data);
        expect((await db.rows(dialect, TABLE))[0].data_hash).to.eq(payloadHash(data));
      });

      it('keeps a payload over the 64 kB of a MySQL TEXT column', async () => {
        const data = { blob: 'x'.repeat(70000) };
        await audit().record({ kind: 'custom', action: 'large', data }, { trail });
        const [event] = await audit().trail(trail).since(0);
        expect(event.data).to.deep.eq(data);
        expect((await db.rows(dialect, TABLE))[0].data_hash).to.eq(payloadHash(data));
      });

      it('commits and rolls back a transactional event with the write', async () => {
        const driver = db.driver(dialect);
        const input = { kind: 'data', action: 'insert', subject: { type: 'invoice', id: '1' } } as const;
        const failing = driver.transaction(async () => {
          await audit().record(input, { trail, mode: 'transactional', transaction: driver });
          throw new Error('caller failed');
        });
        await expect(failing).to.be.rejectedWith('caller failed');
        expect(await db.rows(dialect, TABLE)).to.have.length(0);

        await driver.transaction(() => audit().record(input, { trail, mode: 'transactional', transaction: driver }));
        expect(await db.rows(dialect, TABLE)).to.have.length(1);
      });

      it('refuses a transactional event outside a transaction, and a transaction that is no driver', async () => {
        const input = { kind: 'data', action: 'update' } as const;
        await expect(audit().record(input, { trail, mode: 'transactional', transaction: db.driver(dialect) })).to.be.rejectedWith(AuditWriteFailed, `audit: a transactional write to trail "${trail}" found no open transaction on connection "${dialect}"`);
        await expect(audit().record(input, { trail, mode: 'transactional', transaction: {} })).to.be.rejectedWith(AuditConfigError, `audit: TableAuditStore takes the OrmDriver of the audited write as the transaction of trail "${trail}"`);
      });

      it('fails the write when the table is missing, and says where to look', async () => {
        await db.drop(dialect, TABLE);
        const error: unknown = await audit()
          .record({ kind: 'action', action: 'x' }, { trail })
          .catch((e: unknown) => e);
        expect(error).to.be.instanceOf(AuditWriteFailed);
        const inner = error instanceof AuditWriteFailed && error.inner instanceof Error ? error.inner.message : '';
        expect(inner).to.eq(`audit: recording 1 event(s) of trail "${trail}" in ${TABLE} on connection "${dialect}" failed; is the table migrated there (AuditTrailTableMigration)?`);
      });

      const input = { kind: 'read', action: 'patient.read' } as const;

      if (SINGLE.includes(dialect)) {
        it("joins the caller's transaction with a confirmed event: gone when it rolls back, kept when it commits", async () => {
          const driver = db.driver(dialect);
          const failing = driver.transaction(async () => {
            const started = Date.now();
            await audit().record(input, { trail });
            expect(Date.now() - started).to.be.below(CONFIRM_TIMEOUT_MS);
            expect(await db.rows(dialect, TABLE)).to.have.length(1);
            throw new Error('caller failed');
          });
          await expect(failing).to.be.rejectedWith('caller failed');
          expect(await db.rows(dialect, TABLE)).to.have.length(0);

          await driver.transaction(() => audit().record(input, { trail }));
          expect(await db.rows(dialect, TABLE)).to.have.length(1);
        });

        it("leaves the caller's transaction usable when a joined confirmed write fails, on a reject and on a continue trail", async () => {
          const driver = db.driver(dialect);
          await driver.transaction(async () => {
            await expect(audit().record(input, { trail: missingOf(dialect) })).to.be.rejectedWith(AuditWriteFailed, `audit: trail "${missingOf(dialect)}" could not record 1 event(s) after 1 attempt(s)`);
            await audit().record(input, { trail: lostOf(dialect), mode: 'confirmed' });
            // The caller's own write after both failures, in the same transaction.
            await audit().record({ kind: 'data', action: 'insert' }, { trail, mode: 'transactional', transaction: driver });
          });
          expect((await db.rows(dialect, TABLE)).map((r) => r.action)).to.deep.eq(['insert']);
        });
      } else {
        it("keeps a confirmed event when the caller's transaction rolls back", async () => {
          const driver = db.driver(dialect);
          const failing = driver.transaction(async () => {
            expect(new TableAuditStore().joinsCaller(trailConfig(trail), undefined)).to.eq(false);
            await audit().record(input, { trail });
            throw new Error('caller failed');
          });
          await expect(failing).to.be.rejectedWith('caller failed');
          expect(await db.rows(dialect, TABLE)).to.have.length(1);
        });
      }
    });
  }
});
