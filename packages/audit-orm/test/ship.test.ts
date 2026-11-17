import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, AuditEventSink, AuditNotSupported, AuditReader, AuditWriteFailed, audit, trailConfig } from '@spinajs/audit';
import type { AuditBatch, AuditInput, AuditSubject, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';
import { AuditOutboxTableMigration, OutboxAuditStore, auditBacklog, insertRows, shipAudit } from '../src/index.js';
import { AuditShipError, AuditShipTask } from '../src/scheduler.js';
import { TestDb } from '../src/testing.js';
import { TRACE, config, event, setTrail, tableRows } from './support/events.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

class RecordingSink extends AuditEventSink {
  static batches: AuditBatch[] = [];
  static failNext = 0;
  static calls = 0;
  static failOnCall = 0;
  deliver(batch: AuditBatch): Promise<void> {
    RecordingSink.calls += 1;
    if (RecordingSink.failNext > 0 || RecordingSink.calls === RecordingSink.failOnCall) {
      RecordingSink.failNext = Math.max(0, RecordingSink.failNext - 1);
      return Promise.reject(new Error('sink down'));
    }
    RecordingSink.batches.push(batch);
    return Promise.resolve();
  }
}

class DownSink extends AuditEventSink {
  deliver(): Promise<void> {
    return Promise.reject(new Error('always down'));
  }
}

class HangSink extends AuditEventSink {
  deliver(): Promise<void> {
    return new Promise(() => undefined);
  }
}

// Holds a delivery open until the test lets it go.
class GateSink extends AuditEventSink {
  static entered: () => void = () => undefined;
  static release: Promise<void> = Promise.resolve();
  async deliver(batch: AuditBatch): Promise<void> {
    GateSink.entered();
    await GateSink.release;
    RecordingSink.batches.push(batch);
  }
}

// Delivers, then takes the buffer table away, so the delete after the delivery fails.
class DropSink extends AuditEventSink {
  static driver: OrmDriver;
  static saved: Record<string, unknown>[] = [];
  async deliver(batch: AuditBatch): Promise<void> {
    RecordingSink.batches.push(batch);
    DropSink.saved = (await tableRows(DropSink.driver, 'audit_outbox')).map(({ seq: _seq, ...row }) => row);
    await new AuditOutboxTableMigration().down(DropSink.driver);
  }
}

const SINKS = [RecordingSink, DownSink, HangSink, GateSink, DropSink];

class RecordingReader extends AuditReader {
  static redacted: AuditSubject[] = [];
  static failNext = 0;
  list(): Promise<readonly StoredAuditEvent[]> {
    return Promise.resolve([]);
  }
  redact(_trail: TrailConfig, subject: AuditSubject): Promise<number> {
    if (RecordingReader.failNext > 0) {
      RecordingReader.failNext -= 1;
      return Promise.reject(new Error('reader down'));
    }
    RecordingReader.redacted.push(subject);
    return Promise.resolve(3);
  }
  prune(): Promise<number> {
    return Promise.resolve(0);
  }
}

describe('audit shipping', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open();
    SINKS.forEach((sink) => DI.register(sink).as(AuditEventSink));
    DI.register(RecordingReader).as(AuditReader);
  });

  after(async () => {
    SINKS.forEach((sink) => DI.unregister(AuditEventSink, sink));
    DI.unregister(AuditReader, RecordingReader);
    await db?.close();
  });

  for (const dialect of TestDb.dialects()) {
    describe(dialect, () => {
      let store: OutboxAuditStore;
      const driver = () => db.driver(dialect);
      const connection = (): string => db.connectionName(dialect);
      const buffered = () => tableRows(driver(), 'audit_outbox');
      const delivered = (): string[] => RecordingSink.batches.flatMap((b) => b.events.map((e) => e.id));
      const shipped = (): TrailConfig => trailConfig('shipped');

      before(function () {
        if (!db.has(dialect)) this.skip();
      });

      beforeEach(async () => {
        RecordingSink.batches = [];
        RecordingSink.failNext = 0;
        RecordingReader.redacted = [];
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'RecordingSink', connection: connection() });
        config().set(['audit', 'ship'], { batchSize: 2 });
        await new AuditOutboxTableMigration().down(driver());
        await new AuditOutboxTableMigration().up(driver());
        store = DI.resolve(OutboxAuditStore);
      });

      afterEach(async () => {
        setTrail('shipped', undefined);
        setTrail('other', undefined);
        config().set(['audit', 'ship'], undefined);
        await new AuditOutboxTableMigration().down(driver());
      });

      it('buffers on the trail connection, and in the write transaction when one is passed', async () => {
        await store.append({ trail: shipped(), events: [event(1)] });
        await expect(
          driver().transaction(async () => {
            await store.append({ trail: shipped(), events: [event(2)], transaction: driver() });
            throw new Error('caller failed');
          }),
        ).to.be.rejectedWith('caller failed');
        await driver().transaction(() => store.append({ trail: shipped(), events: [event(3)], transaction: driver() }));

        expect((await buffered()).map((r) => [r.trail, r.id, r.kind, r.action, r.subject_type, r.subject_id])).to.deep.eq([
          ['shipped', event(1).id, 'custom', 'contract.signed', 'contract', 'c1'],
          ['shipped', event(3).id, 'custom', 'contract.signed', 'contract', 'c3'],
        ]);
        expect(RecordingSink.batches).to.have.length(0);
      });

      it('a confirmed event inside the caller transaction: kept on a pooled driver, with the caller on sqlite and PGlite', async () => {
        const signed = (id: string): AuditInput => ({ kind: 'custom', action: 'contract.signed', subject: { type: 'contract', id } });
        await expect(
          driver().transaction(async () => {
            await audit().record(signed('c1'), { trail: 'shipped', mode: 'confirmed', onFailure: 'reject' });
            throw new Error('caller failed');
          }),
        ).to.be.rejectedWith('caller failed');
        await driver().transaction(() => audit().record(signed('c2'), { trail: 'shipped', mode: 'confirmed', onFailure: 'reject' }));
        // sqlite and PGlite serve one transaction at a time, so the confirmed write joins the caller's.
        const joined = dialect === 'sqlite' || dialect === 'pglite';
        expect((await buffered()).map((r) => r.subject_id)).to.deep.eq(joined ? ['c2'] : ['c1', 'c2']);
      });

      it('buffers on the connection a write names instead of the trail connection', async () => {
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'RecordingSink', connection: 'elsewhere' });
        await store.append({ trail: shipped(), events: [event(1)], connection: connection() });
        expect((await buffered()).map((r) => r.id)).to.deep.eq([event(1).id]);
        expect(store.joinsTransaction).to.eq(true);
        await expect(store.append({ trail: shipped(), events: [event(2)] })).to.be.rejectedWith(AuditConfigError, 'audit: no ORM connection "elsewhere"');
      });

      it('ships in buffer order, in batches, and empties the buffer', async () => {
        await store.append({ trail: shipped(), events: [event(1), event(2), event(3)] });

        expect(await shipAudit()).to.deep.eq({ shipped: 3, failed: [] });
        expect(RecordingSink.batches.map((b) => [b.trail, b.source, b.events.length])).to.deep.eq([
          ['shipped', connection(), 2],
          ['shipped', connection(), 1],
        ]);
        expect(delivered()).to.deep.eq([event(1).id, event(2).id, event(3).id]);
        const [first] = RecordingSink.batches[0].events;
        expect([first.kind, first.action, first.subject, first.outcome, first.actor, first.traceId, first.data]).to.deep.eq(['custom', 'contract.signed', { type: 'contract', id: 'c1' }, 'ok', 'user:u1', TRACE, { version: 1 }]);
        expect(first.at.getTime()).to.eq(event(1).at.getTime());
        expect(first).to.not.have.property('seq');
        expect(first).to.not.have.property('redacted');
        expect(await buffered()).to.have.length(0);
      });

      it('keeps the rows when the sink fails and redelivers the same events', async () => {
        await store.append({ trail: shipped(), events: [event(1)] });
        RecordingSink.failNext = 1;

        expect(await shipAudit()).to.deep.eq({ shipped: 0, failed: [{ trail: 'shipped', connection: connection() }] });
        expect(await buffered()).to.have.length(1);
        const [lag] = await auditBacklog({ connection: connection() });
        expect([lag.trail, lag.connection, lag.pending, lag.oldestAt?.getTime()]).to.deep.eq(['shipped', connection(), 1, event(1).at.getTime()]);

        expect((await shipAudit()).shipped).to.eq(1);
        expect(delivered()).to.deep.eq([event(1).id]);
        expect((await auditBacklog({ connection: connection() }))[0]).to.deep.include({ pending: 0, oldestAt: null });
      });

      it('stops after maxBatches and continues on the next run', async () => {
        config().set(['audit', 'ship'], { batchSize: 1, maxBatches: 2 });
        await store.append({ trail: shipped(), events: [event(1), event(2), event(3)] });
        expect((await shipAudit()).shipped).to.eq(2);
        expect((await shipAudit()).shipped).to.eq(1);
        expect(delivered()).to.deep.eq([event(1).id, event(2).id, event(3).id]);
      });

      it('ships each trail to its own sink; a failing trail does not hold up another', async () => {
        setTrail('other', { store: 'OutboxAuditStore', sink: 'DownSink', connection: connection() });
        await store.append({ trail: trailConfig('other'), events: [event(1)] });
        await store.append({ trail: shipped(), events: [event(2)] });

        const out = await shipAudit();
        expect(out.shipped).to.eq(1);
        expect(out.failed).to.deep.eq([{ trail: 'other', connection: connection() }]);
        expect(delivered()).to.deep.eq([event(2).id]);
        expect((await buffered()).map((r) => r.trail)).to.deep.eq(['other']);
        expect(await shipAudit({ trail: 'shipped' })).to.deep.eq({ shipped: 0, failed: [] });
      });

      it('reports a shipping trail without a sink and keeps its events', async () => {
        setTrail('shipped', { store: 'OutboxAuditStore', connection: connection() });
        await store.append({ trail: shipped(), events: [event(1)] });
        expect(await shipAudit()).to.deep.eq({ shipped: 0, failed: [{ trail: 'shipped', connection: connection() }] });
        expect(await buffered()).to.have.length(1);
      });

      it('has no reader unless the trail names one', async () => {
        expect(await store.reader(shipped())).to.eq(undefined);
        await expect(audit().trail('shipped').of({ type: 'contract', id: 'c1' })).to.be.rejectedWith(AuditNotSupported, 'audit: trail "shipped" (store OutboxAuditStore) cannot be read from this application (of)');
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'RecordingSink', reader: 'NoSuchReader', connection: connection() });
        await expect(store.reader(shipped())).to.be.rejectedWith(AuditConfigError, 'audit: audit.trails.shipped.reader names "NoSuchReader", but no AuditReader is registered under that name (registered: ');
      });

      it('erases through the named reader and blanks what is still buffered', async () => {
        setTrail('shipped', { store: 'OutboxAuditStore', sink: 'RecordingSink', reader: 'RecordingReader', connection: connection() });
        await store.append({ trail: shipped(), events: [event(1), event(2)] });

        const reader = await store.reader(shipped());
        expect(await reader?.redact(shipped(), { type: 'contract', id: 'c1' })).to.eq(1 + 3);
        expect(RecordingReader.redacted).to.deep.eq([{ type: 'contract', id: 'c1' }]);
        expect((await buffered()).map((r) => r.data)).to.deep.eq(['', '{"version":2}']);

        await shipAudit();
        expect(RecordingSink.batches[0].events.map((e) => e.data)).to.deep.eq([{}, { version: 2 }]);
      });

      it('records through the audit service, confirmed and inside the audited transaction', async () => {
        const signed = (id: string): AuditInput => ({ kind: 'custom', action: 'contract.signed', subject: { type: 'contract', id }, data: { version: 9 } });
        await audit().record(signed('c8'), { trail: 'shipped', mode: 'confirmed' });
        await driver().transaction(() => audit().record(signed('c9'), { trail: 'shipped', mode: 'transactional', transaction: driver() }));
        await expect(
          driver().transaction(async () => {
            await audit().record(signed('c10'), { trail: 'shipped', mode: 'transactional', transaction: driver() });
            throw new Error('caller failed');
          }),
        ).to.be.rejectedWith('caller failed');
        expect((await buffered()).map((r) => [r.trail, r.subject_id])).to.deep.eq([
          ['shipped', 'c8'],
          ['shipped', 'c9'],
        ]);
      });

      it('refuses what cannot be buffered and names the missing table', async () => {
        const longName = 'x'.repeat(65);
        await expect(store.append({ trail: { ...shipped(), name: longName }, events: [event(1)] })).to.be.rejectedWith(AuditConfigError, `audit: trail name "${longName}" is longer than 64 characters and cannot be buffered`);
        await expect(store.append({ trail: shipped(), events: [event(1)], transaction: 'not a driver' })).to.be.rejectedWith(AuditConfigError, 'audit: OutboxAuditStore takes the OrmDriver of the audited write as the transaction of trail "shipped"');
        await expect(store.append({ trail: shipped(), events: [event(1)], transaction: driver() })).to.be.rejectedWith(AuditWriteFailed, `audit: a transactional write to trail "shipped" found no open transaction on connection "${connection()}"`);

        await new AuditOutboxTableMigration().down(driver());
        await expect(store.append({ trail: shipped(), events: [event(1)] })).to.be.rejectedWith(AuditWriteFailed, `audit: buffering 1 event(s) of trail "shipped" in audit_outbox on connection "${connection()}" failed; is the table migrated there (AuditOutboxTableMigration)?`);
      });

      it('the task reports the run and fails it when a delivery failed', async () => {
        await store.append({ trail: shipped(), events: [event(1)] });
        const results: unknown[] = [];
        const ctx = { result: (data: unknown): void => void results.push(data) };

        RecordingSink.failNext = 1;
        await expect(new AuditShipTask().execute(ctx)).to.be.rejectedWith(AuditShipError, `audit: shipping failed for shipped@${connection()}`);
        expect(await new AuditShipTask().execute(ctx)).to.deep.eq({ shipped: 1, failed: [] });
        expect(results).to.deep.eq([
          { shipped: 0, failed: [{ trail: 'shipped', connection: connection() }] },
          { shipped: 1, failed: [] },
        ]);
      });
    });
  }

  describe('failures and erasures, on sqlite', () => {
    const sqlite = () => db.driver('sqlite');
    const trail = (sink: string, extra: Record<string, unknown> = {}): TrailConfig => {
      setTrail('shipped', { store: 'OutboxAuditStore', sink, reader: 'RecordingReader', connection: 'sqlite', ...extra });
      return trailConfig('shipped');
    };
    const store = (): OutboxAuditStore => DI.resolve(OutboxAuditStore);
    const ids = (...n: number[]): string[] => n.map((i) => event(i).id);
    const delivered = (): string[] => RecordingSink.batches.flatMap((b) => b.events.map((e) => e.id));
    const failure = [{ trail: 'shipped', connection: 'sqlite' }];
    const c1 = { type: 'contract', id: 'c1' };

    beforeEach(async () => {
      RecordingSink.batches = [];
      RecordingSink.calls = 0;
      RecordingSink.failOnCall = 0;
      RecordingReader.redacted = [];
      RecordingReader.failNext = 0;
      for (const d of [sqlite(), db.driver('pglite')]) await new AuditOutboxTableMigration().up(d);
    });

    afterEach(async () => {
      setTrail('shipped', undefined);
      config().set(['audit', 'ship'], undefined);
      for (const d of [sqlite(), db.driver('pglite')]) await new AuditOutboxTableMigration().down(d);
    });

    it('keeps the count of what shipped before a delivery failed', async () => {
      config().set(['audit', 'ship'], { batchSize: 1 });
      RecordingSink.failOnCall = 2;
      await store().append({ trail: trail('RecordingSink'), events: [event(1), event(2), event(3)] });
      expect(await shipAudit()).to.deep.eq({ shipped: 1, failed: failure });
    });

    it('gives up on a delivery at its deadline and keeps the events', async () => {
      config().set(['audit', 'ship'], { deliverTimeoutMs: 50 });
      await store().append({ trail: trail('HangSink'), events: [event(1)] });
      expect(await shipAudit()).to.deep.eq({ shipped: 0, failed: failure });
      expect(await tableRows(sqlite(), 'audit_outbox')).to.have.length(1);
    });

    it('redelivers the same events when the delete after a delivery failed', async () => {
      DropSink.driver = sqlite();
      await store().append({ trail: trail('DropSink'), events: [event(1), event(2)] });
      expect(await shipAudit()).to.deep.eq({ shipped: 0, failed: failure });
      await new AuditOutboxTableMigration().up(sqlite());
      await insertRows(sqlite(), 'audit_outbox', DropSink.saved);
      trail('RecordingSink');
      expect((await shipAudit()).shipped).to.eq(2);
      expect(delivered()).to.deep.eq(ids(1, 2, 1, 2));
    });

    it('ships each event at least once when two runs race', async () => {
      config().set(['audit', 'ship'], { batchSize: 1 });
      await store().append({ trail: trail('RecordingSink'), events: [event(1), event(2), event(3)] });
      const runs = await Promise.all([shipAudit(), shipAudit()]);
      expect(runs.flatMap((r) => r.failed)).to.deep.eq([]);
      expect([...new Set(delivered())].sort()).to.deep.eq(ids(1, 2, 3));
      expect(await tableRows(sqlite(), 'audit_outbox')).to.have.length(0);
    });

    it('blanks an erased subject on every buffer, or on the source it names', async () => {
      const shippedTrail = trail('RecordingSink');
      await store().append({ trail: shippedTrail, events: [event(1, { subject: c1 })] });
      await store().append({ trail: shippedTrail, events: [event(2, { subject: c1 })], connection: 'pglite' });
      const reader = await store().reader(shippedTrail);
      const payloads = async (d: OrmDriver): Promise<unknown[]> => (await tableRows(d, 'audit_outbox')).map((r) => r.data);
      expect(await reader?.redact(shippedTrail, c1)).to.eq(2 + 3);
      await store().append({ trail: shippedTrail, events: [event(3, { subject: c1 })], connection: 'pglite' });
      await store().append({ trail: shippedTrail, events: [event(4, { subject: c1 })] });
      expect(await reader?.redact(shippedTrail, c1, 'pglite')).to.eq(1 + 3);
      expect(await payloads(db.driver('pglite'))).to.deep.eq(['', '']);
      expect(await payloads(sqlite())).to.deep.eq(['', '{"version":4}']);
    });

    it('redacts the destination when a subject is erased while its events are delivered', async () => {
      const entered = new Promise<void>((resolve) => (GateSink.entered = resolve));
      let release = (): void => undefined;
      GateSink.release = new Promise<void>((resolve) => (release = resolve));
      const gated = trail('GateSink');
      await store().append({ trail: gated, events: [event(1)] });

      const run = shipAudit();
      await entered;
      await (await store().reader(gated))?.redact(gated, { type: 'contract', id: 'c1' });
      release();
      expect(await run).to.deep.eq({ shipped: 1, failed: [] });
      expect(RecordingReader.redacted).to.deep.eq([
        { type: 'contract', id: 'c1' },
        { type: 'contract', id: 'c1' },
      ]);
      expect(await tableRows(sqlite(), 'audit_outbox')).to.have.length(0);
    });

    it('redacts the destination when an abandoned delivery lands after the erasure', async () => {
      config().set(['audit', 'ship'], { deliverTimeoutMs: 50 });
      const entered = new Promise<void>((resolve) => (GateSink.entered = resolve));
      let release = (): void => undefined;
      GateSink.release = new Promise<void>((resolve) => (release = resolve));
      const gated = trail('GateSink');
      await store().append({ trail: gated, events: [event(1)] });

      expect(await shipAudit()).to.deep.eq({ shipped: 0, failed: failure });
      await entered;
      await (await store().reader(gated))?.redact(gated, c1);
      release();
      await GateSink.release;
      expect(RecordingSink.batches.map((b) => b.events[0].data)).to.deep.eq([{ version: 1 }]);

      expect(await shipAudit()).to.deep.eq({ shipped: 1, failed: [] });
      expect(RecordingReader.redacted).to.deep.eq([c1, c1]);
      expect(await tableRows(sqlite(), 'audit_outbox')).to.have.length(0);
    });

    it('keeps erased events buffered until the destination was redacted', async () => {
      const shippedTrail = trail('RecordingSink');
      await store().append({ trail: shippedTrail, events: [event(1), event(2)] });
      await (await store().reader(shippedTrail))?.redact(shippedTrail, c1);
      RecordingReader.failNext = 1;

      expect(await shipAudit()).to.deep.eq({ shipped: 1, failed: failure });
      expect((await tableRows(sqlite(), 'audit_outbox')).map((r) => r.id)).to.deep.eq(ids(1));
      expect(await shipAudit()).to.deep.eq({ shipped: 1, failed: [] });
      expect(RecordingReader.redacted).to.deep.eq([c1, c1]);
      expect(await tableRows(sqlite(), 'audit_outbox')).to.have.length(0);
    });
  });

  it('does nothing without a shipping trail', async () => {
    expect(await shipAudit()).to.deep.eq({ shipped: 0, failed: [] });
    expect(await auditBacklog()).to.deep.eq([]);
  });
});

describe('audit shipping with a connection that cannot answer', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ trails: { shipped: { store: 'OutboxAuditStore', sink: 'RecordingSink', connection: 'sqlite' } } }, { connections: [{ Driver: 'orm-driver-sqlite', Name: 'gone', Filename: ':memory:' }] });
    DI.register(RecordingSink).as(AuditEventSink);
    await new AuditOutboxTableMigration().up(db.driver('sqlite'));
    await db.driver('gone').disconnect();
  });

  after(async () => {
    DI.unregister(AuditEventSink, RecordingSink);
    await db?.close();
  });

  it('ships the other connections, and reports it in the run and in the backlog', async () => {
    await DI.resolve(OutboxAuditStore).append({ trail: trailConfig('shipped'), events: [event(1)] });
    expect(await shipAudit()).to.deep.eq({ shipped: 1, failed: [{ trail: 'shipped', connection: 'gone' }] });
    const backlog = await auditBacklog();
    expect(backlog.map((b) => [b.connection, b.pending])).to.deep.eq([
      ['gone', null],
      ['sqlite', 0],
    ]);
  });
});
