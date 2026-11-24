import type { Constructor } from '@spinajs/di';
import type { ModelBase, OrmDriver } from '@spinajs/orm';
import { OrmHistory_2026_11_16_00_00_00, historyOf, registerHistory } from '@spinajs/orm-history';

import { CfDoc, CfUser, defineCase } from '../src/index.js';
import { EMPTY } from './seeds.js';

/** The runner starts no migration, so a case creates the trail table of its one connection itself and tracks one shared model while it runs. */
async function tracked<T>(driver: OrmDriver, model: Constructor<ModelBase>, run: () => Promise<T>): Promise<T> {
  const table = new OrmHistory_2026_11_16_00_00_00();
  // A failed earlier run on a server target may have left the table behind.
  await table.down(driver);
  await table.up(driver);
  registerHistory(model);
  try {
    return await run();
  } finally {
    registerHistory(model, false);
    await table.down(driver);
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
];
