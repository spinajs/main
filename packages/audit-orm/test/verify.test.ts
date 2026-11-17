import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditNotSupported, AuditReader, AuditStore, audit, payloadHash, trailConfig } from '@spinajs/audit';
import type { AuditEvent, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, OutboxAuditStore, TableAuditStore, insertRows, sealAudit, shipAudit, storedColumns } from '../src/index.js';
import { TestDb } from '../src/testing.js';
import { event, setTrail, tableRows } from './support/events.js';

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
        await append(event(3));

        const report = await verify();
        expect(report).to.deep.include({ trail: 'sealed', connection: connection(), table: TABLE, seals: 1, intact: 2, redacted: 0, prunedSeals: 0, tampered: undefined, unsealed: 1, uncovered: [], unexplainedRedactions: [] });
        expect(report.head).to.deep.eq({ toSeq: 2, hash: (await seals())[0].hash });
      });

      it('reports an erased payload as redacted, and a payload blanked outside forget as unexplained', async () => {
        await append(event(1), event(2, { subject: { type: 'contract', id: 'c1' } }), event(3));
        await sealNow();
        expect(await audit().trail('sealed').forget({ type: 'contract', id: 'c1' })).to.eq(2);
        expect(await verify()).to.deep.include({ seals: 1, intact: 1, redacted: 2, tampered: undefined, unexplainedRedactions: [] });

        await edit(3, { data: '' });
        expect(await verify()).to.deep.include({ intact: 0, redacted: 3, tampered: undefined, unexplainedRedactions: [3] });
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
          .values({ trail_table: TABLE, from_seq: 3, to_seq: 3, event_count: 1, hash: '1'.repeat(64), previous_hash: first.hash, sealed_at: new Date() });

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

      it('refuses a trail that is not sealed', async () => {
        await expect(audit().trail('default').verify()).to.be.rejectedWith(AuditNotSupported, 'audit: trail "default" is not sealed, so it has nothing to verify (audit.trails.default.integrity)');
      });
    });
  }
});
