// 2.x baseline: ORM select through RbacModelPermissionMiddleware on SQLite in-memory.
// Setup mirrors packages/users/test/orm-rbac.test.ts. Imports the 2.x sources directly (bench/ is
// outside the published package, so the "no users* dependency in authz*" rule does not apply).
import { AsyncLocalStorage } from 'node:async_hooks';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Connection, ICompilerOutput, IDriverOptions, Migration, Model, ModelBase, Orm, OrmDriver, OrmMigration, Primary } from '@spinajs/orm';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User } from '../../../users/src/index.js';
import { OrmResource, ResourceOwner } from '../../../users/src/decorators.js';
import type { IRbacAsyncStorage } from '../../../users/src/interfaces.js';
import type { Scenario } from '../lib.js';

const ROWS = 1_000;
const OWNERS = 10;
const OWN_USER_ID = 1;
const ANY_USER_ID = 2;

@Connection('default')
@Model('bench_doc')
@OrmResource('BenchDoc')
class BenchDoc extends ModelBase {
  @Primary()
  public Id: number;

  @ResourceOwner()
  public UserId: number;

  public Value: string;
}

@Migration('default')
export class BenchDocMigration_2026_10_02_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver<IDriverOptions>): Promise<void> {
    await connection.schema().createTable('bench_doc', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.int('UserId');
      table.string('Value');
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  public async down(): Promise<void> {}

  public async data() {
    for (let i = 0; i < ROWS; i++) {
      await new BenchDoc({ UserId: (i % OWNERS) + 1, Value: `value-${i}` } as Partial<BenchDoc>).insert();
    }
  }
}

class BenchConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'info', target: 'Empty' }],
      },
      rbac: {
        grants: {
          'bench-own': { BenchDoc: { 'read:own': ['*'] } },
          'bench-any': { BenchDoc: { 'read:any': ['*'] } },
        },
      },
      db: {
        DefaultConnection: 'sqlite',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'sqlite',
            Migration: { Table: 'orm_migrations', OnStartup: true },
          },
        ],
      },
    };
  }
}

function fakeUser(id: number, roles: string[]): User {
  const user = Object.create(User.prototype) as User;
  (user as { Id: number }).Id = id;
  (user as { Role: string[] }).Role = roles;
  return user;
}

const ownUser = fakeUser(OWN_USER_ID, ['bench-own']);
const anyUser = fakeUser(ANY_USER_ID, ['bench-any']);

let store: AsyncLocalStorage<IRbacAsyncStorage>;
let ready: Promise<void> | undefined;

/** Shared by all scenarios in this file; first setup() boots DI + ORM, later ones reuse it. */
function boot(): Promise<void> {
  ready ??= (async () => {
    DI.clearCache();
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(BenchConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, []]);
    await DI.resolve(Orm);
    store = DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<IRbacAsyncStorage>;
  })();
  return ready;
}

const skip = (): IRbacAsyncStorage => ({ User: ownUser, SkipModelPermissionCheck: true });
const asOwn = (): IRbacAsyncStorage => ({ User: ownUser });
const asAny = (): IRbacAsyncStorage => ({ User: anyUser });

const list = () => BenchDoc.where('Id', '>', 0).take(50);
// Id 11 is row i = 10, owned by user 1 (UserId = i % OWNERS + 1), so every context returns it.
const point = () => BenchDoc.where('Id', 11);

const list_ = { setup: boot, iterations: 4_000, warmup: 500 };
const point_ = { setup: boot, iterations: 10_000, warmup: 1_000 };
const build = { setup: boot, iterations: 50_000, warmup: 5_000 };

type Ctx = () => IRbacAsyncStorage | undefined;
type Op = () => Promise<unknown> | unknown;
type Check = (ctx: string, result: unknown) => void;

const contexts: [string, Ctx, string][] = [
  ['nostore', () => undefined, 'no ALS store at all: the middleware returns at its first check; the baseline without ALS'],
  ['nouser', () => ({}), 'ALS store without a user: middleware returns at !User; baseline that includes the ALS cost'],
  ['skip', skip, 'SkipModelPermissionCheck set (middleware enters, applies nothing)'],
  ['read-any', asAny, 'read:any user (two grant probes, no WHERE added)'],
  ['read-own', asOwn, 'read:own user (two grant probes + owner WHERE)'],
];

function family(kind: string, desc: string, opts: { setup: () => Promise<void>; iterations: number; warmup: number }, op: Op, check: Check): Scenario[] {
  return contexts.map(([ctx, make, what]) => {
    const run = () => {
      const s = make();
      return s ? store.run(s, op) : op();
    };
    return {
      ...opts,
      name: `orm.${kind}.${ctx}`,
      description: `${desc}; ${what}`,
      compare: ctx === 'nostore' ? undefined : ctx === 'nouser' ? `orm.${kind}.nostore` : `orm.${kind}.nouser`,
      verify: async () => check(ctx, await run()),
      run,
    };
  });
}

function fail(message: string): never {
  throw new Error(message);
}

const rows = (r: unknown) => (r as BenchDoc[]);
const ownedRows = new Set(['read-own']);

let sink = 0;

const scenarios: Scenario[] = [
  // Query construction only (no SQL execution): isolates the middleware's own cost.
  ...family(
    'build',
    'build a 50-row list select',
    build,
    () => (list().toDB() as ICompilerOutput).expression!,
    (ctx, sql) => {
      sink += (sql as string).length;
      if ((sql as string).includes('UserId') !== ownedRows.has(ctx)) {
        fail(`${ctx}: owner predicate ${ownedRows.has(ctx) ? 'missing from' : 'present in'} the SQL: ${sql as string}`);
      }
    },
  ),
  // Full round trip on the 1,000-row table.
  ...family(
    'list',
    'select 50 of 1,000 rows (read:own: 50 of the 100 owned rows)',
    list_,
    async () => await list(),
    (ctx, r) => {
      const got = rows(r);
      if (got.length !== 50) {
        fail(`${ctx}: ${got.length} rows, expected 50`);
      }
      if (ownedRows.has(ctx) && got.some((d) => d.UserId !== OWN_USER_ID)) {
        fail(`${ctx}: returned a row not owned by user ${OWN_USER_ID}`);
      }
    },
  ),
  ...family(
    'point',
    'select one row by Id (row 11, owned by the read:own user)',
    point_,
    async () => await point().first(),
    (ctx, r) => {
      const row = r as BenchDoc | undefined;
      if (row?.Id !== 11) {
        fail(`${ctx}: expected row 11, got ${JSON.stringify(row)}`);
      }
    },
  ),
];

export default scenarios;
export { sink };
