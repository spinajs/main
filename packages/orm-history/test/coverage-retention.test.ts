import { expect } from 'chai';
import 'mocha';
import { audit, auditStore, trailConfig } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { AuditPruneFailed, AuditRetentionListener, pruneAudit } from '@spinajs/audit-orm';
import { DI } from '@spinajs/di';

import { CLOCK_SKEW_MARGIN_MS, TableHistoryCoverage } from '../src/coverage.js';
import { HISTORY_COVERAGE_TABLE, insertCoverage, readCoverage } from '../src/coverage-table.js';
import type { CoverageKey } from '../src/coverage-table.js';
import { LOST_SUBJECT_ID } from '../src/encode.js';
import { HistoryCoverage, registerHistory } from '../src/index.js';
import { HistoryDb } from './support/db.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-25T00:00:00.000Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);
// What since() at NOW answers for a trail that keeps `days` days and a row older than that.
const floor = (days: number): Date => new Date(ago(days).getTime() + CLOCK_SKEW_MARGIN_MS);
const COLUMNS = { recorded: ['id', 'status'], skipped: [] };

function tableCoverage(): TableHistoryCoverage {
  const coverage = DI.resolve(HistoryCoverage);
  if (!(coverage instanceof TableHistoryCoverage)) throw new Error('HistoryCoverage is not the table implementation');
  return coverage;
}

// A worker that runs AuditRetentionTask and never imported @spinajs/orm-history has no listener at all. The uncache
// drops the collection the container cached, which still holds an unregistered listener.
async function withoutListeners<T>(run: () => Promise<T>): Promise<T> {
  const listeners = DI.RootContainer.hasRegistered(AuditRetentionListener) ? [...DI.RootContainer.getRegisteredTypes(AuditRetentionListener)] : [];
  for (const listener of listeners) DI.unregister(AuditRetentionListener, listener);
  DI.uncache(AuditRetentionListener);
  try {
    return await run();
  } finally {
    for (const listener of listeners) DI.register(listener).as(AuditRetentionListener);
    DI.uncache(AuditRetentionListener);
  }
}

