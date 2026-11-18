import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AUDIT_WIDTHS, AuditConfigError, audit, trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { FrameworkLogger } from '@spinajs/log';
import { QueueService } from '@spinajs/queue';
import '@spinajs/queue/testing';
import { AuditArchiveTableMigration, AuditOutboxTableMigration, OutboxAuditStore, shipAudit } from '../src/index.js';
import { AuditBatchRecorded, QueueAuditSink, archiveAuditBatch, consumeAuditBatches } from '../src/queue/index.js';
import type { WireAuditEvent } from '../src/queue/index.js';
import { TestDb } from '../src/testing.js';
import { config, event, setTrail, tableRows } from './support/events.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const ARCHIVE = 'audit_remote';

class RemoteArchiveMigration extends AuditArchiveTableMigration {
  protected override table(): string {
    return ARCHIVE;
  }
}

const wire = (e: AuditEvent): WireAuditEvent => ({ ...e, at: e.at.toISOString() });

// The audit warn lines written while `run` runs, as [fields, message].
async function auditWarnings(run: () => Promise<void>): Promise<unknown[][]> {
  const lines: unknown[][] = [];
  const own = Object.getOwnPropertyDescriptor(FrameworkLogger.prototype, 'warn');
  Object.defineProperty(FrameworkLogger.prototype, 'warn', { value: (...args: unknown[]) => void lines.push(args), configurable: true, writable: true });
  try {
    await run();
  } finally {
    if (own) Object.defineProperty(FrameworkLogger.prototype, 'warn', own);
  }
  return lines.filter(([, message]) => typeof message === 'string' && message.startsWith('audit:'));
}

