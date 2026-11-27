/**
 * The write capture beside a concurrent writer: another session commits between the capture's key read and the
 * statement. A query middleware ordered after the capture's (91) holds the statement there while the other session
 * runs; a statement of the other session that has to wait for a lock fails on its lock_timeout instead.
 */
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Primary, QueryMiddleware, SelectQueryBuilder, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, IsolationLevel, QueryBuilder, WriteStatement } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';

import { pgEscapeIdentifier } from '../../src/index.js';
import { CONNECTION, PG, openSuite, sqlState } from './harness.js';
import type { IPgSuite } from './harness.js';
import './migrations/PgRaceMigration_2026_11_27_00_00_00.js';

@Connection(CONNECTION)
@Model('race_item')
class RaceItem extends ModelBase {
  @Primary()
  public Id: number;

  public Grp: string;

  public Name: string;
}

const writes: CapturedWrite[] = [];
let interleave: (() => Promise<void>) | undefined;

class Recorder extends WriteObserver {
  interest({ model }: WriteStatement): CaptureInterest | undefined {
    return model === RaceItem ? { columns: '*', transactional: true } : undefined;
  }

  async observe(write: CapturedWrite): Promise<void> {
    writes.push(write);
  }
}

class Interleave extends QueryMiddleware {
  public order = 92;

  afterQueryCreation(): void {}

  async beforeQueryExecution(query: QueryBuilder): Promise<void> {
    const run = interleave;
    if (!run || query.Model !== RaceItem || query instanceof SelectQueryBuilder) return;
    interleave = undefined;
    await run();
  }
}

type Move = 'insert-into' | 'update-into' | 'update-out-of';
type Statement = 'update' | 'delete';

const SEED = [1, 2, 3];
const OTHER = new Map<Move, string>([
  ['insert-into', `INSERT INTO race_item ("Id", "Grp", "Name") VALUES (10, 'a', 'theirs')`],
  ['update-into', `UPDATE race_item SET "Grp" = 'a' WHERE "Id" = 3`],
  ['update-out-of', `UPDATE race_item SET "Grp" = 'b' WHERE "Id" = 2`],
]);

interface Outcome {
  /** `committed`, or the SQLSTATE the other session's statement failed with. */
  readonly other: string;
  /** The SQLSTATE or error name the captured statement failed with, `ok` when it committed. */
  readonly statement: string;
  /** Ids of the rows the statement changed, read from the table after it. */
  readonly changed: string[];
  /** Ids of the rows the capture reports with a change, the rows history records and ancestors rebuild. */
  readonly captured: string[];
}

type Level = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * What a level does today with the other session's row: the key read's lock makes it wait (`blocked`), the snapshot
 * hides it from the statement (`hidden`), or the statement changes a row the capture never read (`gap`, finding OX15:
 * history, the ancestor table and change events miss that row). Pinned as it is today, so a fix changes these lines.
 */
type Today = 'blocked' | 'hidden' | 'gap';

function todayOf(level: Level, move: Move): Today {
  if (move === 'update-out-of') return 'blocked';
  return level === 'READ COMMITTED' ? 'gap' : 'hidden';
}

function expected(move: Move, today: Today): Outcome {
  const read = ['1', '2'];
  if (today === 'blocked') return { other: '55P03', statement: 'ok', changed: read, captured: read };
  if (today === 'hidden') return { other: 'committed', statement: 'ok', changed: read, captured: read };
  return { other: 'committed', statement: 'ok', changed: [...read, move === 'insert-into' ? '10' : '3'], captured: read };
}

describe('postgres write capture beside a concurrent writer (integration)', function () {
  this.timeout(60000);
  let suite: IPgSuite;

  const other = async (sql: string): Promise<string> => {
    const client = new pg.Client({ host: PG.Host, port: PG.Port, user: PG.User, password: PG.Password, database: PG.Database });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${pgEscapeIdentifier(suite.schema)}`);
      await client.query(`SET lock_timeout = '1s'`);
      await client.query(sql);
      return 'committed';
    } catch (e) {
      return sqlState(e) ?? String(e);
    } finally {
      await client.end();
    }
  };

  const race = async (statement: Statement, move: Move, isolation: IsolationLevel | undefined): Promise<Outcome> => {
    await suite.reset('race_item');
    await suite.raw(`INSERT INTO race_item ("Id", "Grp", "Name") VALUES (1, 'a', 'one'), (2, 'a', 'two'), (3, 'b', 'three')`);
    writes.length = 0;
    let otherResult = 'not run';
    interleave = async () => {
      otherResult = await other(OTHER.get(move) ?? '');
    };
    const write = async () => {
      if (statement === 'update') await RaceItem.update({ Name: 'mine' }).where('Grp', 'a');
      else await RaceItem.destroy().where('Grp', 'a');
    };
    let result = 'ok';
    try {
      if (isolation) await suite.driver.transaction(write, { isolation });
      else await write();
    } catch (e) {
      result = sqlState(e) ?? (e instanceof Error ? e.name : String(e));
    }
    const rows = await suite.raw<{ Id: number; Name: string }[]>('SELECT "Id", "Name" FROM race_item ORDER BY "Id"');
    const present = new Set(rows.map((r) => r.Id));
    const before = move === 'insert-into' && otherResult === 'committed' ? [...SEED, 10] : SEED;
    const changed = statement === 'update' ? rows.filter((r) => r.Name === 'mine').map((r) => r.Id) : before.filter((id) => !present.has(id));
    const captured = writes.flatMap((w) => w.rows.filter((r) => !isDeepStrictEqual(r.before, r.after)).map((r) => Number(r.id)));
    return { other: otherResult, statement: result, changed: changed.sort((a, b) => a - b).map(String), captured: captured.sort((a, b) => a - b).map(String) };
  };

  before(async function () {
    suite = await openSuite(this, { name: 'race', pool: { Max: 4 } });
    DI.register(Recorder).as(WriteObserver);
    DI.register(Interleave).as(QueryMiddleware);
    DI.uncache(Array.ofType(QueryMiddleware));
  });

  after(async () => {
    DI.unregister(Recorder);
    DI.unregister(Interleave);
    DI.uncache(Array.ofType(QueryMiddleware));
    await suite?.close();
  });

  // Without a caller transaction the capture opens one at the server's default level, READ COMMITTED.
  const LEVELS: readonly [IsolationLevel | undefined, Level][] = [
    [undefined, 'READ COMMITTED'],
    ['READ COMMITTED', 'READ COMMITTED'],
    ['REPEATABLE READ', 'REPEATABLE READ'],
    ['SERIALIZABLE', 'SERIALIZABLE'],
  ];
  for (const [isolation, level] of LEVELS) {
    for (const statement of ['update', 'delete'] as const) {
      for (const move of ['insert-into', 'update-into', 'update-out-of'] as const) {
        const today = todayOf(level, move);
        const what = today === 'gap' ? 'the capture misses the row (OX15, as it is today)' : 'the capture reports the rows the statement changed';
        it(`${isolation ?? 'no caller transaction'}: ${statement}, a row moved ${move} the where: ${what}`, async () => {
          expect(await race(statement, move, isolation)).to.deep.eq(expected(move, today));
        });
      }
    }
  }
});
