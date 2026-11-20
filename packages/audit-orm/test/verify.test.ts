import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditNotSupported, AuditReader, AuditStore, AuditWriteFailed, audit, eventsHash, payloadHash, sealHash, trailConfig } from '@spinajs/audit';
import type { AuditEvent, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { instantFromDb } from '@spinajs/orm';
import { AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, OutboxAuditStore, TableAuditStore, insertRows, sealAudit, shipAudit, storedColumns } from '../src/index.js';
import { rowDigest } from '../src/seal/seals.js';
import { archiveEvents } from '../src/ship/archive-sink.js';
import { TestDb } from '../src/testing.js';
import { config, event, setTrail, tableRows } from './support/events.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const TABLE = 'audit_sealed';
const ARCHIVE = 'audit_shipped';

class ShippedArchiveMigration extends AuditArchiveTableMigration {
  protected override table(): string {
    return ARCHIVE;
  }
}

class BlindReader extends AuditReader {
  list(): Promise<readonly StoredAuditEvent[]> {
    return Promise.resolve([]);
  }
  redact(): Promise<number> {
    return Promise.resolve(0);
  }
  prune(): Promise<number> {
    return Promise.resolve(0);
  }
}

class BlindStore extends AuditStore {
  append(): Promise<void> {
    return Promise.resolve();
  }
  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(new BlindReader());
  }
}

