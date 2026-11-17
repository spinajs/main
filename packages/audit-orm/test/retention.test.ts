import * as chai from 'chai';
import 'mocha';
import { AuditReader, AuditStore, audit } from '@spinajs/audit';
import type { StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { pruneAudit } from '../src/index.js';
import { AUDIT_RETENTION_SCHEDULE, AuditRetentionTask } from '../src/scheduler.js';
import { TestDb } from '../src/testing.js';

const expect = chai.expect;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-16T00:00:00.000Z');
const ago = (days: number, from: Date = NOW): Date => new Date(from.getTime() - days * DAY);
const TRAILS = {
  short: { connection: 'sqlite', table: 'audit_short', retentionDays: 30, onFailure: 'reject' },
  kept: { connection: 'sqlite', table: 'audit_kept', onFailure: 'reject' },
  probed: { store: 'ProbeStore', connection: 'sqlite', table: 'audit_short', retentionDays: 30 },
  archived: { store: 'ProbeStore', connection: 'sqlite', table: 'audit_short', retentionDays: 30, archiveConnection: 'sqlite' },
};

// Notes the source of every prune it is asked for and deletes nothing.
class ProbeReader extends AuditReader {
  static pruned: (string | undefined)[] = [];

  list(): Promise<readonly StoredAuditEvent[]> {
    return Promise.resolve([]);
  }

  redact(): Promise<number> {
    return Promise.resolve(0);
  }

  prune(_trail: TrailConfig, _before: Date, source?: string): Promise<number> {
    ProbeReader.pruned.push(source);
    return Promise.resolve(0);
  }
}

class ProbeStore extends AuditStore {
  append(): Promise<void> {
    return Promise.resolve();
  }

  reader(): Promise<AuditReader | undefined> {
    return Promise.resolve(new ProbeReader());
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
  });

  afterEach(async () => {
    await db.drop('sqlite', 'audit_short');
    await db.drop('sqlite', 'audit_kept');
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
    expect(out).to.deep.eq({ deleted: 1 });
    expect(results).to.deep.eq([out]);
  });
});
