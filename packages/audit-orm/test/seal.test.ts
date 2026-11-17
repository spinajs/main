import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, eventDigest, payloadHash, sealHash, trailConfig } from '@spinajs/audit';
import type { AuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { instantFromDb } from '@spinajs/orm';
import { AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, AuditSealer, OutboxAuditStore, TableAuditStore, insertRows, sealAudit, shipAudit, storedColumns } from '../src/index.js';
import { AuditSealError, AuditSealTask } from '../src/scheduler.js';
import { bufferRows } from '../src/ship/outbox.js';
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

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('audit sealing', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of TestDb.dialects()) {
    describe(dialect, () => {
      const driver = () => db.driver(dialect);
      const connection = (): string => db.connectionName(dialect);
      const sealedTrail = (): TrailConfig => trailConfig('sealed');
      const append = async (...events: AuditEvent[]): Promise<void> => DI.resolve(TableAuditStore).append({ trail: sealedTrail(), events });
      const seals = () => tableRows(driver(), 'audit_seal', 'id');
      const ranges = async (): Promise<unknown[][]> => (await seals()).map((s) => [s.trail_table, Number(s.from_seq), Number(s.to_seq), Number(s.event_count)]);
      const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);
      const at = (ms: number) => ({ settleMs: 30000, now: new Date(t0 + ms) });

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
        for (const name of ['sealed', 'plain', 'shipped']) setTrail(name, undefined);
        config().set(['audit', 'seal'], undefined);
        await db.drop(dialect, TABLE);
        await new AuditSealTableMigration().down(driver());
      });

      it('seals events in seq order, each seal chained to the one before', async () => {
        await append(event(1), event(2));
        expect(await sealAudit({ settleMs: 0 })).to.deep.eq({ sealed: 2, failed: [] });
        await append(event(3));
        expect((await sealAudit({ settleMs: 0 })).sealed).to.eq(1);
        expect(await sealAudit({ settleMs: 0 })).to.deep.eq({ sealed: 0, failed: [] });

        expect(await ranges()).to.deep.eq([
          [TABLE, 1, 2, 2],
          [TABLE, 3, 3, 1],
        ]);
        const [first, second] = await seals();
        expect(first.previous_hash).to.eq(null);
        expect(second.previous_hash).to.eq(first.hash);
      });

      it('stores the hash every dialect computes alike', async () => {
        await append(event(1), event(2));
        await sealAudit({ settleMs: 0, now: new Date('2026-11-16T12:00:00.250Z') });
        // Sealed at the whole second, which every dialect stores and reads back alike.
        const sealedAt = new Date('2026-11-16T12:00:00.000Z');
        const expected = sealHash(
          null,
          sealedAt,
          [event(1), event(2)].map((e) => eventDigest(e, payloadHash(e.data))),
        );
        const [seal] = await seals();
        expect([seal.hash, instantFromDb(seal.sealed_at)?.toMillis()]).to.deep.eq([expected, sealedAt.getTime()]);
        expect((await tableRows(driver(), TABLE)).map((r) => r.data_hash)).to.deep.eq([payloadHash(event(1).data), payloadHash(event(2).data)]);
      });

      it('cuts a long run into seals of audit.seal.batchSize events', async () => {
        config().set(['audit', 'seal'], { batchSize: 2 });
        await append(event(1), event(2), event(3), event(4), event(5));
        expect((await sealAudit({ settleMs: 0 })).sealed).to.eq(5);
        expect((await ranges()).map((r) => r.slice(1))).to.deep.eq([
          [1, 2, 2],
          [3, 4, 2],
          [5, 5, 1],
        ]);
        expect(() => config().set(['audit', 'seal'], { batchSise: 2 })).to.throw(/^Invalid configuration: .*spinajs\/audit-seal\.configuration\.schema\.json/);
      });

      it('adds at most audit.seal.maxSeals seals to a table per run', async () => {
        config().set(['audit', 'seal'], { batchSize: 2, maxSeals: 2 });
        await append(event(1), event(2), event(3), event(4), event(5));
        expect((await sealAudit({ settleMs: 0 })).sealed).to.eq(4);
        expect((await sealAudit({ settleMs: 0 })).sealed).to.eq(1);
      });

      it('reports a seq that went back below the end of the seal chain', async () => {
        await append(event(1), event(2));
        await sealAudit({ settleMs: 0 });
        await db.migrate(dialect, TABLE);
        await append(event(3));
        expect(await sealAudit({ settleMs: 0 })).to.deep.eq({
          sealed: 0,
          failed: [{ trail: 'sealed', connection: connection(), reason: `audit: the highest seq of "${TABLE}" on connection "${connection()}" is 1, at or below the end of its seal chain (2): the seq was reset, and rows up to seq 2 are never sealed` }],
        });
      });

      it('seals only what was already there one settle time ago', async () => {
        const sealer = new AuditSealer();
        await append(event(1));
        expect((await sealer.run(at(0))).sealed).to.eq(0);
        await append(event(2));
        expect((await sealer.run(at(10000))).sealed).to.eq(0);
        expect((await sealer.run(at(30000))).sealed).to.eq(1);
        expect(await ranges()).to.deep.eq([[TABLE, 1, 1, 1]]);
        expect((await sealer.run(at(60000))).sealed).to.eq(1);
        expect(await ranges()).to.deep.eq([
          [TABLE, 1, 1, 1],
          [TABLE, 2, 2, 1],
        ]);
      });

      if (dialect === 'postgres' || dialect === 'mysql') {
        const held = async (e: AuditEvent, release: Promise<void>): Promise<() => Promise<void>> => {
          let inserted!: () => void;
          const ready = new Promise<void>((resolve) => (inserted = resolve));
          const caller = driver().transaction(async () => {
            await insertRows(driver(), TABLE, [storedColumns(e)]);
            inserted();
            await release;
          });
          await ready;
          return () => caller;
        };

        it('seals a lower seq that commits late within the settle time, and leaves out one that commits later', async () => {
          const sealer = new AuditSealer();
          let commit!: () => void;
          const first = await held(event(1), new Promise((resolve) => (commit = resolve)));
          await append(event(2));
          expect((await sealer.run(at(0))).sealed).to.eq(0);
          commit();
          await first();
          expect((await sealer.run(at(30000))).sealed).to.eq(2);

          let late!: () => void;
          const third = await held(event(3), new Promise((resolve) => (late = resolve)));
          await append(event(4));
          expect((await sealer.run(at(60000))).sealed).to.eq(0);
          expect((await sealer.run(at(90000))).sealed).to.eq(1);
          late();
          await third();
          expect((await sealer.run(at(120000))).sealed).to.eq(0);
          // seq 3 committed after its range was sealed: the range starts where the previous one ended, so its count no longer matches.
          expect(await ranges()).to.deep.eq([
            [TABLE, 1, 2, 2],
            [TABLE, 3, 4, 1],
          ]);
          expect((await tableRows(driver(), TABLE)).map((r) => Number(r.seq))).to.deep.eq([1, 2, 3, 4]);
        });

        it('refuses a second seal chained from the same seal, whatever rows each sealer saw', async () => {
          await append(event(1), event(2));
          await sealAudit({ settleMs: 0 });
          let commit!: () => void;
          const third = await held(event(3), new Promise((resolve) => (commit = resolve)));
          await append(event(4));

          // The first sealer inserts its seal and waits before committing; seq 3 commits, then a second sealer runs.
          let inserted!: () => void;
          const insertedSeal = new Promise<void>((resolve) => (inserted = resolve));
          let release!: () => void;
          const released = new Promise<void>((resolve) => (release = resolve));
          // An own property shadows the prototype's transaction() for one call, then is removed again.
          const transaction = Reflect.get(driver(), 'transaction');
          Reflect.set(driver(), 'transaction', (work: () => Promise<unknown>): unknown => {
            Reflect.deleteProperty(driver(), 'transaction');
            return Reflect.apply(transaction, driver(), [
              async () => {
                const out = await work();
                inserted();
                await released;
                return out;
              },
            ]);
          });
          const first = new AuditSealer().run({ settleMs: 0 });
          await insertedSeal;
          commit();
          await third();
          const second = new AuditSealer().run({ settleMs: 0 });
          await pause(300);
          release();

          expect(await first).to.deep.eq({ sealed: 1, failed: [] });
          expect((await second).failed).to.deep.eq([{ trail: 'sealed', connection: connection(), reason: `audit: another sealer sealed "${TABLE}" on connection "${connection()}" from seq 3 at the same time; run one sealer (AuditSealTask runs on the leader)` }]);
          expect(await ranges()).to.deep.eq([
            [TABLE, 1, 2, 2],
            [TABLE, 3, 4, 1],
          ]);
        });
      } else {
        it('never seals a row of a transaction that is still open, and one that rolls back not at all', async () => {
          let rollback!: () => void;
          const release = new Promise<void>((resolve) => (rollback = resolve));
          const caller = driver().transaction(async () => {
            await append(event(1));
            await release;
            throw new Error('caller failed');
          });
          await pause(50);
          const run = sealAudit({ settleMs: 0 });
          await pause(200);
          rollback();
          await expect(caller).to.be.rejectedWith('caller failed');
          expect(await run).to.deep.eq({ sealed: 0, failed: [] });
          await append(event(2));
          expect(await sealAudit({ settleMs: 0 })).to.deep.eq({ sealed: 1, failed: [] });
          const reason = `audit: sealing "${TABLE}" on connection "${connection()}" needs a transaction of its own; run it outside an open transaction`;
          await expect(driver().transaction(() => sealAudit({ settleMs: 0 }))).to.eventually.deep.eq({ sealed: 0, failed: [{ trail: 'sealed', connection: connection(), reason }] });
        });
      }

      it('leaves a trail that is not sealed alone', async () => {
        setTrail('plain', { store: 'TableAuditStore', table: 'audit_plain', connection: connection() });
        await db.migrate(dialect, 'audit_plain');
        try {
          await DI.resolve(TableAuditStore).append({ trail: trailConfig('plain'), events: [event(1)] });
          expect(await sealAudit({ settleMs: 0 })).to.deep.eq({ sealed: 0, failed: [] });
          expect(await seals()).to.have.length(0);
        } finally {
          await db.drop(dialect, 'audit_plain');
        }
      });

      it('seals a shipping trail at its archive, never at the buffer', async () => {
        setTrail('sealed', undefined);
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: connection(), archiveConnection: connection(), integrity: 'sealed' });
        await new AuditOutboxTableMigration().down(driver());
        await new ShippedArchiveMigration().down(driver());
        await new AuditOutboxTableMigration().up(driver());
        await new ShippedArchiveMigration().up(driver());
        try {
          await DI.resolve(OutboxAuditStore).append({ trail: trailConfig('shipped'), events: [event(1), event(2)] });
          expect((await sealAudit({ settleMs: 0 })).sealed).to.eq(0);
          await shipAudit({ trail: 'shipped' });
          expect((await sealAudit({ settleMs: 0 })).sealed).to.eq(2);
          expect(await ranges()).to.deep.eq([[ARCHIVE, 1, 2, 2]]);
          // The source an archive files the events under is sealed too.
          const filed = [event(1), event(2)].map((e) => eventDigest({ ...e, source: connection() }, payloadHash(e.data)));
          const [seal] = await seals();
          expect(seal.hash).to.eq(sealHash(null, instantFromDb(seal.sealed_at)?.toJSDate() ?? new Date(Number.NaN), filed));
        } finally {
          await new AuditOutboxTableMigration().down(driver());
          await new ShippedArchiveMigration().down(driver());
        }
      });

      it('retention removes whole sealed ranges and keeps their seals', async () => {
        await append(event(1), event(2));
        await sealAudit({ settleMs: 0, now: new Date('2020-06-01T00:00:00Z') });
        await append(event(3));
        await sealAudit({ settleMs: 0, now: new Date('2026-11-16T12:00:00Z') });
        await append(event(4, { at: new Date('2019-01-01T00:00:00Z') })); // old, but not sealed yet

        const reader = await DI.resolve(TableAuditStore).reader(sealedTrail());
        expect(await reader?.prune(sealedTrail(), new Date('2021-01-01T00:00:00Z'))).to.eq(2);
        expect((await tableRows(driver(), TABLE)).map((r) => r.id)).to.deep.eq([event(3).id, event(4).id]);
        expect((await seals()).map((s) => s.pruned_at !== null && s.pruned_at !== undefined)).to.deep.eq([true, false]);
        expect(await reader?.prune(sealedTrail(), new Date('2021-01-01T00:00:00Z'))).to.eq(0);
      });

      it('retention prunes nothing where the seal table is missing', async () => {
        await append(event(1, { at: new Date('2019-01-01T00:00:00Z') }));
        await new AuditSealTableMigration().down(driver());
        const reader = await DI.resolve(TableAuditStore).reader(sealedTrail());
        await expect(reader?.prune(sealedTrail(), new Date('2021-01-01T00:00:00Z'))).to.be.rejectedWith(/audit_seal/);
        expect(await tableRows(driver(), TABLE)).to.have.length(1);
      });

      it('reports the trail whose seal table is missing', async () => {
        await new AuditSealTableMigration().down(driver());
        await append(event(1));
        const { sealed, failed } = await sealAudit({ settleMs: 0 });
        expect([sealed, failed.map((f) => [f.trail, f.connection])]).to.deep.eq([0, [['sealed', connection()]]]);
        expect(failed[0].reason).to.match(/audit_seal/);
      });

      it('the task reports the run and fails it when a table could not be sealed', async () => {
        config().set(['audit', 'seal'], { settleSeconds: 0 });
        await append(event(1));
        const results: unknown[] = [];
        const ctx = { result: (data: unknown): void => void results.push(data) };
        expect(await new AuditSealTask().execute(ctx)).to.deep.eq({ sealed: 1, failed: [] });

        await new AuditSealTableMigration().down(driver());
        await expect(new AuditSealTask().execute(ctx)).to.be.rejectedWith(AuditSealError, `audit: sealing failed for sealed@${connection()}`);
        expect(results).to.have.length(2);
      });
    });
  }

  it('writes a data_hash on every row it stores, so a redacted row still verifies', () => {
    for (const data of [{}, { version: 1 }, { nested: { list: [1, null, 'x'] } }]) {
      expect([storedColumns(event(1, { data })), bufferRows('t', [event(1, { data })])[0]].map((row) => row.data_hash)).to.deep.eq([payloadHash(data), payloadHash(data)]);
    }
  });

  it('refuses a trail whose table is the seal table, and reports a sealed trail whose store keeps no table', async () => {
    setTrail('sealed', { store: 'TableAuditStore', table: 'audit_seal', connection: 'sqlite', integrity: 'sealed' });
    setTrail('logged', { store: 'LogAuditStore', table: 'audit_event', connection: 'sqlite', integrity: 'sealed' });
    setTrail('remote', { store: 'OutboxAuditStore', sink: 'QueueAuditSink', connection: 'sqlite', integrity: 'sealed' });
    try {
      await expect(DI.resolve(TableAuditStore).append({ trail: trailConfig('sealed'), events: [event(1)] })).to.be.rejectedWith(AuditConfigError, 'audit: trail "sealed" uses table "audit_seal", which is the seal table; give the trail its own table');
      expect(await sealAudit({ settleMs: 0, trail: 'logged' })).to.deep.eq({ sealed: 0, failed: [{ trail: 'logged', connection: 'sqlite', reason: 'audit: trail "logged" is sealed, but its store LogAuditStore keeps no table to seal' }] });
      // Its archive is sealed by the service that holds it.
      expect(await sealAudit({ settleMs: 0, trail: 'remote' })).to.deep.eq({ sealed: 0, failed: [] });
    } finally {
      for (const name of ['sealed', 'logged', 'remote']) setTrail(name, undefined);
    }
  });
});
