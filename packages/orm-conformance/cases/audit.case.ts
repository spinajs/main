import { trailConfig } from '@spinajs/audit';
import type { AuditEvent } from '@spinajs/audit';
import { ArchiveAuditSink, AuditArchiveTableMigration, AuditOutboxTableMigration, AuditSealTableMigration, OutboxAuditStore, rowsOf, sealAudit, shipAudit, verifyTable } from '@spinajs/audit-orm';
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

export const AUDIT_CASES = [
  defineCase({
    name: 'audit-ship-seal-verify',
    seed: EMPTY,
    order: 'ordered',
    run: async ({ driver }) => {
      const migrations = [new AuditOutboxTableMigration(), new ConformanceArchiveMigration(), new AuditSealTableMigration()];
      // A failed earlier run on a server target may have left the tables behind.
      for (const m of migrations) await m.down(driver);
      for (const m of migrations) await m.up(driver);
      try {
        return await withTrail(driver, async () => {
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
            head: seal?.hash ?? null,
            seals: report.seals,
            intact: report.intact,
            tampered: report.tampered ?? null,
            unsealed: report.unsealed,
          };
        });
      } finally {
        for (const m of migrations) await m.down(driver);
      }
    },
  }),
];
