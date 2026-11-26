import { isDeepStrictEqual } from 'node:util';

import { DI } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import type { ModelBase, OrmDriver } from '@spinajs/orm';
import { HistoryCoverage, OrmHistoryCoverage_2026_11_25_00_00_00, OrmHistory_2026_11_16_00_00_00, historyOf, registerHistory } from '@spinajs/orm-history';
import { DateTime } from 'luxon';

import { CfDoc, CfUser, defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

/** The runner starts no migration, so a case creates the trail and coverage tables of its one connection itself and tracks one shared model while it runs. */
async function tracked<T>(driver: OrmDriver, model: Constructor<ModelBase>, run: () => Promise<T>): Promise<T> {
  const tables = [new OrmHistory_2026_11_16_00_00_00(), new OrmHistoryCoverage_2026_11_25_00_00_00()];
  for (const table of tables) {
    // A failed earlier run on a server target may have left the table behind.
    await table.down(driver);
    await table.up(driver);
  }
  registerHistory(model);
  try {
    return await run();
  } finally {
    registerHistory(model, false);
    for (const table of tables) await table.down(driver);
  }
}

export const HISTORY_CASES = [
  defineCase({
    name: 'history-insert-update-forget',
    seed: EMPTY,
    order: 'ordered',
    expected: { entries: ['insert:Łukasz 東京:', 'update:renamed:Name'], forgot: 2, redacted: [true, true] },
    run: ({ driver }) =>
      tracked(driver, CfUser, async () => {
        const user = await CfUser.create({ Name: 'Łukasz 東京', Active: true });
        user.Name = 'renamed';
        await user.update();
        const entries = (await historyOf(user).entries()).map((e) => `${e.op}:${String(e.after?.Name)}:${e.changed.join(',')}`);
        const forgot = await historyOf(user).forget();
        return { entries, forgot, redacted: (await historyOf(user).entries()).map((e) => e.redacted) };
      }),
  }),
  defineCase({
    name: 'history-multi-row-insert',
    seed: EMPTY,
    order: 'ordered',
    expected: { asTheDriverPromises: true },
    run: ({ driver }) =>
      tracked(driver, CfUser, async () => {
        const users = [new CfUser({ Name: 'a', Active: true }), new CfUser({ Name: 'b', Active: true })];
        await CfUser.insert(users);
        const ops = (await historyOf(CfUser).since(0)).map((e) => e.op);
        // A connection that reports the keys of a multi-row insert gives one entry per row; one that does not gives one `lost` marker.
        const reported = users.every((u) => u.Id !== null && u.Id !== undefined);
        return { asTheDriverPromises: ops.join(',') === (reported ? 'insert,insert' : 'lost') };
      }),
  }),
  defineCase({
    name: 'history-json-and-instant',
    seed: EMPTY,
    order: 'ordered',
    expected: { label: 'café', body: { a: null, b: [1, { c: 2, d: 'ł' }] }, stateAtItsOwnInstant: 'present' },
    run: ({ driver }) =>
      tracked(driver, CfDoc, async () => {
        const doc = await CfDoc.create({ Label: 'café', Body: { b: [1, { d: 'ł', c: 2 }], a: null } });
        const [entry] = await historyOf(doc).entries();
        const raw: unknown = entry?.after?.Body;
        const body: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const at = entry === undefined ? { state: 'missing' } : await historyOf(doc).asOf(entry.at);
        return { label: entry?.after?.Label, body, stateAtItsOwnInstant: at.state };
      }),
  }),
  defineCase({
    name: 'history-coverage',
    seed: EMPTY,
    order: 'ordered',
    expected: { coveredBefore: false, recorded: true, kept: true, followsTheLostMarker: true },
    run: ({ driver }) =>
      tracked(driver, CfUser, async () => {
        const coverage = DI.resolve(HistoryCoverage);
        const since = async (): Promise<number | undefined> => (await coverage.since('history', driver.Options.Name, 'cf_users'))?.getTime();
        const before = await since();
        await coverage.record([CfUser]);
        const recorded = await since();
        await coverage.record([CfUser]);
        const kept = await since();
        await CfUser.insert([new CfUser({ Name: 'a', Active: true }), new CfUser({ Name: 'b', Active: true })]);
        const [marker] = await historyOf(CfUser).since(0, { ops: ['lost'] });
        // A connection that reports the keys of a multi-row insert leaves the coverage alone; one that does not moves it to its marker.
        const expected = marker === undefined ? recorded : Math.max(marker.at.getTime(), recorded ?? 0);
        return { coveredBefore: before !== undefined, recorded: recorded !== undefined, kept: kept === recorded, followsTheLostMarker: (await since()) === expected };
      }),
  }),
  defineCase({
    name: 'history-current-is-the-last-after',
    seed: EMPTY,
    order: 'ordered',
    expected: { inserted: true, updated: true, deleted: true, last: 'delete', noneBefore: true, atItsInstant: true, notAMillisecondBefore: true, pastTheBindLimit: true },
    run: ({ driver }) =>
      tracked(driver, CfUser, async () => {
        const history = historyOf(CfUser);
        const agree = async (id: string): Promise<boolean> => isDeepStrictEqual((await history.current([id])).get(id) ?? null, (await history.latest([id])).get(id)?.after ?? null);
        const user = await CfUser.create({ Name: 'Łukasz 東京', Active: true, Score: 12.5, CreatedAt: DateTime.fromISO('2026-11-25T10:00:00.123Z') });
        const id = String(user.Id);
        const inserted = await agree(id);
        // More keys than MSSQL binds in one statement (2100), none of them a row.
        const pastTheBindLimit = (await history.current([...Array.from({ length: 2200 }, (_, i) => String(1_000_000 + i)), id])).has(id);
        user.Name = 'renamed';
        await user.update();
        const updated = await agree(id);
        await user.destroy();
        const deleted = await agree(id);
        const lastEntry = (await history.latest([id])).get(id);
        const at = lastEntry?.at ?? new Date(0);
        const atItsInstant = (await history.latestBefore([id], at)).get(id)?.seq === lastEntry?.seq;
        const notAMillisecondBefore = (await history.latestBefore([id], new Date(at.getTime() - 1))).get(id)?.seq !== lastEntry?.seq;
        const noneBefore = (await history.latestBefore([id], new Date(0))).size === 0;
        return { inserted, updated, deleted, last: lastEntry?.op, noneBefore, atItsInstant, notAMillisecondBefore, pastTheBindLimit };
      }),
  }),
  defineCase({
    name: 'history-current-json',
    seed: EMPTY,
    order: 'ordered',
    expected: { agrees: true, selected: ['café'] },
    run: ({ driver }) =>
      tracked(driver, CfDoc, async () => {
        const history = historyOf(CfDoc);
        const doc = await CfDoc.create({ Label: 'café', Body: { b: [1, { d: 'ł', c: 2 }], a: null } });
        const id = String(doc.Id);
        const agrees = isDeepStrictEqual((await history.current([id])).get(id), (await history.latest([id])).get(id)?.after);
        const selected = [...(await history.currentWhere({ Label: 'café' }, 10)).values()].map((row) => row.Label);
        return { agrees, selected };
      }),
  }),
];