describe('audit queue sink', function () {
  this.timeout(60000);
  let db: TestDb;
  let queueBefore: unknown;
  const driver = () => db.driver('sqlite');
  const sink = (): QueueAuditSink => DI.resolve(QueueAuditSink);
  const archived = () => tableRows(driver(), ARCHIVE);
  const padded = (n: number, size: number): AuditEvent => event(n, { data: { pad: 'x'.repeat(size) } });

  before(async () => {
    db = await TestDb.open();
    queueBefore = config().get<unknown>('queue');
    config().set('queue', {
      default: 'memory',
      connections: [
        { name: 'memory', service: 'MemoryQueueClient', defaultQueueChannel: '/queue/audit', defaultTopicChannel: '/topic/audit' },
        { name: 'black-hole', service: 'BlackHoleQueueClient' },
      ],
    });
    await consumeAuditBatches();
  });

  after(async () => {
    await (await DI.resolve(QueueService)).dispose();
    DI.uncache(QueueService);
    config().set('queue', queueBefore);
    await db?.close();
  });

  beforeEach(async () => {
    setTrail('remote', { store: 'OutboxAuditStore', sink: 'QueueAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: db.connectionName('sqlite'), archiveConnection: db.connectionName('sqlite') });
    await new AuditOutboxTableMigration().down(driver());
    await new RemoteArchiveMigration().down(driver());
    await new AuditOutboxTableMigration().up(driver());
    await new RemoteArchiveMigration().up(driver());
  });

  afterEach(async () => {
    setTrail('remote', undefined);
    config().set(['audit', 'queue'], undefined);
    await new AuditOutboxTableMigration().down(driver());
    await new RemoteArchiveMigration().down(driver());
  });

  it('emits one message per batch and the consumer archives it', async () => {
    await sink().deliver({ trail: 'remote', source: 'app', events: [event(1), event(2)] });

    expect((await archived()).map((r) => [r.source, r.id])).to.deep.eq([
      ['app', event(1).id],
      ['app', event(2).id],
    ]);
    const [first] = await audit().trail('remote').of({ type: 'contract', id: 'c1' }, { source: 'app' });
    expect([first.at.getTime(), first.data]).to.deep.eq([event(1).at.getTime(), { version: 1 }]);
  });

  it('splits a batch so no message exceeds maxMessageBytes, keeping the order', async () => {
    config().set(['audit', 'queue'], { maxMessageBytes: 4096 });
    const sizes: number[] = [];
    const probe = (message: AuditBatchRecorded): Promise<void> => {
      sizes.push(message.Events.length);
      return Promise.resolve();
    };
    await (await DI.resolve(QueueService)).consume(AuditBatchRecorded, probe, 'probe');

    await sink().deliver({ trail: 'remote', source: 'app', events: [padded(1, 1400), padded(2, 1400), padded(3, 1400)] });
    expect(sizes).to.deep.eq([2, 1]);
    expect((await archived()).map((r) => r.id)).to.deep.eq([event(1).id, event(2).id, event(3).id]);
  });

  it('refuses an event that cannot fit a message, before it sends anything', async () => {
    config().set(['audit', 'queue'], { maxMessageBytes: 1024 });
    await expect(sink().deliver({ trail: 'remote', source: 'app', events: [event(1), padded(2, 5000)] })).to.be.rejectedWith(/audit: event 00000000-0000-4000-8000-000000000002 of trail "remote" is \d+ bytes, over audit\.queue\.maxMessageBytes \(1024\)/);
    expect(await archived()).to.have.length(0);
    expect(() => config().set(['audit', 'queue'], { maxMessageBytes: 1023 })).to.throw();
  });

  it('refuses the black-hole connection', async () => {
    config().set(['queue', 'routing'], { AuditBatchRecorded: { connection: 'black-hole' } });
    try {
      await expect(sink().deliver({ trail: 'remote', source: 'app', events: [event(1)] })).to.be.rejectedWith(AuditConfigError, 'audit: AuditBatchRecorded is routed to the black-hole queue connection "black-hole"; set queue.routing.AuditBatchRecorded to a real connection before shipping audit events');
    } finally {
      config().set(['queue', 'routing'], undefined);
    }
  });

  it('archives a redelivered message once and refuses a message that is not a batch', async () => {
    const message = new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: [wire(event(1))] });
    await archiveAuditBatch(message);
    await archiveAuditBatch(message);
    expect(await archived()).to.have.length(1);
    await expect(archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote' }))).to.be.rejectedWith('audit: malformed AuditBatchRecorded message: Source is not a string');
    await expect(archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: [wire(event(2)), { ...wire(event(3)), at: 'yesterday' }] }))).to.be.rejectedWith(`audit: malformed AuditBatchRecorded message: event ${event(3).id}: at is not the toISOString() text of an instant`);
    await expect(archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: [wire(event(2)), 'event'] }))).to.be.rejectedWith('audit: malformed AuditBatchRecorded message: event #1: not an object');
    expect(await archived()).to.have.length(1);
  });

  it('refuses an event it cannot store alike on every dialect, naming the event and the field', async () => {
    const malformed = async (e: Record<string, unknown>, problem: string): Promise<void> => {
      await expect(archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: [e] }))).to.be.rejectedWith(`audit: malformed AuditBatchRecorded message: event ${event(1).id}: ${problem}`);
    };
    const notIso = 'at is not the toISOString() text of an instant';
    await malformed({ ...wire(event(1)), at: '2026-11-16 10:00:01' }, notIso);
    await malformed({ ...wire(event(1)), at: '2026-11-16T10:00:01Z' }, notIso);
    await malformed({ ...wire(event(1)), at: new Date(Date.now() + 6 * 60000).toISOString() }, "at is more than 5 minutes ahead of this service's clock");
    await malformed({ ...wire(event(1)), actor: 'u'.repeat(AUDIT_WIDTHS.actor + 1) }, `actor is not a string of at most ${AUDIT_WIDTHS.actor} characters`);
    await malformed({ ...wire(event(1)), subject: { type: 'contract', id: 'c'.repeat(AUDIT_WIDTHS.subject_id + 1) } }, `subject is not a type of at most ${AUDIT_WIDTHS.subject_type} and an id of at most ${AUDIT_WIDTHS.subject_id} characters`);
    await malformed({ ...wire(event(1)), traceId: 42 }, `traceId is not a string of at most ${AUDIT_WIDTHS.trace_id} characters`);
    await malformed({ ...wire(event(1)), tenant: null }, `tenant is not a string of at most ${AUDIT_WIDTHS.tenant} characters`);
    await malformed({ ...wire(event(1)), kind: 'audit' }, 'kind is not one of data, read, action, security, custom');
    expect(await archived()).to.have.length(0);
    await archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: [{ ...wire(event(1)), at: new Date(Date.now() + 60000).toISOString(), actor: 'u'.repeat(AUDIT_WIDTHS.actor) }] }));
    expect(await archived()).to.have.length(1);
  });

  describe('erasure on arrival', () => {
    const c1 = { type: 'contract', id: 'c1' };
    const data = async (id: string): Promise<unknown> => (await archived()).find((r) => r.id === id)?.data;
    const arrive = (...events: AuditEvent[]): Promise<void> => archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: events.map(wire) }));

    it('blanks only the arriving events an archived erasure covers, with one select per batch and source', async () => {
      await arrive(event(1));
      await audit().trail('remote').forget(c1);
      await shipAudit({ trail: 'remote' });
      const erasure = (await archived()).find((r) => r.action === 'erasure');
      expect(erasure?.subject_id).to.eq('c1');

      // The newer event arrives first: the late older one must not take its payload with it.
      const after = event(8, { subject: c1, at: new Date(Date.now() + 60000) });
      await arrive(after);
      const late = event(7, { subject: c1 });
      const other = event(9);
      const select = Reflect.get(driver(), 'select');
      let selects = 0;
      Reflect.set(driver(), 'select', (...args: unknown[]): unknown => {
        selects += 1;
        const builder: unknown = Reflect.apply(select, driver(), args);
        return builder;
      });
      try {
        await arrive(late, other);
      } finally {
        Reflect.deleteProperty(driver(), 'select');
      }
      // The sink's dedup select, the erasure lookup in the archive and the one in this service's buffer.
      expect(selects).to.eq(3);
      expect([await data(late.id), await data(other.id), await data(after.id), await data(String(erasure?.id))]).to.deep.eq(['', '{"version":9}', '{"version":8}', '{"redacted":1}']);
    });

    it('blanks an event of another kind named erasure, buffered or archived: only custom/erasure is an erasure record', async () => {
      const named = (n: number): AuditEvent => event(n, { kind: 'action', action: 'erasure', subject: c1, data: { email: 'a@example.com' } });
      await arrive(named(1));
      await audit().record({ kind: 'action', action: 'erasure', subject: c1, data: { email: 'b@example.com' } }, { trail: 'remote', mode: 'confirmed' });

      await audit().trail('remote').forget(c1);
      expect(await data(named(1).id)).to.eq('');
      expect((await tableRows(driver(), 'audit_outbox')).map((r) => [r.kind, r.data])).to.deep.eq([
        ['action', ''],
        ['custom', '{"redacted":2}'],
      ]);
    });

    it('never blanks an earlier erasure record, buffered or archived, when the subject is forgotten again', async () => {
      await arrive(event(1, { subject: c1 }));
      await audit().trail('remote').forget(c1);
      await audit().trail('remote').forget(c1);
      expect((await tableRows(driver(), 'audit_outbox')).map((r) => r.data)).to.deep.eq(['{"redacted":1}', '{"redacted":0}']);

      await shipAudit({ trail: 'remote' });
      await audit().trail('remote').forget(c1);
      expect((await archived()).filter((r) => r.action === 'erasure').map((r) => r.data)).to.deep.eq(['{"redacted":1}', '{"redacted":0}']);
    });

    it("forgets a subject of one shipping application by its connection name, recording the erasure on the trail's connection", async () => {
      await arrive(event(1, { subject: c1 }), event(2));
      await archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'other', Events: [wire(event(3, { subject: c1 }))] }));

      // The archive holds events of app: a known application, nothing to warn about.
      const warnings = await auditWarnings(async () => {
        expect(await audit().trail('remote').forget(c1, 'app')).to.eq(1);
      });
      expect(warnings).to.deep.eq([]);
      expect([await data(event(1).id), await data(event(2).id), await data(event(3).id)]).to.deep.eq(['', '{"version":2}', '{"version":3}']);

      // Buffered on the trail's connection, where the consumer looks for pending erasures.
      await arrive(event(7, { subject: c1 }));
      expect(await data(event(7).id)).to.eq('');
      await shipAudit({ trail: 'remote' });
      const erasure = (await archived()).find((r) => r.action === 'erasure');
      expect([erasure?.source, erasure?.data]).to.deep.eq([db.connectionName('sqlite'), '{"redacted":1}']);
    });

    it('warns when the source names neither a connection here nor anything the archive holds', async () => {
      await arrive(event(1, { subject: c1 }));
      const warnings = await auditWarnings(async () => {
        expect(await audit().trail('remote').forget(c1, 'ap')).to.eq(0);
      });
      expect(warnings).to.deep.eq([[{ trail: 'remote', source: 'ap' }, 'audit: forget on trail ${trail} names source ${source}, which is neither a connection of this application nor a source the destination holds events of; nothing was erased under it']]);
      expect(await data(event(1).id)).to.eq('{"version":1}');
    });

    it('blanks what arrives of a subject whose erasure this service has not shipped yet', async () => {
      await audit().trail('remote').forget(c1);
      expect(await archived()).to.have.length(0);

      await arrive(event(7, { subject: c1 }));
      expect(await data(event(7).id)).to.eq('');
    });

    it('an arriving erasure blanks what came before it in every source, never an erasure record or a later event', async () => {
      const erasure = (n: number, at: Date): AuditEvent => event(n, { action: 'erasure', subject: c1, at, data: { redacted: 0 } });
      await arrive(event(1), event(2, { subject: c1 }), erasure(3, new Date(Date.UTC(2026, 10, 16, 9))));
      await archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'other', Events: [wire(event(4, { subject: c1 }))] }));
      await arrive(event(30, { subject: c1, at: new Date(Date.UTC(2026, 10, 16, 11)) }));

      await arrive(erasure(20, new Date(Date.UTC(2026, 10, 16, 10, 30))));
      expect(await Promise.all([1, 2, 4, 30, 3, 20].map((n) => data(event(n).id)))).to.deep.eq(['', '', '', '{"version":30}', '{"redacted":0}', '{"redacted":0}']);
    });
  });

  it('archives a batch published as a plain message through QueueEvent.emit()', async () => {
    await AuditBatchRecorded.emit({ Trail: 'remote', Source: 'app', Events: [wire(event(1)), wire(event(2))] });
    await AuditBatchRecorded.emit({ Trail: 'remote', Source: 'app', Events: [wire(event(2))] });
    expect((await archived()).map((r) => r.id)).to.deep.eq([event(1).id, event(2).id]);
  });

  it('ships a trail through the broker into the archive of the receiving service', async () => {
    await DI.resolve(OutboxAuditStore).append({ trail: trailConfig('remote'), events: [event(1)] });

    expect(await shipAudit({ trail: 'remote' })).to.deep.eq({ shipped: 1, failed: [] });
    expect((await archived()).map((r) => [r.source, r.id])).to.deep.eq([[db.connectionName('sqlite'), event(1).id]]);
    expect((await audit().trail('remote').of({ type: 'contract', id: 'c1' })).map((e) => e.id)).to.deep.eq([event(1).id]);
    expect(await tableRows(driver(), 'audit_outbox')).to.have.length(0);
  });
});
