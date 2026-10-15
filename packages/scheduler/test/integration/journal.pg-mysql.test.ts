import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { appendJournalRow, JournalRow, RunEvent, RunEventHub, RunEventWriter, RunLogModel } from '../../src/index.js';
import { waitFor } from '../support/env.js';
import { bootRealDb, heldOpen, REAL_DB_TARGETS } from './real-db.js';

const T = Date.parse('2026-01-05T10:00:00Z');

const row = (runId: string, seq: number): JournalRow => ({
  RunId: runId,
  Schedule: 'pos',
  Seq: seq,
  Attempt: 1,
  Ts: T,
  Kind: 'log',
  Data: { type: 'log', level: 'info', message: `${runId}#${seq}`, step: null },
});

const visiblePositions = async () => (await RunLogModel.where('Schedule', 'pos').orderBy('Pos')).map((r) => r.Pos);

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`journal positions (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(async () => {
      await bootRealDb(target);
    });

    it('a later position waits for the earlier one to commit (R15)', async () => {
      const held = await heldOpen(() => appendJournalRow(row('r1', 1)));
      expect(held.result.Pos).to.eq(1);

      let settled = false;
      const second = appendJournalRow(row('r2', 1)).finally(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled, 'the second append must wait for the counter row lock').to.eq(false);
      expect(await visiblePositions()).to.deep.eq([]);

      await held.commit();
      expect((await second).Pos).to.eq(2);
      expect(await visiblePositions()).to.deep.eq([1, 2]);
    });

    it('a rolled-back append leaves no gap', async () => {
      await appendJournalRow(row('r1', 1));
      let failed = false;
      await appendJournalRow(row('r1', 1)).catch(() => (failed = true));
      expect(failed).to.eq(true);
      expect((await appendJournalRow(row('r1', 2))).Pos).to.eq(2);
    });

    it('concurrent writers: a reader never sees a later position before an earlier one', async () => {
      const N = 40;
      const seen: number[] = [];
      let writing = true;
      const reader = (async () => {
        let cursor = 0;
        while (writing || cursor < 2 * N) {
          const rows = await RunLogModel.where('Schedule', 'pos').where('Pos', '>', cursor).orderBy('Pos');
          for (const r of rows) {
            // a gap means a later position became visible before an earlier one committed
            expect(r.Pos, `after ${cursor}`).to.eq(cursor + 1);
            cursor = r.Pos;
            seen.push(r.Pos);
          }
        }
      })();
      await Promise.all(
        ['r1', 'r2'].map((replica) =>
          Promise.all(Array.from({ length: N }, (_, i) => appendJournalRow(row(replica, i + 1)))),
        ),
      );
      writing = false;
      await reader;
      expect(seen).to.deep.eq(Array.from({ length: 2 * N }, (_, i) => i + 1));
    });

    it('a schedule stream resumed with Last-Event-ID misses no event of another writer', async () => {
      const writer = DI.resolve(RunEventWriter);
      const hub = DI.resolve(RunEventHub);
      const got: RunEvent[] = [];
      const off = await hub.subscribe({ schedule: 'pos' }, (e) => got.push(e), { after: 0 });
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => appendJournalRow(row('remote', i + 1))),
        ...Array.from({ length: 10 }, (_, i) =>
          writer.write({ Id: 'local', Schedule: 'pos' }, 1, {
            type: 'log',
            level: 'info',
            message: `l${i}`,
            step: null,
          }),
        ),
      ]);
      // remote rows are never published here: only local wake-ups fetch them from the journal
      await waitFor(() => got.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      off();
      const resumed: RunEvent[] = [];
      const off2 = await hub.subscribe({ schedule: 'pos' }, (e) => resumed.push(e), { after: got.at(-1)?.id ?? 0 });
      off2();
      expect([...got, ...resumed].map((e) => e.id)).to.deep.eq(Array.from({ length: 20 }, (_, i) => i + 1));
    });
  });
}
