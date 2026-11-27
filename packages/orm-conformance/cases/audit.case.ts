import { audit, trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { ArchiveAuditSink, AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, OutboxAuditStore, rowsOf, sealAudit, shipAudit, verifyTable } from '@spinajs/audit-orm';
import { AuditBatchRecorded, archiveAuditBatch } from '@spinajs/audit-orm/queue';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

const TRAIL = 'cf';
const ARCHIVE = 'audit_cf';

class ConformanceArchiveMigration extends AuditArchiveTableMigration {
  protected override table(): string {
    return ARCHIVE;
  }
}

const event = (n: number): AuditEvent => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  at: new Date(Date.UTC(2026, 10, 16, 10, 0, n, 250)),
  kind: 'data',
  action: 'update',
  subject: { type: 'invoice', id: String(n) },
  outcome: 'ok',
  actor: 'user:u1',
  data: { before: { status: 'draft' }, after: { id: n, status: 'paid', note: 'café 東京' }, changed: ['status'] },
});

const count = async (driver: OrmDriver, table: string): Promise<number> => rowsOf(await driver.select().from(table)).length;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/**
 * The case writes its own trail into the target application's configuration and restores it afterwards: the runner
 * boots each target without audit trails, and the shipper, the sink and the sealer read their trail from there. The
 * whole audit section is put back from a copy: there is no unset, and setting trails to undefined would leave the key.
 */
async function withTrail<T>(driver: OrmDriver, run: () => Promise<T>): Promise<T> {
  const config = DI.get(Configuration);
  if (!config) throw new Error('the conformance application has no Configuration');
  const audit = config.get<unknown>(['audit']);
  const saved = isRecord(audit) ? { ...audit } : undefined;
  const trails = saved?.trails;
  const name = driver.Options.Name;
  config.set(['audit', 'trails'], { ...(isRecord(trails) ? trails : {}), [TRAIL]: { store: 'OutboxAuditStore', sink: 'ArchiveAuditSink', reader: 'ArchiveAuditReader', table: ARCHIVE, connection: name, archiveConnection: name, integrity: 'sealed' } });
  try {
    return await run();
  } finally {
    config.set(['audit'], saved);
  }
}

async function withTables<T>(driver: OrmDriver, run: () => Promise<T>): Promise<T> {
  const migrations = [new AuditOutboxTableMigration(), new ConformanceArchiveMigration(), new AuditSealTableMigration()];
  // A failed earlier run on a server target may have left the tables behind.
  for (const m of migrations) await m.down(driver);
  for (const m of migrations) await m.up(driver);
  try {
    return await withTrail(driver, run);
  } finally {
    for (const m of migrations) await m.down(driver);
  }
}

