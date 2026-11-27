/**
 * The write capture beside a concurrent writer: another session commits between the capture's key read and the
 * statement. A query middleware ordered after the capture's (91) holds the statement there while the other session
 * runs; a statement of the other session that has to wait for a lock fails on its innodb_lock_wait_timeout instead.
 *
 * Connection settings come from ORM_TEST_MYSQL_* (see README).
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryContext, QueryMiddleware, SelectQueryBuilder, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, IsolationLevel, QueryBuilder, WriteStatement } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { MySqlOrmDriver } from '../../src/index.js';

const SERVER = {
  Host: process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1',
  Port: Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306),
  User: process.env.ORM_TEST_MYSQL_USER ?? 'root',
  Password: process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root',
};
const DATABASE = process.env.ORM_TEST_MYSQL_CAPTURE_DATABASE ?? `orm_capture_race_${randomUUID().slice(0, 8)}`;

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
    this.Config.db = { ...(this.Config.db as object), Migration: { Startup: false }, StrictTableCheck: false, DefaultConnection: 'race', Connections: [{ Driver: 'orm-driver-mysql', Name: 'race', ...SERVER, Database: DATABASE }] };
  }
}

type Move = 'insert-into' | 'update-into' | 'update-out-of';
type Statement = 'update' | 'delete';

const SEED = [1, 2, 3];
const OTHER = new Map<Move, string>([
  ['insert-into', "INSERT INTO race_item (Id, Grp, Name) VALUES (10, 'a', 'theirs')"],
  ['update-into', "UPDATE race_item SET Grp = 'a' WHERE Id = 3"],
  ['update-out-of', "UPDATE race_item SET Grp = 'b' WHERE Id = 2"],
]);

interface Outcome {
  /** `committed`, or the error code the other session's statement failed with. */
  readonly other: string;
  /** The error code or name the captured statement failed with, `ok` when it committed. */
  readonly statement: string;
  /** Ids of the rows the statement changed, read from the table after it. */
  readonly changed: string[];
  /** Ids of the rows the capture reports with a change, the rows history records and ancestors rebuild. */
  readonly captured: string[];
}

type Level = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * What a level does today with the other session's row: the key read's locks make it wait (`blocked`; REPEATABLE READ
 * locks the gaps of the scanned range too), or the statement changes a row the capture never read (`gap`, finding
 * OX15: history, the ancestor table and change events miss that row). Pinned as it is today, so a fix changes these lines.
 */
type Today = 'blocked' | 'gap';

const todayOf = (level: Level, move: Move): Today => (level === 'READ COMMITTED' && move !== 'update-out-of' ? 'gap' : 'blocked');

function expected(move: Move, today: Today): Outcome {
  const read = ['1', '2'];
  if (today === 'blocked') return { other: 'ER_LOCK_WAIT_TIMEOUT', statement: 'ok', changed: read, captured: read };
  return { other: 'committed', statement: 'ok', changed: [...read, move === 'insert-into' ? '10' : '3'], captured: read };
}

/** The MySQL error code of a driver error, looked up through OrmException's `inner` / `cause` chain. */
function codeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; typeof current === 'object' && current !== null && depth < 6; depth++) {
    if ('code' in current && typeof current.code === 'string' && current.code.startsWith('ER_')) return current.code;
    current = 'inner' in current && current.inner !== undefined ? current.inner : 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

const driver = () => DI.get(Orm)!.Connections.get('race')!;
const sql = async (statement: string): Promise<void> => {
  await driver().schema().raw(statement);
};

describe('mysql write capture beside a concurrent writer (integration)', function () {
  this.timeout(60000);

  let admin: MySqlOrmDriver;
  let serverDefault = '';

  const other = async (statement: string): Promise<string> => {
    const connection = await mysql.createConnection({ host: SERVER.Host, port: SERVER.Port, user: SERVER.User, password: SERVER.Password, database: DATABASE });
    try {
      await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
      await connection.query(statement);
      return 'committed';
    } catch (e) {
      return codeOf(e) ?? String(e);
    } finally {
      await connection.end();
    }
  };

  const race = async (statement: Statement, move: Move, isolation: IsolationLevel | undefined): Promise<Outcome> => {
    await sql('TRUNCATE TABLE race_item');
    await sql("INSERT INTO race_item (Id, Grp, Name) VALUES (1, 'a', 'one'), (2, 'a', 'two'), (3, 'b', 'three')");
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
    admin = await DI.child().resolve(MySqlOrmDriver, [{ Name: 'race-admin', Driver: 'orm-driver-mysql', ...SERVER, Database: 'mysql' }]);
    await admin.connect();
    await admin.schema().createDatabase(DATABASE);

    DI.clearCache();
    DI.register(RaceConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    DI.register(Recorder).as(WriteObserver);
    DI.register(Interleave).as(QueryMiddleware);
    await DI.resolve(Orm);
    await sql('CREATE TABLE race_item (Id INT PRIMARY KEY, Grp VARCHAR(8) NOT NULL, Name VARCHAR(32) NOT NULL)');
    await DI.get(Orm)!.reloadTableInfo();
    const result = await admin.executeOnDb('SELECT @@GLOBAL.transaction_isolation AS level', [], QueryContext.Select);
    const first: unknown = Array.isArray(result) ? result[0] : undefined;
    serverDefault = typeof first === 'object' && first !== null && 'level' in first ? String(first.level) : '';
  });

  after(async () => {
    await DI.get(Orm)?.Connections.get('race')?.disconnect();
    DI.unregister(Recorder);
    DI.unregister(Interleave);
    DI.clearCache();
    await admin.executeOnDb(`DROP DATABASE IF EXISTS \`${DATABASE}\``, [], QueryContext.Schema);
    await admin.disconnect();
  });

  // Without a caller transaction the capture opens one at the server's default level: InnoDB's REPEATABLE READ.
  const LEVELS: readonly [IsolationLevel | undefined, Level][] = [
    [undefined, 'REPEATABLE READ'],
    ['READ COMMITTED', 'READ COMMITTED'],
    ['REPEATABLE READ', 'REPEATABLE READ'],
    ['SERIALIZABLE', 'SERIALIZABLE'],
  ];
  for (const [isolation, level] of LEVELS) {
    for (const statement of ['update', 'delete'] as const) {
      for (const move of ['insert-into', 'update-into', 'update-out-of'] as const) {
        const today = todayOf(level, move);
        const what = today === 'gap' ? 'the capture misses the row (OX15, as it is today)' : 'the capture reports the rows the statement changed';
        it(`${isolation ?? 'no caller transaction'}: ${statement}, a row moved ${move} the where: ${what}`, async function () {
          if (!isolation && serverDefault !== 'REPEATABLE-READ') return this.skip();

          expect(await race(statement, move, isolation)).to.deep.eq(expected(move, today));
        });
      }
    }
  }
});
