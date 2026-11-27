/**
 * The write capture beside a concurrent writer: another session commits between the capture's key read and the
 * statement. A query middleware ordered after the capture's (91) holds the statement there while the other session
 * runs. The other session is a second sqlite3 handle on the same file, with no busy timeout: a statement that has to
 * wait for the transaction's lock fails at once with SQLITE_BUSY.
 */
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, Model, ModelBase, Orm, Primary, QueryMiddleware, SelectQueryBuilder, WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, IsolationLevel, QueryBuilder, WriteStatement } from '@spinajs/orm';
import '@spinajs/log';
import { expect } from 'chai';
import 'mocha';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import sqlite3 from 'sqlite3';

import { SqliteOrmDriver } from '../src/index.js';

const FILE = join(tmpdir(), `orm_capture_race_${randomUUID().slice(0, 8)}.sqlite`);

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
    this.Config.db = { ...(this.Config.db as object), Migration: { Startup: false }, StrictTableCheck: false, DefaultConnection: 'race', Connections: [{ Driver: 'orm-driver-sqlite', Name: 'race', Filename: FILE, Pool: { Max: 1 } }] };
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

/**
 * SQLite has one writer, so it is the control of finding OX15: with a rollback journal the transaction's read lock makes
 * the other session's write fail; in WAL mode the other session commits and the statement then fails, as its read
 * snapshot is no longer the latest (SQLITE_BUSY), and rolls back. Either way the capture never misses a row.
 */
function expected(journal: 'delete' | 'wal'): Outcome {
  if (journal === 'delete') return { other: 'SQLITE_BUSY', statement: 'ok', changed: ['1', '2'], captured: ['1', '2'] };
  return { other: 'committed', statement: 'SQLITE_BUSY', changed: [], captured: [] };
}

/** The SQLite error code of a driver error, looked up through OrmException's `inner` / `cause` chain. */
function codeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; typeof current === 'object' && current !== null && depth < 6; depth++) {
    if ('code' in current && typeof current.code === 'string' && current.code.startsWith('SQLITE_')) return current.code;
    current = 'inner' in current && current.inner !== undefined ? current.inner : 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

const driver = () => DI.get(Orm)!.Connections.get('race')!;
const sql = async (statement: string): Promise<void> => {
  await driver().schema().raw(statement);
};

describe('sqlite write capture beside a concurrent writer (integration)', function () {
  this.timeout(60000);

  const other = async (statement: string): Promise<string> => {
    const handle = new sqlite3.Database(FILE);
    try {
      await new Promise<void>((resolve, reject) => handle.run(statement, (err: Error | null) => (err ? reject(err) : resolve())));
      return 'committed';
    } catch (e) {
      return codeOf(e) ?? String(e);
    } finally {
      await new Promise<void>((resolve) => handle.close(() => resolve()));
    }
  };

  const race = async (statement: Statement, move: Move, isolation: IsolationLevel | undefined): Promise<Outcome> => {
    await sql('DELETE FROM race_item');
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
    DI.clearCache();
    DI.register(RaceConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(Recorder).as(WriteObserver);
    DI.register(Interleave).as(QueryMiddleware);
    await DI.resolve(Orm);
    await sql('CREATE TABLE race_item (Id INT PRIMARY KEY, Grp TEXT NOT NULL, Name TEXT NOT NULL)');
    await DI.get(Orm)!.reloadTableInfo();
  });

  after(async () => {
    await DI.get(Orm)?.Connections.get('race')?.disconnect();
    DI.unregister(Recorder);
    DI.unregister(Interleave);
    DI.clearCache();
    for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) rmSync(f, { force: true });
  });

  for (const journal of ['delete', 'wal'] as const) {
    describe(`journal mode ${journal}`, () => {
      before(() => sql(`PRAGMA journal_mode = ${journal}`));

      for (const isolation of [undefined, 'SERIALIZABLE'] as const) {
        for (const statement of ['update', 'delete'] as const) {
          for (const move of ['insert-into', 'update-into', 'update-out-of'] as const) {
            it(`${isolation ?? 'no caller transaction'}: ${statement}, a row moved ${move} the where: the capture reports the rows the statement changed, or the statement fails`, async () => {
              expect(await race(statement, move, isolation)).to.deep.eq(expected(journal));
            });
          }
        }
      }
    });
  }
});