describe('history coverage under retention', function () {
  this.timeout(60000);
  let db: HistoryDb;

  before(async () => {
    db = await HistoryDb.open();
  });

  after(async () => {
    await db?.close();
  });

  for (const dialect of HistoryDb.dialects()) {
    describe(dialect, () => {
      const connection = (): string => db.connectionName(dialect);
      const key = (): CoverageKey => ({ trail: 'history', connection: connection(), entity: 'invoice' });
      // Read at NOW, the instant every prune of this file runs at, so the floor is that prune's cutoff.
      const since = (): Promise<Date | undefined> => tableCoverage().since('history', connection(), 'invoice', NOW);
      const row = async (): Promise<Date | undefined> => (await readCoverage(db.driver(dialect), key()))?.since;
      const retention = (days?: number): void => db.config.set('audit.trails.history', days === undefined ? {} : { retentionDays: days });
      const change = (id: string, days: number): AuditInput => ({ kind: 'data', action: 'insert', subject: { type: 'invoice', id }, data: { after: { id, status: 'draft' } }, at: ago(days) });
      const write = (inputs: readonly AuditInput[]): Promise<void> => db.driver(dialect).transaction((tx) => audit().record(inputs, { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));
      const held = async (): Promise<unknown[]> => (await db.rows('orm_history', dialect)).map((r) => r.subject_id);

      beforeEach(async () => {
        await db.migrateHistory(dialect);
        await db.migrateCoverage(dialect);
        await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, dialect);
        retention(30);
      });

      afterEach(async () => {
        retention();
        await db.driver(dialect).schema().dropTable(HISTORY_COVERAGE_TABLE).ifExists();
        await db.clear();
      });

      it('moves the coverage row of the trail to the cutoff and deletes the older events', async () => {
        await tableCoverage().record(undefined, ago(100));
        await write([change('old', 40), change('new', 1)]);

        expect(await pruneAudit({ trail: 'history', now: NOW })).to.eq(1);
        // The row itself: the floor alone already makes since() answer the cutoff.
        expect(await row()).to.deep.eq(ago(30));
        expect(await since()).to.deep.eq(floor(30));
        expect(await held()).to.deep.eq(['new']);
      });

      it('leaves a coverage that starts after the cutoff, and the rows of other trails', async () => {
        const driver = db.driver(dialect);
        const other = { trail: 'other', connection: connection(), entity: 'invoice' };
        await tableCoverage().record(undefined, ago(10));
        await insertCoverage(driver, other, COLUMNS, ago(100));

        await pruneAudit({ trail: 'history', now: NOW });
        expect(await since()).to.deep.eq(ago(10));
        expect((await readCoverage(driver, other))?.since).to.deep.eq(ago(100));
      });

      it('prunes a connection that has no coverage table', async () => {
        await db.dropCoverage(dialect);
        await write([change('old', 40)]);

        expect(await pruneAudit({ trail: 'history', now: NOW })).to.eq(1);
        expect(await held()).to.deep.eq([]);
      });

      it('keeps the events of a connection whose coverage cannot be moved', async () => {
        await write([change('old', 40)]);
        // A table of that name without the columns: the move fails.
        await db.dropCoverage(dialect);
        await db
          .driver(dialect)
          .schema()
          .createTable(HISTORY_COVERAGE_TABLE, (table) => {
            table.int('id').primaryKey();
          });

        const err: unknown = await pruneAudit({ trail: 'history', now: NOW }).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).to.be.instanceOf(AuditPruneFailed);
        expect(err instanceof AuditPruneFailed && err.failed.map((f) => [f.trail, f.connection])).to.deep.eq([['history', connection()]]);
        expect(await held()).to.deep.eq(['old']);
      });

      it('never answers earlier than the retention keeps, before any prune, and only for a trail with retentionDays', async () => {
        // The floor bounds a claim and never makes one.
        expect(await since()).to.eq(undefined);
        await tableCoverage().record(undefined, ago(100));
        expect(await row()).to.deep.eq(ago(100));
        expect(await since()).to.deep.eq(floor(30));

        retention();
        expect(await since()).to.deep.eq(ago(100));
      });

      it('starts at the cutoff after a prune by a process that has no listener', async () => {
        await tableCoverage().record(undefined, ago(100));
        await write([change('old', 40), change('new', 1)]);

        expect(await withoutListeners(() => pruneAudit({ trail: 'history', now: NOW }))).to.eq(1);
        expect(await held()).to.deep.eq(['new']);
        // Nothing moved the row, so this test cannot pass through the listener.
        expect(await row()).to.deep.eq(ago(100));
        expect(await since()).to.deep.eq(floor(30));
      });

      it('claims nothing pruned by a process whose clock runs up to the margin ahead', async () => {
        await tableCoverage().record(undefined, ago(100));
        const skew = CLOCK_SKEW_MARGIN_MS - 1000;
        const cutoff = ago(30).getTime() + skew;
        await write([{ ...change('edge', 30), at: new Date(cutoff - 500) }, change('new', 1)]);

        expect(await withoutListeners(() => pruneAudit({ trail: 'history', now: new Date(NOW.getTime() + skew) }))).to.eq(1);
        expect(await held()).to.deep.eq(['new']);
        expect((await since())?.getTime()).to.be.at.least(cutoff);
      });

      // The limits 05-coverage.md states under "Retention". A change that makes one of these fail changes those docs.
      it('over-claims when retentionDays is raised or removed after such a prune', async () => {
        await tableCoverage().record(undefined, ago(100));
        await write([change('old', 40), change('new', 1)]);
        await withoutListeners(() => pruneAudit({ trail: 'history', now: NOW }));
        retention(90);

        expect(await held()).to.deep.eq(['new']);
        expect(await since()).to.deep.eq(floor(90));
        retention();
        expect(await since()).to.deep.eq(ago(100));
      });

      it('over-claims after a reader prune called directly with a cutoff later than the retention', async () => {
        await tableCoverage().record(undefined, ago(100));
        await write([change('old', 20), change('new', 1)]);
        const trail = trailConfig('history');
        const reader = await (await auditStore(trail)).reader(trail);
        if (!reader) throw new Error('the history trail has no reader');

        expect(await reader.prune(trail, ago(10), connection())).to.eq(1);
        expect(await held()).to.deep.eq(['new']);
        expect(await since()).to.deep.eq(floor(30));
      });
    });
  }

  describe('sqlite, the clock of since()', () => {
    beforeEach(async () => {
      await db.migrateHistory('sqlite');
      await db.migrateCoverage('sqlite');
      await db.define({ name: 'Invoice', table: 'invoice', columns: { status: 'TEXT' }, decorate: (c) => registerHistory(c) }, 'sqlite');
      db.config.set('audit.trails.history', { retentionDays: 30 });
    });

    afterEach(async () => {
      db.config.set('audit.trails.history', {});
      await db.driver('sqlite').schema().dropTable(HISTORY_COVERAGE_TABLE).ifExists();
      await db.clear();
    });

    it('reads its clock after the reads: a prune without the listener during since() leaves no claim over a deleted lost marker', async () => {
      const driver = db.driver('sqlite');
      await tableCoverage().record(undefined, new Date(Date.now() - 100 * DAY));
      const start = Date.now();
      // 1 s past a floor taken when since() starts, so only a floor taken after the prune below covers the marker.
      const markerAt = new Date(start - 30 * DAY + CLOCK_SKEW_MARGIN_MS + 1000);
      const lost: AuditInput = { kind: 'data', action: 'lost', subject: { type: 'invoice', id: LOST_SUBJECT_ID }, at: markerAt };
      await driver.transaction((tx) => audit().record([lost], { trail: 'history', mode: 'transactional', transaction: tx, onFailure: 'reject' }));
      expect(Date.now()).to.be.below(start + 1000);

      const original = driver.execute.bind(driver);
      let pruned = -1;
      let armed = true;
      driver.execute = async (builder): Promise<unknown> => {
        if (armed) {
          armed = false;
          await new Promise((resolve) => setTimeout(resolve, CLOCK_SKEW_MARGIN_MS + 2000));
          pruned = await withoutListeners(() => pruneAudit({ trail: 'history' }));
        }
        const result: unknown = await original(builder);
        return result;
      };
      let since: Date | undefined;
      try {
        since = await tableCoverage().since('history', db.connectionName('sqlite'), 'invoice');
      } finally {
        driver.execute = original;
      }

      expect(pruned).to.eq(1);
      expect(since?.getTime()).to.be.at.least(markerAt.getTime());
    });
  });
});
