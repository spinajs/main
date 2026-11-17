import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditConfigError, audit, trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { DI } from '@spinajs/di';
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
    await expect(archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote' }))).to.be.rejectedWith('audit: malformed AuditBatchRecorded message');
    await expect(archiveAuditBatch(new AuditBatchRecorded({ Trail: 'remote', Source: 'app', Events: [wire(event(2)), { ...wire(event(3)), at: 'yesterday' }] }))).to.be.rejectedWith('audit: malformed AuditBatchRecorded message');
    expect(await archived()).to.have.length(1);
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