export const AUDIT_CASES = [
  defineCase({
    name: 'audit-ship-seal-verify',
    seed: EMPTY,
    order: 'ordered',
    run: ({ driver }) =>
      withTables(driver, async () => {
        const events = [event(1), event(2), event(3)];
        await DI.resolve(OutboxAuditStore).append({ trail: trailConfig(TRAIL), events });
        const shipped = await shipAudit({ trail: TRAIL });
        // A redelivery of the same events stores nothing twice.
        await DI.resolve(ArchiveAuditSink).deliver({ trail: TRAIL, source: driver.Options.Name, events });
        const sealed = await sealAudit({ trail: TRAIL, settleMs: 0 });
        const [seal] = rowsOf(await driver.select().from('audit_seal'));
        const report = await verifyTable(driver, ARCHIVE);
        return {
          shipped: shipped.shipped,
          shipFailures: shipped.failed.length,
          archived: await count(driver, ARCHIVE),
          left: await count(driver, 'audit_outbox'),
          sealed: sealed.sealed,
          sealFailures: sealed.failed.map((f) => f.reason),
          // The seal's own hash chains its sealed_at, a time of the run; what it sealed is the same on every target.
          eventsHash: seal?.events_hash ?? null,
          seals: report.seals,
          intact: report.intact,
          tampered: report.tampered ?? null,
          unsealed: report.unsealed,
        };
      }),
  }),
  defineCase({
    name: 'audit-exact-subject',
    seed: EMPTY,
    order: 'ordered',
    // A collation that folds case or a column that cannot hold the name would erase ABC with abc or alter Łukasz-7.
    run: ({ driver }) =>
      withTables(driver, async () => {
        const events = ['Łukasz-7', 'ABC', 'abc'].map((id, i) => ({ ...event(i + 1), subject: { type: 'user', id } }));
        await DI.resolve(ArchiveAuditSink).deliver({ trail: TRAIL, source: driver.Options.Name, events });
        const erased = await audit().trail(TRAIL).forget({ type: 'user', id: 'abc' });
        const rows = rowsOf(await driver.select().from(ARCHIVE).orderBy('seq'));
        return { erased, archived: rows.map((r) => ({ subject: r.subject_id, blank: r.data === '' })), payloads: rows.map((r) => (r.data === '' ? null : r.data)) };
      }),
  }),
  defineCase({
    name: 'audit-exact-subject-trailing-space',
    seed: EMPTY,
    order: 'ordered',
    // MySQL and SQL Server compare 't1:42' equal to 't1:42 ' (a composite key's text) and 'doc' to 'doc '; archived and buffered rows alike.
    expected: { of: ['t1:42', 't1:42'], erased: 3, archived: ['doc|t1:42:true', 'doc|t1:42 :false', 'doc|t1:42:true', 'doc |t1:42:false'], buffered: ['doc|t1:42 :false', 'doc|t1:42:true', 'doc |t1:42:false'] },
    run: ({ driver }) =>
      withTables(driver, async () => {
        const subject = (n: number, id: string, type = 'doc'): AuditEvent => ({ ...event(n), subject: { type, id } });
        await DI.resolve(ArchiveAuditSink).deliver({ trail: TRAIL, source: driver.Options.Name, events: [subject(1, 't1:42'), subject(2, 't1:42 '), subject(3, 't1:42'), subject(6, 't1:42', 'doc ')] });
        await DI.resolve(OutboxAuditStore).append({ trail: trailConfig(TRAIL), events: [subject(4, 't1:42 '), subject(5, 't1:42'), subject(7, 't1:42', 'doc ')] });
        const of = (await audit().trail(TRAIL).of({ type: 'doc', id: 't1:42' })).map((e) => e.subject?.id);
        const erased = await audit().trail(TRAIL).forget({ type: 'doc', id: 't1:42' });
        const blank = async (table: string): Promise<string[]> => rowsOf(await driver.select().from(table).where('kind', 'data').orderBy('seq')).map((r) => `${String(r.subject_type)}|${String(r.subject_id)}:${String(r.data === '')}`);
        return { of, erased, archived: await blank(ARCHIVE), buffered: await blank('audit_outbox') };
      }),
  }),
  defineCase({
    name: 'audit-exact-subject-arriving-erasure',
    seed: EMPTY,
    order: 'ordered',
    // An erasure that arrives over the queue blanks the archived events of exactly its subject.
    expected: { changed: ['doc|ABC', 'doc|ABC'], added: ['doc|ABC'] },
    run: ({ driver }) =>
      withTables(driver, async () => {
        const subject = (n: number, id: string, type = 'doc'): AuditEvent => ({ ...event(n), subject: { type, id } });
        const arrive = (events: AuditEvent[]): Promise<void> => archiveAuditBatch(new AuditBatchRecorded({ Trail: TRAIL, Source: 'app', Events: events.map((e) => ({ ...e, at: e.at.toISOString() })) }));
        await arrive([subject(1, 'ABC'), subject(2, 'ABC '), subject(3, 'ABC  '), subject(4, 'ABC', 'doc '), subject(5, 'ABC')]);
        const before = await trailRows(driver, ARCHIVE);
        await arrive([{ ...subject(6, 'ABC'), kind: 'custom', action: 'erasure', at: new Date(), data: { redacted: 2 } }]);
        const after = await trailRows(driver, ARCHIVE);
        return { changed: changedRows(before, after), added: [...after].filter(([seq]) => !before.has(seq)).map(([, r]) => r.subject) };
      }),
  }),
];

export type TrailRows = Map<unknown, { subject: string; row: string }>;

/** Every row of a trail table by `seq`, all columns serialised, so a comparison sees any changed byte. */
export async function trailRows(driver: OrmDriver, table: string): Promise<TrailRows> {
  const rows = rowsOf(await driver.select().from(table).orderBy('seq'));
  return new Map(rows.map((r) => [r.seq, { subject: `${String(r.subject_type)}|${String(r.subject_id)}`, row: JSON.stringify(r, (_, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) }]));
}

/** The subjects of the rows of `before` that `after` changed or lost. */
export const changedRows = (before: TrailRows, after: TrailRows): string[] => [...before].filter(([seq, b]) => after.get(seq)?.row !== b.row).map(([, b]) => b.subject);
