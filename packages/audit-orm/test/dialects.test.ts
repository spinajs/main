import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { audit, eventDigest, eventsHash, payloadHash, sealHash, trailConfig } from '@spinajs/audit';
import type { AuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { instantFromDb } from '@spinajs/orm';
import { ArchiveAuditSink, AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, OutboxAuditStore, insertRows, sealAudit, shipAudit, storedColumns } from '../src/index.js';
import type { AuditRow } from '../src/index.js';
import { TestDb } from '../src/testing.js';
import { event, setTrail, tableRows } from './support/events.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const ARCHIVE = 'audit_shipped';

// The hash a seal row must carry over these digests: its events hash, chained with its own sealed_at as the dialect reads it back.
function expectSealOver(seal: AuditRow, digests: readonly string[]): void {
  const sealedAt = instantFromDb(seal.sealed_at)?.toJSDate() ?? new Date(Number.NaN);
  expect([seal.events_hash, seal.hash]).to.deep.eq([eventsHash(digests), sealHash(null, sealedAt, eventsHash(digests))]);
}

class ShippedArchiveMigration extends AuditArchiveTableMigration {
  protected override table(): string {
    return ARCHIVE;
  }
}

describe('audit-orm dialect parity', function () {
  this.timeout(120000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  it('reaches the servers the dialect job requires', () => {
    if (process.env.ORM_TEST_DIALECTS_REQUIRED !== '1') return;
    expect((['postgres', 'mysql'] as const).filter((dialect) => !db.has(dialect))).to.deep.eq([]);
  });

  for (const dialect of TestDb.dialects()) {
    describe(dialect, () => {
      let store: OutboxAuditStore;
      let sink: ArchiveAuditSink;
      const driver = () => db.driver(dialect);
      const shipped = (): TrailConfig => trailConfig('shipped');
      const migrations = () => [new AuditOutboxTableMigration(), new ShippedArchiveMigration(), new AuditSealTableMigration()];
      const sealNow = () => sealAudit({ trail: 'shipped', settleMs: 0 });

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        const name = db.connectionName(dialect);
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: name, archiveConnection: name, integrity: 'sealed' });
        // A server keeps what an earlier run left, and shipAudit reads the buffer of every open connection.
        // spinajs-orm-ignore ORM102: one DDL statement per reachable server of the test setup
        for (const other of TestDb.dialects().filter((d) => d !== dialect && db.has(d))) await new AuditOutboxTableMigration().down(db.driver(other));
        // spinajs-orm-ignore ORM102: three DDL statements of the test setup
        for (const m of migrations()) await m.down(driver());
        // spinajs-orm-ignore ORM102: three DDL statements of the test setup
        for (const m of migrations()) await m.up(driver());
        store = DI.resolve(OutboxAuditStore);
        sink = DI.resolve(ArchiveAuditSink);
      });

      afterEach(async () => {
        setTrail('shipped', undefined);
        // spinajs-orm-ignore ORM102: three DDL statements of the test teardown
        for (const m of migrations()) await m.down(driver());
      });

      it('carries an event through buffer, shipment, archive and seal unchanged', async () => {
        // Above the 64 KB of a MySQL TEXT column: data is LONGTEXT.
        const big = event(1, { data: { text: 'naïve café 東京', pad: 'x'.repeat(100000), nested: { n: 1.5, list: [1, 'two', null] } } });
        await store.append({ trail: shipped(), events: [big, event(2)] });
        expect((await tableRows(driver(), 'audit_outbox')).map((r) => String(r.id).length)).to.deep.eq([36, 36]);
        expect(await shipAudit({ trail: 'shipped' })).to.deep.eq({ shipped: 2, failed: [] });
        expect(await sealNow()).to.deep.eq({ sealed: 2, failed: [] });

        const [first, second] = await audit().trail('shipped').since(0);
        expect(first.data).to.deep.eq(big.data);
        expect([first.id, second.id, first.at.getTime()]).to.deep.eq([big.id, event(2).id, big.at.getTime()]);
        const source = db.connectionName(dialect);
        const digests = [big, event(2)].map((e: AuditEvent) => eventDigest({ ...e, source }, payloadHash(e.data)));
        const [seal] = await tableRows(driver(), 'audit_seal', 'id');
        expectSealOver(seal, digests);
        expect(await audit().trail('shipped').verify()).to.deep.include({ intact: 2, redacted: 0, tampered: undefined, unsealed: 0 });
      });

      it('keeps a subject as spelled through buffer and archive, and erases that spelling only', async () => {
        const user = (id: string) => ({ type: 'user', id });
        const about = (n: number, id: string): AuditEvent => event(n, { subject: user(id), data: { name: 'Łukasz Żółć' } });
        await store.append({ trail: shipped(), events: [about(1, 'Łukasz-7'), about(2, 'ABC'), about(3, 'abc')] });
        await shipAudit({ trail: 'shipped' });
        await store.append({ trail: shipped(), events: [about(4, 'ABC'), about(5, 'abc')] });

        expect(await audit().trail('shipped').forget(user('abc'))).to.eq(2);
        await shipAudit({ trail: 'shipped' });
        const archived = (await tableRows(driver(), ARCHIVE)).filter((r) => r.action !== 'erasure').map((r) => [r.subject_id, r.data === '']);
        expect(archived).to.deep.eq([['Łukasz-7', false], ['ABC', false], ['abc', true], ['ABC', false], ['abc', true]]);
        const [lukasz] = await audit().trail('shipped').of(user('Łukasz-7'));
        expect(lukasz?.data).to.deep.eq({ name: 'Łukasz Żółć' });
        expect(await sealNow()).to.deep.include({ failed: [] });
        expect(await audit().trail('shipped').verify()).to.deep.include({ redacted: 2, tampered: undefined, unexplainedRedactions: [] });
      });

      it('keeps the milliseconds of at, so what it sealed verifies', async () => {
        const precise = event(1, { at: new Date('2026-11-16T10:00:01.234Z') });
        await sink.deliver({ trail: 'shipped', source: 'app', events: [precise] });
        const [stored] = await audit().trail('shipped').since(0, { source: 'app' });
        expect(stored.at.toISOString()).to.eq(precise.at.toISOString());
        await sealNow();
        const [seal] = await tableRows(driver(), 'audit_seal', 'id');
        expectSealOver(seal, [eventDigest({ ...precise, source: 'app' }, payloadHash(precise.data))]);
        expect(await audit().trail('shipped').verify()).to.deep.include({ intact: 1, tampered: undefined });
      });

      it('refuses a second archive row with the same id', async () => {
        await sink.deliver({ trail: 'shipped', source: 'app', events: [event(1)] });
        await expect(insertRows(driver(), ARCHIVE, [{ source: 'app', ...storedColumns(event(1)) }])).to.be.rejected;
        expect(await tableRows(driver(), ARCHIVE)).to.have.length(1);
      });

      it('ships everything written after the buffer was emptied', async () => {
        // No server restart here, so not MySQL 5.7's autoincrement reset itself: only that shipping continues after an
        // emptied buffer, telling events apart by id, as it must when such a reset hands out a seq again.
        await store.append({ trail: shipped(), events: [event(1), event(2)] });
        await shipAudit({ trail: 'shipped' });
        await store.append({ trail: shipped(), events: [event(3)] });
        await shipAudit({ trail: 'shipped' });
        expect((await tableRows(driver(), ARCHIVE)).map((r) => r.id)).to.deep.eq([event(1).id, event(2).id, event(3).id]);
      });

      it('reads a bigint seq as a number and pages by it', async () => {
        await sink.deliver({ trail: 'shipped', source: 'app', events: [event(1), event(2), event(3)] });
        const all = await audit().trail('shipped').since(0, { source: 'app' });
        expect(all.map((e) => typeof e.seq)).to.deep.eq(['number', 'number', 'number']);
        expect((await audit().trail('shipped').since(all[0].seq, { source: 'app', limit: 1 })).map((e) => e.id)).to.deep.eq([event(2).id]);
      });
    });
  }
});
