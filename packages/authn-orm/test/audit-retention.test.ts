import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';

import { AuthnAuditRetention, DbAuthnAuditSink, PurgeAudit } from '../src/index.js';
import { DB_KINDS, TestDb, bootDb, rawQuery } from './support/db.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const DAY = 86_400_000;
const PAGE = 500;

type Executor = { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<unknown> };

/** Counts the DELETE statements `driver` runs until `restore()`. */
function countDeletes(driver: OrmDriver): { count(): number; restore(): void } {
  const target = driver as unknown as Executor;
  const original = target.executeOnDb.bind(target);
  let deletes = 0;
  target.executeOnDb = (sql, bindings, context) => {
    if (context === QueryContext.Delete && /^\s*delete\b/i.test(sql)) {
      deletes++;
    }
    return original(sql, bindings, context);
  };
  return { count: () => deletes, restore: () => void delete (target as Partial<Executor>).executeOnDb };
}

async function publishAt(db: TestDb, ms: number, type = 'login'): Promise<void> {
  await (await db.container.resolve(DbAuthnAuditSink)).publish({ type: type as never, at: new Date(ms), outcome: 'success' });
}

async function publishMany(db: TestDb, count: number, ms: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await publishAt(db, ms + i);
  }
}

async function remaining(db: TestDb): Promise<number> {
  return ((await rawQuery(db.driver, 'SELECT id FROM authn_audit')) as unknown[]).length;
}

for (const kind of DB_KINDS) {
  describe(`AuthnAuditRetention (${kind})`, function () {
    this.timeout(120000);

    describe('retentionDays 30', () => {
      let db: TestDb;
      let deletes: ReturnType<typeof countDeletes> | undefined;

      before(async function () {
        db = await bootDb(this, kind, 'audit-retention', { config: { authn: { audit: { retentionDays: 30 } } } });
      });

      after(async () => {
        await db?.dispose();
      });

      beforeEach(async () => {
        await rawQuery(db.driver, 'DELETE FROM authn_audit', [], QueryContext.Delete);
      });

      afterEach(() => {
        deletes?.restore();
        deletes = undefined;
      });

      it('deletes only rows older than now minus 30 days, in batches of 500', async () => {
        const cutoff = NOW.getTime() - 30 * DAY;
        await publishMany(db, 1250, cutoff - 40 * DAY);
        await publishAt(db, cutoff - 1000, 'old.edge');
        await publishAt(db, cutoff, 'keep.edge');
        await publishAt(db, cutoff + 1000, 'keep.after');
        await publishAt(db, NOW.getTime(), 'keep.now');
        deletes = countDeletes(db.driver);

        const purged = await (await db.container.resolve(AuthnAuditRetention)).purge(NOW);

        expect(purged).to.equal(1251);
        expect(deletes.count()).to.equal(Math.ceil(1251 / PAGE));
        expect(await remaining(db)).to.equal(3);
        const types = (await rawQuery(db.driver, 'SELECT type FROM authn_audit ORDER BY type')) as Array<{ type: string }>;
        expect(types.map((r) => r.type)).to.deep.equal(['keep.after', 'keep.edge', 'keep.now']);
      });

      it('answers 0 and issues no DELETE when nothing is old enough', async () => {
        await publishAt(db, NOW.getTime() - DAY);
        deletes = countDeletes(db.driver);

        expect(await (await db.container.resolve(AuthnAuditRetention)).purge(NOW)).to.equal(0);

        expect(deletes.count()).to.equal(0);
        expect(await remaining(db)).to.equal(1);
      });

      it('authn:audit-purge purges with the configured retention', async () => {
        await publishMany(db, 3, NOW.getTime() - 90 * DAY);
        await publishAt(db, Date.now());
        const exitCode = process.exitCode;

        await (await db.container.resolve(PurgeAudit)).execute();

        expect(await remaining(db)).to.equal(1);
        expect(process.exitCode).to.equal(exitCode);
      });
    });

    describe('retentionDays unset', () => {
      let db: TestDb;

      before(async function () {
        db = await bootDb(this, kind, 'audit-retention-off');
      });

      after(async () => {
        await db?.dispose();
      });

      it('deletes nothing', async () => {
        await publishMany(db, 3, NOW.getTime() - 3000 * DAY);
        const deletes = countDeletes(db.driver);

        try {
          expect(await (await db.container.resolve(AuthnAuditRetention)).purge(NOW)).to.equal(0);
          await (await db.container.resolve(PurgeAudit)).execute();
        } finally {
          deletes.restore();
        }

        expect(deletes.count()).to.equal(0);
        expect(await remaining(db)).to.equal(3);
      });
    });

    describe('purgeInterval', () => {
      let db: TestDb;

      before(async function () {
        db = await bootDb(this, kind, 'audit-retention-timer', { config: { authn: { audit: { retentionDays: 30, purgeInterval: 25 } } } });
      });

      after(async () => {
        await db?.dispose();
      });

      it('purges on a timer until disposed', async () => {
        await publishMany(db, 3, Date.now() - 90 * DAY);
        const retention = await db.container.resolve(AuthnAuditRetention);

        const deadline = Date.now() + 5000;
        while ((await remaining(db)) > 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await remaining(db)).to.equal(0);

        await retention.dispose();
        await publishMany(db, 1, Date.now() - 90 * DAY);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await remaining(db)).to.equal(1);
      });
    });
  });
}