describe('audit verification', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
    DI.register(BlindStore).as(AuditStore);
  });

  after(async () => {
    await db?.close();
  });

  it('refuses a sealed trail whose reader cannot verify', async () => {
    setTrail('blind', { store: 'BlindStore', integrity: 'sealed' });
    try {
      await expect(audit().trail('blind').verify()).to.be.rejectedWith(AuditNotSupported, 'audit: the reader BlindReader of trail "blind" cannot verify seals');
    } finally {
      setTrail('blind', undefined);
    }
  });

  describe('a subject on two connections', () => {
    const both = ['sqlite', 'pglite'] as const;
    const subject = { type: 'contract', id: 'c1' };
    const forget = () => audit().trail('sealed').forget(subject);
    const verifyOn = (dialect: (typeof both)[number]) => audit().trail('sealed').verify(db.connectionName(dialect));

    beforeEach(async () => {
      setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: db.connectionName('sqlite'), integrity: 'sealed' });
      for (const dialect of both) {
        await db.migrate(dialect, TABLE);
        await new AuditSealTableMigration().down(db.driver(dialect));
        await new AuditSealTableMigration().up(db.driver(dialect));
      }
      const store = DI.resolve(TableAuditStore);
      await store.append({ trail: trailConfig('sealed'), events: [event(1, { subject }), event(2)] });
      await store.append({ trail: trailConfig('sealed'), events: [event(3, { subject })], connection: db.connectionName('pglite') });
      await sealAudit({ settleMs: 0 });
    });

    afterEach(async () => {
      setTrail('sealed', undefined);
      for (const dialect of both) {
        await db.drop(dialect, TABLE);
        await new AuditSealTableMigration().down(db.driver(dialect));
      }
    });

    it('finds the erasure record on every connection a subject was forgotten on', async () => {
      expect(await forget()).to.eq(2);
      for (const dialect of both) {
        expect(await verifyOn(dialect)).to.deep.include({ redacted: 1, tampered: undefined, unexplainedRedactions: [] });
      }
    });

    it('records the erasure of a connection it blanked before another connection failed', async () => {
      const pglite = db.driver('pglite');
      Reflect.set(pglite, 'update', () => {
        throw new Error('update refused');
      });
      try {
        await expect(forget()).to.be.rejectedWith('update refused');
      } finally {
        Reflect.deleteProperty(pglite, 'update');
      }
      expect(await verifyOn('sqlite')).to.deep.include({ redacted: 1, tampered: undefined, unexplainedRedactions: [] });
      expect(await verifyOn('pglite')).to.deep.include({ intact: 1, redacted: 0, tampered: undefined });
    });

    it('never blanks an earlier erasure record when the subject is forgotten again', async () => {
      await forget();
      await forget();
      for (const dialect of both) {
        const erasures = (await tableRows(db.driver(dialect), TABLE)).filter((r) => r.action === 'erasure').map((r) => r.data);
        expect(erasures).to.deep.eq(['{"redacted":1}', '{"redacted":0}']);
        expect(await verifyOn(dialect)).to.deep.include({ redacted: 1, tampered: undefined, unexplainedRedactions: [] });
      }
    });

    it('writes a missing erasure record when forget runs again after the record failed', async () => {
      setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: db.connectionName('sqlite'), integrity: 'sealed', onFailure: 'reject', retry: { attempts: 1, delay: 1 } });
      const pglite = db.driver('pglite');
      Reflect.set(pglite, 'insert', () => {
        throw new Error('insert refused');
      });
      try {
        await expect(forget()).to.be.rejectedWith(AuditWriteFailed);
      } finally {
        Reflect.deleteProperty(pglite, 'insert');
      }
      expect((await verifyOn('pglite')).unexplainedRedactions).to.deep.eq([1]);

      await forget();
      for (const dialect of both) {
        expect(await verifyOn(dialect)).to.deep.include({ redacted: 1, tampered: undefined, unexplainedRedactions: [] });
      }
    });
  });

  for (const dialect of TestDb.dialects()) {
    describe(dialect, () => {
      const driver = () => db.driver(dialect);
      const connection = (): string => db.connectionName(dialect);
      const sealedTrail = (): TrailConfig => trailConfig('sealed');
      const append = async (...events: AuditEvent[]): Promise<void> => DI.resolve(TableAuditStore).append({ trail: sealedTrail(), events });
      const seals = () => tableRows(driver(), 'audit_seal', 'id');
      const verify = () => audit().trail('sealed').verify();
      const sealNow = () => sealAudit({ settleMs: 0 });
      const edit = (seq: number, values: Record<string, unknown>) => driver().update().in(TABLE).update(values).where('seq', seq);
      const insertAt = (seq: number, e: AuditEvent) => insertRows(driver(), TABLE, [{ seq, ...storedColumns(e) }]);

      // The first select of the walk reads the seal page; `work` runs once it has resolved, before the range is read. The
      // builder is a thenable that `await` calls once: its own `then` property wraps the resolution.
      const afterPageRead = (work: () => Promise<unknown>): void => {
        const select = Reflect.get(driver(), 'select');
        Reflect.set(driver(), 'select', (...args: unknown[]): unknown => {
          Reflect.deleteProperty(driver(), 'select');
          const page: unknown = Reflect.apply(select, driver(), args);
          const then: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'then') : undefined;
          if (typeof page !== 'object' || page === null || typeof then !== 'function') return page;
          Reflect.set(page, 'then', (done: (rows: unknown) => unknown, failed: (err: unknown) => unknown): unknown => {
            const workFirst = async (rows: unknown): Promise<unknown> => {
              await work();
              return done(rows);
            };
            const chained: unknown = Reflect.apply(then, page, [workFirst, failed]);
            return chained;
          });
          return page;
        });
      };

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed' });
        await db.migrate(dialect, TABLE);
        await new AuditSealTableMigration().down(driver());
        await new AuditSealTableMigration().up(driver());
      });

      afterEach(async () => {
        setTrail('sealed', undefined);
        setTrail('shipped', undefined);
        await db.drop(dialect, TABLE);
        await new AuditSealTableMigration().down(driver());
      });

      it('reports sealed events as intact and counts the tail', async () => {
        await append(event(1), event(2));
        await sealNow();
        await append(event(3, { at: new Date() }));

        const report = await verify();
        expect(report).to.deep.include({ trail: 'sealed', connection: connection(), table: TABLE, seals: 1, intact: 2, redacted: 0, prunedSeals: 0, tampered: undefined, unsealed: 1, staleUnsealed: 0, uncovered: [], unexplainedRedactions: [], earlyPrunes: [] });
        expect(report.head).to.deep.eq({ toSeq: 2, hash: (await seals())[0].hash });

        // A sealer that stopped, or seals that were deleted, leave rows older than the sealing window.
        await append(event(4));
        expect(await verify()).to.deep.include({ unsealed: 2, staleUnsealed: 1 });
      });

      it('reports an erased payload as redacted, and a payload blanked outside forget as unexplained', async () => {
        await append(event(1), event(2, { subject: { type: 'contract', id: 'c1' } }), event(3));
        await sealNow();
        expect(await audit().trail('sealed').forget({ type: 'contract', id: 'c1' })).to.eq(2);
        expect(await verify()).to.deep.include({ seals: 1, intact: 1, redacted: 2, tampered: undefined, unexplainedRedactions: [] });

        await edit(3, { data: '' });
        expect(await verify()).to.deep.include({ intact: 0, redacted: 3, tampered: undefined, unexplainedRedactions: [3] });
      });

      it('counts an erasure record only where it is sealed, or fresh in the tail', async () => {
        const erasure = (n: number, at: Date): AuditEvent => event(n, { action: 'erasure', subject: { type: 'contract', id: 'c1' }, at, data: { redacted: 1 } });
        await append(event(1), event(2), event(3));
        await driver().del().from(TABLE).where('seq', 2);
        await sealNow();
        await edit(1, { data: '' });
        // In a gap of a sealed range: not covered by the seal, so it explains nothing.
        await insertAt(2, erasure(5, new Date(Date.UTC(2026, 10, 16, 10, 0, 9))));
        expect(await verify()).to.deep.include({ uncovered: [{ seq: 2, reason: 'late', fromSeq: 1, toSeq: 3 }], unexplainedRedactions: [1] });

        // In the tail, older than a sealing window: the sealer would have sealed a genuine one by now.
        await append(erasure(6, new Date(Date.UTC(2026, 10, 16, 11))));
        expect((await verify()).unexplainedRedactions).to.deep.eq([1]);

        await append(erasure(7, new Date()));
        expect((await verify()).unexplainedRedactions).to.deep.eq([]);
      });

      it('refuses to run inside an open transaction', async () => {
        await expect(driver().transaction(() => verify())).to.be.rejectedWith(`audit: verifying "${TABLE}" on connection "${connection()}" needs a transaction of its own; run it outside an open transaction`);
      });

      it('names the event whose payload was edited', async () => {
        await append(event(1), event(2));
        await sealNow();
        await edit(2, { data: JSON.stringify({ version: 99 }) });

        expect((await verify()).tampered).to.deep.eq({ seq: 2, reason: 'payload', fromSeq: 1, toSeq: 2 });
      });

      it('names the seal when a sealed column, or a payload together with its hash, was edited', async () => {
        await append(event(1), event(2));
        await sealNow();
        await edit(2, { actor: 'user:intruder' });
        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });

        await edit(2, { actor: 'user:u1', data: JSON.stringify({ version: 99 }), data_hash: payloadHash({ version: 99 }) });
        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
      });

      it('names the seal when sealed events were reordered', async () => {
        await append(event(1), event(2));
        await sealNow();
        await edit(1, { seq: 100 });
        await edit(2, { seq: 1 });
        await edit(100, { seq: 2 });

        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
      });

      it('names the seal when a sealed event is gone', async () => {
        await append(event(1), event(2));
        await sealNow();
        await driver().del().from(TABLE).where('seq', 2);

        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'count', fromSeq: 1, toSeq: 2 });
      });

      it('reports a row in a sealed range its seal does not cover, apart from tampering', async () => {
        await append(event(1), event(2), event(3));
        await driver().del().from(TABLE).where('seq', 2);
        await sealNow();
        // What a transaction that commits after its range was sealed leaves behind, and what an insertion looks like.
        await insertAt(2, event(5));

        expect(await verify()).to.deep.include({ seals: 1, intact: 2, tampered: undefined, uncovered: [{ seq: 2, reason: 'late', fromSeq: 1, toSeq: 3 }] });
      });

      it('names the seal when a row in its range was written after it was sealed', async () => {
        await append(event(1), event(2), event(3));
        await driver().del().from(TABLE).where('seq', 2);
        await sealAudit({ settleMs: 0, now: new Date('2026-11-16T10:00:10Z') });
        // Stamped later than the seal: no commit of a row recorded before the seal can carry it.
        await insertAt(2, event(5, { at: new Date('2026-11-16T10:00:20Z') }));

        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'count', fromSeq: 1, toSeq: 3 });
      });

      it('names the seal whose hash was changed', async () => {
        await append(event(1), event(2));
        await sealNow();
        await driver()
          .update()
          .in('audit_seal')
          .update({ hash: '0'.repeat(64) })
          .where('from_seq', 1);

        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
      });

      it('names the seal whose time or events hash was changed', async () => {
        await append(event(1), event(2));
        await sealNow();
        const [seal] = await seals();
        const editSeal = (values: Record<string, unknown>) => driver().update().in('audit_seal').update(values).where('from_seq', 1);
        await editSeal({ sealed_at: new Date('2020-01-01T00:00:00Z') });
        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });

        await editSeal({ sealed_at: instantFromDb(seal.sealed_at)?.toJSDate() });
        expect((await verify()).tampered).to.eq(undefined);
        await editSeal({ events_hash: '2'.repeat(64) });
        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
      });

      it('names the seal whose predecessor is gone, and stops there', async () => {
        await append(event(1));
        await sealNow();
        await append(event(2));
        await sealNow();
        await driver().del().from('audit_seal').where('from_seq', 1);

        const report = await verify();
        expect(report.tampered).to.deep.eq({ seq: 2, reason: 'chain', fromSeq: 2, toSeq: 2 });
        expect([report.seals, report.intact, report.head]).to.deep.eq([1, 0, undefined]);
      });

      it('names the seal of a forked chain', async () => {
        await append(event(1));
        await sealNow();
        await append(event(2));
        await sealNow();
        const [first] = await seals();
        await append(event(3));
        await driver()
          .insert()
          .into('audit_seal')
          .values({ trail_table: TABLE, from_seq: 3, to_seq: 3, event_count: 1, events_hash: '1'.repeat(64), hash: '1'.repeat(64), previous_hash: first.hash, sealed_at: new Date() });

        expect((await verify()).tampered).to.deep.eq({ seq: 3, reason: 'chain', fromSeq: 3, toSeq: 3 });
      });

      it('checks the chain against a head kept outside the database', async () => {
        await append(event(1), event(2));
        await sealNow();
        const [seal] = await seals();
        const pinned = (toSeq: number, hash: string) => audit().trail('sealed').verify(undefined, { toSeq, hash });

        expect((await pinned(2, String(seal.hash))).tampered).to.eq(undefined);
        expect((await pinned(2, '2'.repeat(64))).tampered).to.deep.eq({ seq: 1, reason: 'chain', fromSeq: 1, toSeq: 2 });
        expect((await pinned(5, String(seal.hash))).tampered).to.deep.eq({ seq: 5, reason: 'chain', fromSeq: 5, toSeq: 5 });
      });

      it('keeps the chain across a pruned range, and reports a row written into it', async () => {
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
        await append(event(1), event(2));
        await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
        await append(event(3));
        await sealNow();
        const reader = await DI.resolve(TableAuditStore).reader(sealedTrail());
        await reader?.prune(sealedTrail(), new Date('2021-01-01T00:00:00Z'));
        expect(await verify()).to.deep.include({ seals: 2, prunedSeals: 1, intact: 1, tampered: undefined, unsealed: 0, uncovered: [] });

        await insertAt(1, event(9));
        expect(await verify()).to.deep.include({ tampered: undefined, uncovered: [{ seq: 1, reason: 'pruned', fromSeq: 1, toSeq: 2 }] });
      });

      it('names a seal marked pruned out of order or in the future, and doubts one retention here does not explain', async () => {
        const prune = (fromSeq: number) => driver().update().in('audit_seal').update({ pruned_at: new Date() }).where('from_seq', fromSeq);
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
        await append(event(1));
        await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
        await append(event(2));
        await sealNow();
        await append(event(3));
        await sealNow();

        // After a seal that is not pruned.
        await prune(3);
        expect((await verify()).tampered).to.deep.eq({ seq: 3, reason: 'count', fromSeq: 3, toSeq: 3 });
        // Younger than retentionDays when pruned: lawful after retentionDays was raised or a direct prune, so only doubted.
        await prune(1);
        await prune(2);
        expect(await verify()).to.deep.include({
          tampered: undefined,
          prunedSeals: 3,
          earlyPrunes: [
            { fromSeq: 2, toSeq: 2 },
            { fromSeq: 3, toSeq: 3 },
          ],
        });
        // A trail without retention here explains no prune.
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed' });
        expect((await verify()).earlyPrunes).to.have.length(3);
        // Stamped in the future.
        await driver()
          .update()
          .in('audit_seal')
          .update({ pruned_at: new Date(Date.now() + 86400000) })
          .where('from_seq', 1);
        expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'count', fromSeq: 1, toSeq: 1 });
      });

      it('names a forged prune whose seal time was moved back past retention', async () => {
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
        await append(event(1));
        await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
        await append(event(2));
        await sealNow();
        await driver().update().in('audit_seal').update({ pruned_at: new Date() }).where('from_seq', 1);
        await driver()
          .update()
          .in('audit_seal')
          .update({ sealed_at: new Date('2020-06-02T00:00:00Z'), pruned_at: new Date() })
          .where('from_seq', 2);
        await driver().del().from(TABLE).where('seq', '<=', 2);

        expect((await verify()).tampered).to.deep.eq({ seq: 2, reason: 'seal', fromSeq: 2, toSeq: 2 });
      });

      it('names a forged prune with a recomputed hash against a pinned head', async () => {
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
        await append(event(1));
        await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
        await append(event(2));
        await sealNow();
        const [first, second] = await seals();
        const backdated = new Date('2020-06-02T00:00:00Z');
        await driver().update().in('audit_seal').update({ pruned_at: new Date() }).where('from_seq', 1);
        await driver()
          .update()
          .in('audit_seal')
          .update({ sealed_at: backdated, pruned_at: new Date(), hash: sealHash(String(first.hash), backdated, String(second.events_hash)) })
          .where('from_seq', 2);
        await driver().del().from(TABLE).where('seq', '<=', 2);

        // Without a head kept outside the database, a writer to audit_seal who recomputes the hash is not caught.
        expect((await verify()).tampered).to.eq(undefined);
        expect(
          (
            await audit()
              .trail('sealed')
              .verify(undefined, { toSeq: 2, hash: String(second.hash) })
          ).tampered,
        ).to.deep.eq({ seq: 2, reason: 'chain', fromSeq: 2, toSeq: 2 });
      });

      it('names a seal forged pruned and backdated during the walk, under a pinned head', async () => {
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
        await append(event(1), event(2));
        await sealNow();
        const [seal] = await seals();
        afterPageRead(async () => {
          await driver().del().from(TABLE).where('seq', '<=', 2);
          await driver()
            .update()
            .in('audit_seal')
            .update({ sealed_at: new Date('2020-06-01T00:00:00Z'), pruned_at: new Date() })
            .where('from_seq', 1);
        });

        const report = await audit()
          .trail('sealed')
          .verify(undefined, { toSeq: 2, hash: String(seal.hash) });
        expect(report.tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
      });

      it('takes a seal that retention pruned during the walk as pruned', async () => {
        setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
        await append(event(1), event(2));
        await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
        const reader = await DI.resolve(TableAuditStore).reader(sealedTrail());
        afterPageRead(async () => reader?.prune(sealedTrail(), new Date('2021-01-01T00:00:00Z')));

        expect(await verify()).to.deep.include({ tampered: undefined, prunedSeals: 1, intact: 0, earlyPrunes: [] });
      });

      it('verifies a shipping trail at its archive', async () => {
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: connection(), archiveConnection: connection(), integrity: 'sealed' });
        await new AuditOutboxTableMigration().down(driver());
        await new ShippedArchiveMigration().down(driver());
        await new AuditOutboxTableMigration().up(driver());
        await new ShippedArchiveMigration().up(driver());
        try {
          await DI.resolve(OutboxAuditStore).append({ trail: trailConfig('shipped'), events: [event(1), event(2)] });
          await shipAudit({ trail: 'shipped' });
          await sealNow();
          expect(await audit().trail('shipped').verify()).to.deep.include({ trail: 'shipped', table: ARCHIVE, seals: 1, intact: 2, tampered: undefined, unsealed: 0 });

          await driver().update().in(ARCHIVE).update({ source: 'elsewhere' }).where('seq', 1);
          expect((await audit().trail('shipped').verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
        } finally {
          await new AuditOutboxTableMigration().down(driver());
          await new ShippedArchiveMigration().down(driver());
        }
      });

      it('allows an archive row the clock skew the queue consumer allows', async () => {
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: connection(), archiveConnection: connection(), integrity: 'sealed' });
        await new ShippedArchiveMigration().down(driver());
        await new ShippedArchiveMigration().up(driver());
        try {
          await archiveEvents(driver(), ARCHIVE, 'orders', [event(1), event(2), event(3)]);
          await driver().del().from(ARCHIVE).where('seq', 2);
          await sealAudit({ settleMs: 0, now: new Date('2026-11-16T10:00:10Z') });
          // Stamped by a shipping application whose clock runs a minute ahead.
          await insertRows(driver(), ARCHIVE, [{ seq: 2, source: 'orders', ...storedColumns(event(5, { at: new Date('2026-11-16T10:01:10Z') })) }]);
          expect(await audit().trail('shipped').verify()).to.deep.include({ tampered: undefined, uncovered: [{ seq: 2, reason: 'late', fromSeq: 1, toSeq: 3 }] });
        } finally {
          await new ShippedArchiveMigration().down(driver());
        }
      });

      describe('with seal keys', () => {
        const OLD = { id: '2026-10', secret: 'a'.repeat(32) };
        const NEW = { id: '2026-11', secret: 'b'.repeat(32) };
        const useKeys = (...keys: { id: string; secret: string }[]): void => config().set(['audit', 'seal'], keys.length === 0 ? undefined : { keys });
        const useKeysAfter = (keylessUpTo: number, ...keys: { id: string; secret: string }[]): void => config().set(['audit', 'seal'], { keys, keylessUpTo: { [TABLE]: keylessUpTo } });
        const keyIds = async (): Promise<unknown[]> => (await seals()).map((s) => s.key_id);
        const keylessRefusal = (toSeq: number): string => `audit: the seal chain of "${TABLE}" on connection "${connection()}" ends in a keyless seal at seq ${toSeq} past audit.seal.keylessUpTo, so a keyed seal after it would vouch for it; if it was sealed before audit.seal.keys was set, set audit.seal.keylessUpTo["${TABLE}"] to ${toSeq}, else run audit:verify`;

        // What someone without the key can do: recompute every seal from the rows as they are now, with the public function.
        const resealKeyless = async (keyId: string | null): Promise<void> => {
          let previous: string | null = null;
          for (const seal of await seals()) {
            const rows = (await tableRows(driver(), TABLE)).filter((r) => Number(r.seq) >= Number(seal.from_seq) && Number(r.seq) <= Number(seal.to_seq));
            const sealedAt = instantFromDb(seal.sealed_at)?.toJSDate() ?? new Date(Number.NaN);
            const events = eventsHash(rows.map((r) => rowDigest(r)));
            const hash = sealHash(previous, sealedAt, events);
            await driver().update().in('audit_seal').update({ event_count: rows.length, events_hash: events, hash, previous_hash: previous, key_id: keyId }).where('id', seal.id);
            previous = hash;
          }
        };

        afterEach(() => useKeys());

        it('fails a keyed chain whose seals were recomputed without the key', async () => {
          useKeys(OLD);
          await append(event(1), event(2));
          await sealNow();
          await append(event(3));
          await sealNow();
          expect(await keyIds()).to.deep.eq([OLD.id, OLD.id]);
          expect(await verify()).to.deep.include({ intact: 3, tampered: undefined, unverifiable: undefined, keylessHead: false });

          await driver().del().from(TABLE).where('seq', 2);
          await resealKeyless(OLD.id);
          expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });
        });

        it('fails a keyless seal after a keyed one, and a keyed chain rewritten keyless from its first seal', async () => {
          useKeys(OLD);
          await append(event(1));
          await sealNow();
          await append(event(2));
          await sealNow();
          await edit(2, { actor: 'user:u2' });
          const [first] = await seals();
          // Only the second seal rewritten, keyless, chained to the keyed first one.
          const sealedAt = instantFromDb((await seals())[1].sealed_at)?.toJSDate() ?? new Date(Number.NaN);
          const events = eventsHash((await tableRows(driver(), TABLE)).filter((r) => Number(r.seq) === 2).map((r) => rowDigest(r)));
          await driver()
            .update()
            .in('audit_seal')
            .update({ events_hash: events, hash: sealHash(String(first.hash), sealedAt, events), key_id: null })
            .where('from_seq', 2);
          expect((await verify()).tampered).to.deep.eq({ seq: 2, reason: 'seal', fromSeq: 2, toSeq: 2 });

          // With keys and no audit.seal.keylessUpTo, no keyless seal is lawful; a verifier without either cannot tell.
          await resealKeyless(null);
          expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 1 });
          useKeys();
          expect(await verify()).to.deep.include({ tampered: undefined, keylessHead: false });
        });

        it('keeps a keyed chain rewritten keyless tampered, because the sealer refuses to sign on top of it', async () => {
          useKeys(OLD);
          await append(event(1));
          await sealNow();
          await append(event(2));
          await sealNow();
          await edit(2, { actor: 'user:u2' });
          await resealKeyless(null);
          await append(event(3));
          const { sealed, failed } = await sealNow();
          expect([sealed, failed.map((f) => f.reason)]).to.deep.eq([0, [keylessRefusal(2)]]);
          expect(await keyIds()).to.deep.eq([null, null]);
          expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 1 });

          // A lawful keyless prefix does not cover a keyless rewrite past it.
          useKeysAfter(1, OLD);
          expect((await verify()).tampered).to.deep.eq({ seq: 2, reason: 'seal', fromSeq: 2, toSeq: 2 });
          expect((await sealNow()).failed.map((f) => f.reason)).to.deep.eq([keylessRefusal(2)]);
        });

        it('signs with the first key and verifies with every listed one', async () => {
          useKeys(OLD);
          await append(event(1));
          await sealNow();
          useKeys(NEW, OLD);
          await append(event(2));
          await sealNow();
          expect(await keyIds()).to.deep.eq([OLD.id, NEW.id]);
          expect(await verify()).to.deep.include({ seals: 2, intact: 2, tampered: undefined, unverifiable: undefined });

          useKeys(NEW);
          const report = await verify();
          expect(report).to.deep.include({ seals: 1, intact: 0, tampered: undefined, head: undefined, unverifiable: { keyId: OLD.id, fromSeq: 1, toSeq: 1 } });
          useKeys();
          expect((await verify()).unverifiable).to.deep.eq({ keyId: OLD.id, fromSeq: 1, toSeq: 1 });
        });

        it('turns a keyless chain keyed in the middle at audit.seal.keylessUpTo, and never back', async () => {
          await append(event(1));
          await sealNow();
          useKeys(OLD);
          // Keys added without naming where the keyless part ends: its seals are not lawful, and the sealer names the value.
          expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 1 });
          await append(event(2));
          expect((await sealNow()).failed.map((f) => f.reason)).to.deep.eq([keylessRefusal(1)]);

          useKeysAfter(1, OLD);
          expect(await verify()).to.deep.include({ tampered: undefined, intact: 1, keylessHead: true });
          await sealNow();
          expect(await keyIds()).to.deep.eq([null, OLD.id]);
          expect(await verify()).to.deep.include({ tampered: undefined, intact: 2, keylessHead: false });

          useKeys();
          await append(event(3));
          const { sealed, failed } = await sealNow();
          expect([sealed, failed.map((f) => f.reason)]).to.deep.eq([0, [`audit: the seal chain of "${TABLE}" on connection "${connection()}" is keyed (key "${OLD.id}"), so a keyless seal after it would read as tampered; set audit.seal.keys`]]);
          expect(await keyIds()).to.deep.eq([null, OLD.id]);
        });

        it('fails and refuses a keyless seal past audit.seal.keylessUpTo, also without keys', async () => {
          await append(event(1), event(2));
          await sealNow();
          config().set(['audit', 'seal'], { keylessUpTo: { [TABLE]: 1 } });
          expect((await verify()).tampered).to.deep.eq({ seq: 1, reason: 'seal', fromSeq: 1, toSeq: 2 });

          config().set(['audit', 'seal'], { keylessUpTo: { [TABLE]: { [connection()]: 2, elsewhere: 0 } } });
          expect(await verify()).to.deep.include({ tampered: undefined, intact: 2 });
          await append(event(3));
          const refused = `audit: audit.seal.keylessUpTo ends the keyless seals of "${TABLE}" on connection "${connection()}" at seq 2, so a keyless seal up to seq 3 would read as tampered; set audit.seal.keys`;
          expect((await sealNow()).failed.map((f) => f.reason)).to.deep.eq([refused]);
        });

        it('prunes keyed seals whole and keeps verifying the chain after them', async () => {
          setTrail('sealed', { store: 'TableAuditStore', table: TABLE, connection: connection(), integrity: 'sealed', retentionDays: 30 });
          useKeys(OLD);
          await append(event(1), event(2));
          await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
          await append(event(3));
          await sealNow();
          const reader = await DI.resolve(TableAuditStore).reader(sealedTrail());
          expect(await reader?.prune(sealedTrail(), new Date('2021-01-01T00:00:00Z'))).to.eq(2);

          expect(await keyIds()).to.deep.eq([OLD.id, OLD.id]);
          expect(await verify()).to.deep.include({ seals: 2, prunedSeals: 1, intact: 1, tampered: undefined, unverifiable: undefined, earlyPrunes: [] });
          await driver().update().in('audit_seal').update({ key_id: NEW.id }).where('from_seq', 1);
          expect((await verify()).unverifiable).to.deep.eq({ keyId: NEW.id, fromSeq: 1, toSeq: 2 });
        });
      });

      it('refuses a trail that is not sealed', async () => {
        await expect(audit().trail('default').verify()).to.be.rejectedWith(AuditNotSupported, 'audit: trail "default" is not sealed, so it has nothing to verify (audit.trails.default.integrity)');
      });
    });
  }
});
