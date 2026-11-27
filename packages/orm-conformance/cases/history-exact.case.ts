import { audit, trailConfig } from '@spinajs/audit';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { History, OrmHistory_2026_11_16_00_00_00, historyOf, registerHistory } from '@spinajs/orm-history';
import type { AsOf, TrackedModel, TrackedRow } from '@spinajs/orm-history';

import { CONFORMANCE_CONNECTION, CfUser, defineCase } from '../src/index.js';
import type { ConformanceDb } from '../src/index.js';
import { changedRows, trailRows } from './audit.case.js';
import type { TrailRows } from './audit.case.js';
import { EMPTY } from './seeds.js';

export interface CfKey extends TrackedRow {}

@Connection(CONFORMANCE_CONNECTION)
@Model('cf_keys')
@History()
export class CfKey extends ModelBase<CfKey> {
  declare static history: TrackedModel['history'];

  @Primary()
  public Id: string;

  public Name: string;
}

const UUID = '3f2b8c1e-9d4a-4e6b-8f00-1a2b3c4d5e6f';

// Each event gets its own millisecond, so an instant between two writes splits them on every dialect.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

async function withKeys<T>({ driver, orm }: ConformanceDb, run: () => Promise<T>): Promise<T> {
  const trail = new OrmHistory_2026_11_16_00_00_00();
  // A failed earlier run on a server target may have left the tables behind.
  await trail.down(driver);
  await driver.schema().dropTable('cf_keys').ifExists();
  await trail.up(driver);
  await driver.schema().createTable('cf_keys', (t) => {
    t.string('Id', 36).primaryKey();
    t.string('Name', 32).notNull();
  });
  await orm.reloadTableInfo();
  registerHistory(CfUser);
  try {
    return await run();
  } finally {
    registerHistory(CfUser, false);
    await driver.schema().dropTable('cf_keys').ifExists();
    await trail.down(driver);
  }
}

const stateOf = (a: AsOf): string => (a.state === 'present' ? `present:${String(a.row.Name)}` : a.state === 'absent' ? `absent:${a.seq === null ? 'never' : 'deleted'}` : a.state);

export const HISTORY_EXACT_CASES = [
  defineCase({
    name: 'history-exact-subject-look-alikes',
    seed: EMPTY,
    order: 'ordered',
    // MySQL and SQL Server compare 'ABC' equal to 'ABC ' (and a case- or accent-folding collation to 'abc', 'ÀBC'); the
    // rows never coexist here, so the key table accepts each on every dialect and only the trail can tell them apart.
    expected: {
      own: ['insert:ABC', 'update:ABC'],
      spaced: ['insert:ABC ', 'delete:ABC '],
      before: 'absent:never',
      ownAfter: 'present:mine 2',
      spacedAfter: 'absent:deleted',
      typed: ['cf_keys |ABC'],
      since: 10,
      forgotTyped: 1,
      byTyped: ['cf_keys |ABC'],
      forgotSpaced: 0,
      bySpaced: [],
      forgot: 2,
      byOwn: ['cf_keys|ABC', 'cf_keys|ABC'],
    },
    run: (db) =>
      withKeys(db, async () => {
        for (const [i, id] of ['ABC ', 'abc', 'ÀBC', 'ABC  '].entries()) {
          const row = await CfKey.create({ Id: id, Name: `other ${i}` });
          await tick();
          await row.destroy();
          await tick();
        }
        // The subject type is compared exactly too: an entity 'cf_keys ' is another subject.
        await audit().record({ kind: 'data', action: 'insert', subject: { type: 'cf_keys ', id: 'ABC' }, data: { after: { Id: 'ABC', Name: 'typed' } } }, { trail: 'history', mode: 'confirmed' });
        await tick();
        const before = new Date();
        await tick();
        const mine = await CfKey.create({ Id: 'ABC', Name: 'mine' });
        await tick();
        mine.Name = 'mine 2';
        await mine.update();
        await tick();
        const after = new Date();
        const ops = async (id: string): Promise<string[]> => (await CfKey.history().of(id)).map((e) => `${e.op}:${e.id}`);
        const typed = (await audit().trail('history').of({ type: 'cf_keys ', id: 'ABC' })).map((e) => `${String(e.subject?.type)}|${String(e.subject?.id)}`);
        const result = { own: await ops('ABC'), spaced: await ops('ABC '), before: stateOf(await CfKey.history().asOf('ABC', before)), ownAfter: stateOf(await CfKey.history().asOf('ABC', after)), spacedAfter: stateOf(await CfKey.history().asOf('ABC ', after)), typed, since: (await CfKey.history().since(0)).length };
        const rows = (): Promise<TrailRows> => trailRows(db.driver, trailConfig('history').table);
        const kept = await rows();
        const forgotTyped = await audit().trail('history').forget({ type: 'cf_keys ', id: 'ABC' });
        const afterTyped = await rows();
        const forgotSpaced = await CfKey.history().forget('ABC   ');
        const afterSpaced = await rows();
        const forgot = await CfKey.history().forget('ABC');
        const byOwn = changedRows(afterSpaced, await rows());
        return { ...result, forgotTyped, byTyped: changedRows(kept, afterTyped), forgotSpaced, bySpaced: changedRows(afterTyped, afterSpaced), forgot, byOwn };
      }),
  }),
  defineCase({
    name: 'history-exact-subject-one-spelling',
    seed: EMPTY,
    order: 'ordered',
    // An id stored in one spelling only, a numeric key and a uuid key read and erase as before the exact comparison.
    expected: { first: ['insert:1', 'update:1'], spacedNumber: [], second: ['insert:2'], uuid: [`insert:${UUID}`], forgotFirst: 2, forgotUuid: 1, secondKept: [false] },
    run: (db) =>
      withKeys(db, async () => {
        const first = await CfUser.create({ Name: 'first', Active: true });
        first.Name = 'first 2';
        await first.update();
        await CfUser.create({ Name: 'second', Active: true });
        await CfKey.create({ Id: UUID, Name: 'uuid' });
        const ops = async (id: string | number, read = historyOf(CfUser)): Promise<string[]> => (await read.of(id)).map((e) => `${e.op}:${e.id}`);
        return {
          first: await ops(1),
          spacedNumber: await ops('1 '),
          second: await ops(2),
          uuid: await ops(UUID, CfKey.history()),
          forgotFirst: await historyOf(CfUser).forget(1),
          forgotUuid: await CfKey.history().forget(UUID),
          secondKept: (await historyOf(CfUser).of(2)).map((e) => e.redacted),
        };
      }),
  }),
];
