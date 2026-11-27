/**
 * The write capture beside a concurrent writer: another session commits between the capture's key read and the
 * statement. A query middleware ordered after the capture's (91) holds the statement there while the other session
 * runs; a statement of the other session that has to wait for a lock fails on its LOCK_TIMEOUT instead.
 *
 *   docker compose --profile test up -d mssql mssql-init
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryMiddleware, SelectQueryBuilder, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, IsolationLevel, QueryBuilder, WriteStatement } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import mssql from 'mssql';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { MsSqlOrmDriver } from '../src/index.js';

const SERVER = { Host: 'localhost', User: 'sa', Password: 'yourStrong(!)Password', Options: { TrustServerCertificate: true, Schema: 'dbo' } };
const DATABASE = process.env.ORM_TEST_MSSQL_CAPTURE_DATABASE ?? `orm_capture_race_${randomUUID().slice(0, 8)}`;

const session = (database: string): Promise<mssql.ConnectionPool> =>
  new mssql.ConnectionPool({ server: SERVER.Host, user: SERVER.User, password: SERVER.Password, database, pool: { max: 1 }, options: { trustServerCertificate: true } }).connect();

@Connection('race')
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

class RaceConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
    this.Config.db = { ...(this.Config.db as object), Migration: { Startup: false }, StrictTableCheck: false, DefaultConnection: 'race', Connections: [{ Driver: 'orm-driver-mssql', Name: 'race', ...SERVER, Database: DATABASE }] };
  }
}

type Move = 'insert-into' | 'update-into' | 'update-out-of';
type Statement = 'update' | 'delete';

const SEED = [1, 2, 3];
const OTHER = new Map<Move, string>([
  ['insert-into', "INSERT INTO race_item (Id, Grp, Name) VALUES (10, N'a', N'theirs')"],
  ['update-into', "UPDATE race_item SET Grp = N'a' WHERE Id = 3"],
  ['update-out-of', "UPDATE race_item SET Grp = N'b' WHERE Id = 2"],
]);

interface Outcome {
  /** `committed`, or the error number the other session's statement failed with. */
  readonly other: string;
  /** The error number or name the captured statement failed with, `ok` when it committed. */
  readonly statement: string;
  /** Ids of the rows the statement changed, read from the table after it. */
  readonly changed: string[];
  /** Ids of the rows the capture reports with a change, the rows history records and ancestors rebuild. */
  readonly captured: string[];
}

type Level = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * What a level does today with the other session's row. The key read takes no lock that lasts on SQL Server (its dialect
 * has no row lock clause), so a row may enter or leave the where under READ COMMITTED: the statement then changes a row
 * the capture never read, or the capture reports another session's change of a row the statement left (`gap`, finding
 * OX15). REPEATABLE READ keeps the rows read and SERIALIZABLE their range (`blocked`). Pinned as it is today, so a fix
 * changes these lines.
 */
type Today = 'blocked' | 'gap';

function todayOf(level: Level, move: Move): Today {
  if (level === 'SERIALIZABLE') return 'blocked';
  return level === 'REPEATABLE READ' && move === 'update-out-of' ? 'blocked' : 'gap';
}

const LOCK_REQUEST_TIMEOUT = '1222';

function expected(move: Move, today: Today): Outcome {
  const read = ['1', '2'];
  if (today === 'blocked') return { other: LOCK_REQUEST_TIMEOUT, statement: 'ok', changed: read, captured: read };
  if (move === 'update-out-of') return { other: 'committed', statement: 'ok', changed: ['1'], captured: read };
  return { other: 'committed', statement: 'ok', changed: [...read, move === 'insert-into' ? '10' : '3'], captured: read };
}

/** The SQL Server error number of a driver error, looked up through OrmException's `inner` / `cause` chain. */
function codeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; typeof current === 'object' && current !== null && depth < 6; depth++) {
    if ('number' in current && typeof current.number === 'number') return String(current.number);
    current = 'inner' in current && current.inner !== undefined ? current.inner : 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

const driver = () => DI.get(Orm)!.Connections.get('race')!;
const sql = async (statement: string): Promise<void> => {
  await driver().schema().raw(statement);
};

describe('mssql write capture beside a concurrent writer (integration)', function () {
  this.timeout(60000);

  const other = async (statement: string): Promise<string> => {
    const pool = await session(DATABASE);
    try {
      await pool.request().batch(`SET LOCK_TIMEOUT 1000; ${statement}`);
      return 'committed';
    } catch (e) {
      return codeOf(e) ?? String(e);
    } finally {
      await pool.close();
    }
  };

  const onMaster = async (statement: string): Promise<void> => {
    const pool = await session('master');
    try {
      await pool.request().batch(statement);
    } finally {
      await pool.close();
    }
  };

  const race = async (statement: Statement, move: Move, isolation: IsolationLevel | undefined): Promise<Outcome> => {
    await sql('TRUNCATE TABLE race_item');
    await sql("INSERT INTO race_item (Id, Grp, Name) VALUES (1, N'a', N'one'), (2, N'a', N'two'), (3, N'b', N'three')");
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
      if (isolation) await driver().transaction(write, { isolation });
      else await write();
    } catch (e) {
      result = codeOf(e) ?? (e instanceof Error ? e.name : String(e));
    }
    const rows = await driver().select<{ Id: number; Name: string }[]>().from('race_item').columns(['Id', 'Name']);
    const present = new Set(rows.map((r) => r.Id));
    const before = move === 'insert-into' && otherResult === 'committed' ? [...SEED, 10] : SEED;
    const changed = statement === 'update' ? rows.filter((r) => r.Name === 'mine').map((r) => r.Id) : before.filter((id) => !present.has(id));
    const captured = writes.flatMap((w) => w.rows.filter((r) => !isDeepStrictEqual(r.before, r.after)).map((r) => Number(r.id)));
    return { other: otherResult, statement: result, changed: changed.sort((a, b) => a - b).map(String), captured: captured.sort((a, b) => a - b).map(String) };
  };

  before(async () => {
    await onMaster(`CREATE DATABASE [${DATABASE}]`);

    DI.clearCache();
    DI.register(RaceConf).as(Configuration);
    DI.register(MsSqlOrmDriver).as('orm-driver-mssql');
    DI.register(Recorder).as(WriteObserver);
    DI.register(Interleave).as(QueryMiddleware);
    await DI.resolve(Orm);
    await sql('CREATE TABLE race_item (Id INT PRIMARY KEY, Grp NVARCHAR(8) NOT NULL, Name NVARCHAR(32) NOT NULL)');
    await DI.get(Orm)!.reloadTableInfo();
  });

  after(async () => {
    await DI.get(Orm)?.Connections.get('race')?.disconnect();
    DI.unregister(Recorder);
    DI.unregister(Interleave);
    DI.clearCache();
    await onMaster(`DROP DATABASE IF EXISTS [${DATABASE}]`);
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
        const what = today === 'gap' ? 'the capture reports other rows than the statement changed (OX15, as it is today)' : 'the capture reports the rows the statement changed';
        it(`${isolation ?? 'no caller transaction'}: ${statement}, a row moved ${move} the where: ${what}`, async () => {
          expect(await race(statement, move, isolation)).to.deep.eq(expected(move, today));
        });
      }
    }
  }
});
