import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, audit, trailConfig } from '@spinajs/audit';
import type { AuditReader, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { ArchiveAuditSink, AuditArchiveTableMigration, AuditOutboxTableMigration, AuditPruneFailed, OutboxAuditStore, pruneAudit, shipAudit } from '../src/index.js';
import { TestDb } from '../src/testing.js';
import type { Dialect } from '../src/testing.js';
import { TRACE, config, event, setTrail, tableRows } from './support/events.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const ARCHIVE = 'audit_shipped';
const ARCHIVE_CONNECTION = { Driver: 'orm-driver-sqlite', Name: 'archive', Filename: ':memory:' };
const SUBJECT = { type: 'contract', id: 'c1' };

class ShippedArchiveMigration extends AuditArchiveTableMigration {
  protected override table(): string {
    return ARCHIVE;
  }
}

function archiveSuite(name: string, dialect: Dialect, db: () => TestDb, archiveConnection: string): void {
  describe(name, () => {
    let store: OutboxAuditStore;
    let sink: ArchiveAuditSink;
    const source = (): OrmDriver => db().driver(dialect);
    const archive = (): OrmDriver => db().driver(archiveConnection);
    const shipped = (): TrailConfig => trailConfig('shipped');
    const archived = () => tableRows(archive(), ARCHIVE);
    const buffered = () => tableRows(source(), 'audit_outbox');
    const options = (): Record<string, unknown> => ({ store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: source().Options.Name, archiveConnection: archive().Options.Name });
    const withoutArchive = (): Record<string, unknown> => Object.fromEntries(Object.entries(options()).filter(([key]) => key !== 'archiveConnection'));
    const reader = async (): Promise<AuditReader> => {
      const found = await store.reader(shipped());
      if (!found) throw new Error('the shipped trail has no reader');
      return found;
    };

    before(function () {
      if (!db().has(dialect)) this.skip();
    });

    beforeEach(async () => {
      setTrail('shipped', options());
      // A server keeps what an earlier run left.
      await new AuditOutboxTableMigration().down(source());
      await new ShippedArchiveMigration().down(archive());
      await new AuditOutboxTableMigration().up(source());
      await new ShippedArchiveMigration().up(archive());
      store = DI.resolve(OutboxAuditStore);
      sink = DI.resolve(ArchiveAuditSink);
    });

    afterEach(async () => {
      setTrail('shipped', undefined);
      await new AuditOutboxTableMigration().down(source());
      await new ShippedArchiveMigration().down(archive());
    });

    it('moves events to the archive and reads them back', async () => {
      const from = source().Options.Name;
      await store.append({ trail: shipped(), events: [event(1), event(2, { subject: SUBJECT })] });
      expect(await audit().trail('shipped').of(SUBJECT)).to.deep.eq([]); // not shipped yet (S12)

      expect(await shipAudit({ trail: 'shipped' })).to.deep.eq({ shipped: 2, failed: [] });
      expect((await archived()).map((r) => [r.source, r.id, r.subject_id])).to.deep.eq([
        [from, event(1).id, 'c1'],
        [from, event(2).id, 'c1'],
      ]);
      expect(await buffered()).to.have.length(0);

      const timeline = await audit().trail('shipped').of(SUBJECT);
      expect(timeline.map((e) => [e.id, e.action, e.actor, e.traceId, e.data, e.redacted])).to.deep.eq([
        [event(1).id, 'contract.signed', 'user:u1', TRACE, { version: 1 }, false],
        [event(2).id, 'contract.signed', 'user:u1', TRACE, { version: 2 }, false],
      ]);
      expect(timeline[1].seq).to.be.greaterThan(timeline[0].seq);
      expect(await audit().trail('shipped').byActor('user:u1')).to.have.length(2);
      expect(await audit().trail('shipped').byTrace(TRACE)).to.have.length(2);
      expect((await audit().trail('shipped').since(timeline[0].seq)).map((e) => e.id)).to.deep.eq([event(2).id]);
    });

    it('stores a redelivered batch, and an id repeated inside a batch, once', async () => {
      const batch = { trail: 'shipped', source: 'app', events: [event(1), event(1), event(2)] };
      await sink.deliver(batch);
      await sink.deliver(batch);
      expect((await archived()).map((r) => r.id)).to.deep.eq([event(1).id, event(2).id]);
    });

    it('stores two deliveries of one batch running at once, each event once', async () => {
      const batch = { trail: 'shipped', source: 'app', events: [event(1), event(2)] };
      await Promise.all([sink.deliver(batch), sink.deliver(batch)]);
      expect((await archived()).map((r) => r.id)).to.deep.eq([event(1).id, event(2).id]);
    });

    it('keeps the events of two source connections apart', async () => {
      await sink.deliver({ trail: 'shipped', source: source().Options.Name, events: [event(1)] });
      await sink.deliver({ trail: 'shipped', source: 'other-app', events: [event(2, { subject: SUBJECT })] });
      expect((await audit().trail('shipped').of(SUBJECT)).map((e) => e.id)).to.deep.eq([event(1).id]);
      expect((await audit().trail('shipped').of(SUBJECT, { source: 'other-app' })).map((e) => e.id)).to.deep.eq([event(2).id]);
    });

    it('erases a subject in the archive and in the buffer, and leaves other subjects alone', async () => {
      await store.append({ trail: shipped(), events: [event(1), event(3)] });
      await shipAudit({ trail: 'shipped' });
      await store.append({ trail: shipped(), events: [event(2, { subject: SUBJECT })] }); // still buffered

      expect(await (await reader()).redact(shipped(), SUBJECT)).to.eq(2);
      const listed = await (await reader()).list(shipped(), { order: 'asc', limit: 10 });
      expect(listed.map((e) => [e.id, e.redacted, e.data])).to.deep.eq([
        [event(1).id, true, {}],
        [event(3).id, false, { version: 3 }],
      ]);
      expect((await buffered()).map((r) => r.data)).to.deep.eq(['']);
    });

    it('prunes the archive by date, for every source', async () => {
      await sink.deliver({ trail: 'shipped', source: source().Options.Name, events: [event(1, { at: new Date('2020-01-01T00:00:00Z') }), event(2)] });
      await sink.deliver({ trail: 'shipped', source: 'other-app', events: [event(3, { at: new Date('2020-01-01T00:00:00Z') })] });
      expect(await (await reader()).prune(shipped(), new Date('2021-01-01T00:00:00Z'))).to.eq(2);
      expect((await archived()).map((r) => r.id)).to.deep.eq([event(2).id]);
    });

    it('names the missing configuration and keeps the buffer', async () => {
      setTrail('shipped', withoutArchive());
      await store.append({ trail: shipped(), events: [event(1)] });
      expect(await shipAudit({ trail: 'shipped' })).to.deep.eq({ shipped: 0, failed: [{ trail: 'shipped', connection: source().Options.Name }] });
      expect(await buffered()).to.have.length(1);
      await expect(sink.deliver({ trail: 'shipped', source: 'app', events: [event(1)] })).to.be.rejectedWith(AuditConfigError, `audit: audit.trails.shipped.archiveConnection is not set; name the ORM connection that holds the archive table "${ARCHIVE}"`);
    });

    it('refuses a source name that does not fit and names an archive that is not migrated', async () => {
      await expect(sink.deliver({ trail: 'shipped', source: 's'.repeat(65), events: [event(1)] })).to.be.rejectedWith(AuditConfigError, 'is longer than 64 characters and cannot be archived');
      await new ShippedArchiveMigration().down(archive());
      await expect(sink.deliver({ trail: 'shipped', source: 'app', events: [event(1)] })).to.be.rejectedWith(`audit: archiving trail "shipped" failed; is "${ARCHIVE}" migrated on its archive connection (AuditArchiveTableMigration)?`);
    });
  });
}

describe('audit archive', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open(undefined, { connections: [ARCHIVE_CONNECTION] });
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of TestDb.dialects()) {
    archiveSuite(`${dialect}, archive on the source connection`, dialect, () => db, dialect);
  }
  archiveSuite('sqlite, archive on a dedicated connection', 'sqlite', () => db, 'archive');

  describe('an archive table belongs to its trail', () => {
    class TwinArchive extends AuditArchiveTableMigration {
      protected override table(): string {
        return 'audit_twin';
      }
    }
    const shipping = (archiveConnection: string, table?: string): Record<string, unknown> => ({ store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', archiveConnection, ...(table === undefined ? {} : { table }), retentionDays: 1 });

    afterEach(async () => {
      config().set(['audit', 'trails'], {});
      for (const d of [db.driver('archive'), db.driver('sqlite')]) await new TwinArchive().down(d);
    });

    it('refuses an archive on the table of a table trail, and keeps that trail working', async () => {
      setTrail('shipped', shipping('archive'));
      const refused = 'audit: trails "default" and "shipped" both use table "audit_event" (the archive of "shipped" on connection "archive"); give each trail its own table';
      await expect(DI.resolve(ArchiveAuditSink).deliver({ trail: 'shipped', source: 'app', events: [event(1)] })).to.be.rejectedWith(AuditConfigError, refused);
      await expect(audit().trail('shipped').since(0)).to.be.rejectedWith(AuditConfigError, refused);
      await audit().record({ kind: 'custom', action: 'kept' }, { mode: 'confirmed', onFailure: 'reject' });
    });

    it('refuses a second archive in one table on one connection, and reads an alias of the source connection', async () => {
      config().set(['audit', 'trails'], { a: shipping('archive', 'audit_twin'), b: shipping('archive', 'audit_twin'), c: shipping('sqlite', 'audit_twin') });
      for (const d of [db.driver('archive'), db.driver('sqlite')]) await new TwinArchive().up(d);
      const sink = DI.resolve(ArchiveAuditSink);
      await expect(sink.deliver({ trail: 'b', source: 'app', events: [event(1)] })).to.be.rejectedWith(AuditConfigError, 'audit: trails "a" and "b" both use table "audit_twin" (their archives on connection "archive"); give each trail its own table');
      await sink.deliver({ trail: 'c', source: 'sqlite', events: [event(1, { at: new Date('2020-01-01T00:00:00Z') })] });
      // c names no connection: its trail connection is `default`, an alias of sqlite.
      expect((await audit().trail('c').since(0)).map((e) => e.id)).to.deep.eq([event(1).id]);
      const failed = await pruneAudit().then(
        () => [],
        (err: unknown) => (err instanceof AuditPruneFailed ? err.failed.map((f) => f.trail) : [String(err)]),
      );
      expect(failed).to.deep.eq(['b']);
      expect(await tableRows(db.driver('sqlite'), 'audit_twin')).to.have.length(0);
    });
  });
});
