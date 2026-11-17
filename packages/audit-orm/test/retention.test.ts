import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { AuditReader, AuditStore, audit } from '@spinajs/audit';
import type { StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import { AuditPruneFailed, pruneAudit } from '../src/index.js';
import { AUDIT_RETENTION_SCHEDULE, AuditRetentionTask } from '../src/scheduler.js';
import { TestDb } from '../src/testing.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-16T00:00:00.000Z');
type Line = { level: string; fields: Record<string, unknown>; message: string };

// Answers every Log resolved from now on and records its lines.
function captureLog(): Line[] {
  const lines: Line[] = [];
  const logger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map((level) => [level, (fields: Record<string, unknown>, message: string) => lines.push({ level, fields, message })]));
  DI.register(() => logger).as(Log);
  return lines;
}

const ago = (days: number, from: Date = NOW): Date => new Date(from.getTime() - days * DAY);
const TRAILS = {
  short: { connection: 'sqlite', table: 'audit_short', retentionDays: 30, onFailure: 'reject' },
  kept: { connection: 'sqlite', table: 'audit_kept', onFailure: 'reject' },
  probed: { store: 'ProbeStore', connection: 'sqlite', table: 'audit_probed', retentionDays: 30 },
  archived: { store: 'ProbeStore', connection: 'sqlite', table: 'audit_archived', retentionDays: 30, archiveConnection: 'sqlite' },
};

// Notes the source of every prune it is asked for and deletes nothing.
class ProbeReader extends AuditReader {
  static pruned: (string | undefined)[] = [];
  static fail = false;

  list(): Promise<readonly StoredAuditEvent[]> {
    return Promise.resolve([]);
  }

  redact(): Promise<number> {
    return Promise.resolve(0);
  }

  prune(_trail: TrailConfig, _before: Date, source?: string): Promise<number> {
    ProbeReader.pruned.push(source);
    return ProbeReader.fail ? Promise.reject(new Error('prune refused')) : Promise.resolve(0);
  }
}

class ProbeStore extends AuditStore {
  static fail = false;

  append(): Promise<void> {
    return Promise.resolve();
  }

  reader(): Promise<AuditReader | undefined> {
    return ProbeStore.fail ? Promise.reject(new Error('no reader')) : Promise.resolve(new ProbeReader());
  }
}

describe('audit retention', function () {
  this.timeout(60000);
  let db: TestDb;

  before(async () => {
    db = await TestDb.open({ trails: TRAILS });
    DI.register(ProbeStore).as(AuditStore);
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.migrate('sqlite', 'audit_short');
    await db.migrate('sqlite', 'audit_kept');
    await db.migrate('sqlite', 'audit_probed');
    ProbeReader.fail = false;
    ProbeStore.fail = false;
  });

  afterEach(async () => {
    await db.drop('sqlite', 'audit_short');
    await db.drop('sqlite', 'audit_kept');
    await db.drop('sqlite', 'audit_probed');
  });

  it("deletes the events older than a trail's retention, and only those", async () => {
    await audit().record(
      [
        { kind: 'action', action: 'old', at: ago(31) },
        { kind: 'action', action: 'edge', at: ago(29) },
        { kind: 'action', action: 'new', at: NOW },
      ],
      { trail: 'short' },
    );
    await audit().record({ kind: 'action', action: 'ancient', at: ago(4000) }, { trail: 'kept' });

    expect(await pruneAudit({ now: NOW })).to.eq(1);
    expect((await db.rows('sqlite', 'audit_short')).map((r) => r.action)).to.deep.eq(['edge', 'new']);
    expect(await db.rows('sqlite', 'audit_kept')).to.have.length(1);
  });

  it('deletes more than one chunk', async () => {
    const many = Array.from({ length: 501 }, (_unused, i) => ({ kind: 'action' as const, action: `a${i}`, at: ago(40) }));
    await audit().record(many, { trail: 'short' });
    expect(await pruneAudit({ now: NOW, trail: 'short' })).to.eq(501);
    expect(await db.rows('sqlite', 'audit_short')).to.have.length(0);
  });

  it('prunes a table trail on each connection that holds its table, and a trail with an archive once, for every source', async () => {
    ProbeReader.pruned = [];
    await pruneAudit({ now: NOW, trail: 'probed' });
    expect(ProbeReader.pruned).to.deep.eq(['sqlite']);

    ProbeReader.pruned = [];
    await pruneAudit({ now: NOW, trail: 'archived' });
    expect(ProbeReader.pruned).to.deep.eq([undefined]);
  });

  it('the scheduled task prunes and reports the count', async () => {
    await audit().record({ kind: 'action', action: 'old', at: ago(31, new Date()) }, { trail: 'short' });
    const results: unknown[] = [];
    const out = await new AuditRetentionTask().execute({ result: (data: unknown): void => void results.push(data) });

    expect(AUDIT_RETENTION_SCHEDULE).to.eq('audit.retention');
    expect(out).to.deep.eq({ deleted: 1, failed: [] });
    expect(results).to.deep.eq([out]);
  });

  it('prunes the other trails when one trail or connection fails, then reports both', async () => {
    const lines = captureLog();
    // Not a trail table: retention passes over it with a warning.
    await db
      .driver('pglite')
      .schema()
      .createTable('audit_short', (table) => {
        table.string('id', 36);
      });
    await audit().record({ kind: 'action', action: 'old', at: ago(31) }, { trail: 'short' });
    ProbeReader.fail = true;

    const err: unknown = await pruneAudit({ now: NOW }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(AuditPruneFailed);
    const failed = err instanceof AuditPruneFailed ? err : undefined;
    expect(failed?.message).to.eq('audit: retention deleted 1 event(s) and failed for probed@sqlite (prune refused); archived (prune refused)');
    expect(failed?.deleted).to.eq(1);
    expect(failed?.failed.map((f) => [f.trail, f.connection, f.reason])).to.deep.eq([
      ['probed', 'sqlite', 'prune refused'],
      ['archived', undefined, 'prune refused'],
    ]);
    expect(lines.map((l) => [l.level, l.fields.trail, l.fields.connection])).to.deep.eq([
      ['warn', 'short', 'pglite'],
      ['error', 'probed', 'sqlite'],
      ['error', 'archived', undefined],
    ]);
    await db.driver('pglite').schema().dropTable('audit_short').ifExists();
    expect(await db.rows('sqlite', 'audit_short')).to.have.length(0);

    ProbeReader.fail = false;
    ProbeStore.fail = true;
    await audit().record({ kind: 'action', action: 'old', at: ago(31, new Date()) }, { trail: 'short' });
    const results: unknown[] = [];
    await expect(new AuditRetentionTask().execute({ result: (data: unknown): void => void results.push(data) })).to.be.rejectedWith(AuditPruneFailed, 'audit: retention deleted 1 event(s) and failed for probed (no reader); archived (no reader)');
    expect(results).to.deep.eq([
      {
        deleted: 1,
        failed: [
          { trail: 'probed', connection: undefined, reason: 'no reader' },
          { trail: 'archived', connection: undefined, reason: 'no reader' },
        ],
      },
    ]);
  });
});
