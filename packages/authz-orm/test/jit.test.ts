import * as chai from 'chai';
import 'mocha';
import { randomBytes } from 'node:crypto';

import { AUTHZ_CONFIGURATION_SCHEMA, AuthorizationModel, AuthzConfigError, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { StaticModel, bindConfiguration, bootConfiguration, testHost } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { BelongsTo, ModelBase, QueryContext, updateModelDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';

import { OrmAuthzContributor } from '../src/contributor.js';
import { AUTHZ_ORM_CONFIGURATION_SCHEMA, Owner, registerAccessResource } from '../src/index.js';
import { unregisterResource } from '../src/registry.js';
import { POSTGRES, TestDb } from './support/db.js';
import type { Dialect } from './support/db.js';

const expect = chai.expect;

const alice: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'test', attributes: {} };
const ROWS = [
  { id: 'i1', owner: 'alice' },
  { id: 'i2', owner: 'bob' },
];

const fixes = (name: string, role: string, database: string) => `authz-orm: Postgres connection "${name}" runs with jit = on, which makes authorized lists take seconds; run ALTER ROLE "${role}" SET jit = off or ALTER DATABASE "${database}" SET jit = off, or start the process with PGOPTIONS='-c jit=off', or set authz.orm.allowJit: true to accept slow lists`;

interface FakeDriver {
  readonly driver: OrmDriver;
  /** The statements the check ran. */
  readonly calls: string[];
  /** What the next SHOW answers: a value of jit, no row (null), or an error it rejects with. */
  answer: string | null | Error;
}

function fakeDriver(answer: string | null | Error, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): FakeDriver {
  const fake: FakeDriver = {
    calls: [],
    answer,
    driver: {
      Options: { Driver: 'orm-driver-postgres', Name: 'pg1', User: 'app', Database: 'appdb', ...options },
      ...extra,
      schema: () => ({
        raw: (sql: string) => {
          fake.calls.push(sql);
          if (fake.answer instanceof Error) return Promise.reject(fake.answer);
          return Promise.resolve(fake.answer === null ? [] : [{ jit: fake.answer }]);
        },
      }),
    } as unknown as OrmDriver,
  };
  return fake;
}

const failure = (p: unknown): Promise<unknown> =>
  Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );

describe('authz-orm: the Postgres jit check', function () {
  this.timeout(30000);
  const made: Function[] = [];
  const children: IContainer[] = [];
  let seq = 0;

  afterEach(async () => {
    for (const c of made.splice(0)) unregisterResource(c);
    for (const c of children.splice(0)) await c.dispose();
  });

  const modelOn = (driver: OrmDriver): Function => {
    const name = `JitModel${++seq}`;
    const cls = { [name]: class extends ModelBase {} }[name];
    registerAccessResource(cls as never, `jit-${seq}`);
    updateModelDescriptor(cls, (d) => {
      d.Driver = driver;
    });
    made.push(cls);
    return cls;
  };

  async function contributor(orm: Record<string, unknown> = {}): Promise<OrmAuthzContributor> {
    const { child } = await bootConfiguration({ authz: { orm } }, [AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_ORM_CONFIGURATION_SCHEMA]);
    children.push(child);
    return bindConfiguration(new OrmAuthzContributor(), child);
  }

  it('fails the boot with jit on, naming the connection and the fixes', async () => {
    const pg = fakeDriver('on');
    modelOn(pg.driver);

    const e = await failure((await contributor()).contribute());

    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.equal(fixes('pg1', 'app', 'appdb'));
    expect(pg.calls).to.deep.equal(['SHOW jit']);
  });

  it('passes with jit off', async () => {
    const pg = fakeDriver('off');
    modelOn(pg.driver);

    const out = await (await contributor()).contribute();

    expect(out.joinTypes).to.be.an('array');
    expect(pg.calls).to.deep.equal(['SHOW jit']);
  });

  it('runs no SHOW with authz.orm.allowJit true', async () => {
    const pg = fakeDriver('on');
    modelOn(pg.driver);

    await (await contributor({ allowJit: true })).contribute();

    expect(pg.calls).to.deep.equal([]);
  });

  it('asks each driver once, however many models and boots use it', async () => {
    const pg = fakeDriver('off');
    modelOn(pg.driver);
    modelOn(pg.driver);
    const c = await contributor();

    await c.contribute();
    await c.contribute();
    await (await contributor()).contribute();

    expect(pg.calls).to.deep.equal(['SHOW jit']);
  });

  it('keeps refusing a driver with jit on without asking again', async () => {
    const pg = fakeDriver('on');
    modelOn(pg.driver);
    const c = await contributor();

    expect(await failure(c.contribute())).to.be.instanceOf(AuthzConfigError);
    pg.answer = 'off';
    expect(await failure(c.contribute())).to.be.instanceOf(AuthzConfigError);
    expect(pg.calls).to.have.length(1);
  });

  it('does not keep a failed SHOW: it rethrows, and the next boot asks again', async () => {
    const down = new Error('connect ECONNREFUSED');
    const pg = fakeDriver(down);
    modelOn(pg.driver);
    const c = await contributor();

    expect(await failure(c.contribute())).to.equal(down);
    pg.answer = 'off';
    await c.contribute();

    expect(pg.calls).to.deep.equal(['SHOW jit', 'SHOW jit']);
  });

  it('names a connection without a Name without printing undefined', async () => {
    const pg = fakeDriver('on', { Name: undefined });
    modelOn(pg.driver);

    const e = await failure((await contributor()).contribute());

    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message)
      .to.contain('runs with jit = on')
      .and.not.contain('undefined');
  });

  for (const [what, answer] of [
    ['no row', null],
    ['another value', 'auto'],
  ] as const) {
    it(`fails closed when SHOW jit answers ${what}`, async () => {
      const pg = fakeDriver(answer);
      modelOn(pg.driver);

      const e = await failure((await contributor()).contribute());

      expect(e).to.be.instanceOf(AuthzConfigError);
      expect((e as Error).message).to.contain('could not read jit on Postgres connection "pg1"');
    });
  }

  it('runs nothing on a SQLite driver', async () => {
    const sqlite = fakeDriver('on', { Driver: 'orm-driver-sqlite' });
    modelOn(sqlite.driver);

    await (await contributor()).contribute();

    expect(sqlite.calls).to.deep.equal([]);
  });

  it('leaves a disconnected driver to its first query', async () => {
    const closed = fakeDriver('on', {}, { State: 'disconnected' });
    modelOn(closed.driver);

    await (await contributor()).contribute();

    expect(closed.calls).to.deep.equal([]);
  });
});

/** Cases on the authz domain and the orm's real query path; `Invoice` lives on `dialect`, scoped by owner. */
function invoiceWorld(dialect: () => Dialect) {
  let db: TestDb;
  const undo: (() => void | Promise<void>)[] = [];
  let domainSeq = 0;
  const TYPE = `jitinvoice${randomBytes(2).toString('hex')}`;

  const setConfig = (path: string[], value: unknown) => {
    const config = testHost.config();
    const before = config.get<unknown>(path);
    config.set(path, value);
    undo.push(() => (before === undefined ? config.unset(path) : config.set(path, before)));
  };

  type Invoice = typeof ModelBase & { query(): PromiseLike<ModelBase[]> & object };

  const world = {
    get db() {
      return db;
    },
    setDb(d: TestDb) {
      db = d;
    },
    setConfig,
    async defineInvoice(): Promise<Invoice> {
      return (await db.define(
        {
          name: 'JitInvoice',
          columns: { owner: 'TEXT' },
          rows: ROWS,
          decorate: (cls, proto) => {
            Owner()(proto, 'owner');
            registerAccessResource(cls as never, TYPE);
          },
        },
        dialect(),
      )) as Invoice;
    },
    /** A plain model whose `invoice` relation reads the scoped Invoice. */
    async defineNote(Invoice: Invoice): Promise<Invoice> {
      return (await db.define(
        {
          name: 'JitNote',
          columns: { invoice_id: 'TEXT' },
          rows: [{ id: 'n1', invoice_id: 'i1' }],
          decorate: (_cls, proto) => BelongsTo(Invoice as never, 'invoice_id', 'id')(proto, 'invoice'),
        },
        dialect(),
      )) as Invoice;
    },
    /** Boots a new domain under root that reads TYPE through owner, and points authz.orm.domain at it. */
    async boot(): Promise<void> {
      const ds = await testHost.domains();
      const name = `jit${++domainSeq}`;
      const permissions = Object.fromEntries(['read', 'create', 'update', 'delete'].map((a) => [`${TYPE}:${a}`, { types: [TYPE] }]));
      setConfig(['authz', 'domains', name], { permissions, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] } }, cache: { maxEntries: 0 } });
      setConfig(['authz', 'orm', 'domain'], name);
      const container: IContainer = ds.create(name, 'root');
      undo.push(() => (ds.names().includes(name) ? container.dispose() : undefined));
      container.register(testHost.instance(new StaticModel({ name: 'm1', votes: { [`${TYPE}:read`]: { permitWhen: { op: 'relation', relation: 'owner' } } } }))).as(AuthorizationModel);
      await ds.service(name);
    },
    async cleanup(): Promise<void> {
      for (const fn of undo.splice(0).reverse()) await fn();
      await db?.clear();
    },
  };
  return world;
}

const ids = (rows: ModelBase[]) => rows.map((r) => (r as unknown as { id: string }).id).sort();

describe('authz-orm: the jit check at the first scoped query', function () {
  this.timeout(60000);
  const world = invoiceWorld(() => 'sqlite');

  before(async () => {
    world.setDb(await TestDb.open());
    await (await testHost.domains()).service('root');
  });

  after(async () => {
    await world.db?.close();
  });

  afterEach(() => world.cleanup());

  /** A Postgres connection the domain boot never saw: the sqlite driver under another name, answering SHOW itself. */
  function lateDriver(answer: string): FakeDriver {
    const sqlite = world.db.driver('sqlite');
    const fake = fakeDriver(answer, { Name: 'pg-late' });
    const driver = Object.create(sqlite, {
      Options: { value: { ...sqlite.Options, ...(fake.driver as unknown as { Options: object }).Options } },
      schema: { value: (fake.driver as unknown as { schema: unknown }).schema },
    }) as OrmDriver;
    return Object.assign(fake, { driver });
  }

  /** The query `build` makes, run as alice with `driver` as the connection the middleware sees; it runs on sqlite. */
  const listOf = (build: () => object, driver: OrmDriver) =>
    runWithPrincipal(alice, async () => {
      const q = build();
      Object.defineProperty(q, 'Driver', { value: driver });
      return ids((await (q as PromiseLike<ModelBase[]>)) as ModelBase[]);
    });

  const list = (Invoice: { query(): object }, driver: OrmDriver) => listOf(() => Invoice.query(), driver);

  /** The builders `fn` sends to the sqlite connection. */
  async function executedBy(fn: () => Promise<void>): Promise<unknown[]> {
    const sqlite = world.db.driver('sqlite') as unknown as { execute(b: unknown): Promise<unknown> };
    const executed: unknown[] = [];
    sqlite.execute = function (this: unknown, b: unknown) {
      executed.push(b);
      return Object.getPrototypeOf(sqlite).execute.call(this, b);
    };
    try {
      await fn();
    } finally {
      delete (sqlite as { execute?: unknown }).execute;
    }
    return executed;
  }

  const refusedForJit = (e: unknown) => {
    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.contain('Postgres connection "pg-late" runs with jit = on');
  };

  it('refuses a scoped query on a driver with jit on before it runs, and every later one', async () => {
    const Invoice = await world.defineInvoice();
    await world.boot();
    const pg = lateDriver('on');

    const executed = await executedBy(async () => {
      for (let i = 0; i < 2; i++) refusedForJit(await failure(list(Invoice, pg.driver)));
    });

    expect(pg.calls).to.deep.equal(['SHOW jit']);
    expect(executed).to.deep.equal([]);
  });

  it('refuses a plain query that populates a scoped relation on a driver with jit on, before it runs', async () => {
    const Invoice = await world.defineInvoice();
    const Note = await world.defineNote(Invoice);
    await world.boot();
    const pg = lateDriver('on');

    const executed = await executedBy(async () => {
      refusedForJit(await failure(listOf(() => (Note.query() as unknown as { populate(r: string): object }).populate('invoice'), pg.driver)));
    });

    expect(pg.calls).to.deep.equal(['SHOW jit']);
    expect(executed).to.deep.equal([]);
  });

  it('runs no SHOW for a plain query that reaches no scoped model', async () => {
    const Invoice = await world.defineInvoice();
    const Note = await world.defineNote(Invoice);
    await world.boot();
    const pg = lateDriver('on');

    expect(await listOf(() => Note.query(), pg.driver)).to.deep.equal(['n1']);
    expect(pg.calls).to.deep.equal([]);
  });

  it('asks once for two first queries at the same time, and refuses both', async () => {
    const Invoice = await world.defineInvoice();
    await world.boot();
    const pg = lateDriver('on');

    const [a, b] = await Promise.all([failure(list(Invoice, pg.driver)), failure(list(Invoice, pg.driver))]);

    refusedForJit(a);
    refusedForJit(b);
    expect(pg.calls).to.deep.equal(['SHOW jit']);
  });

  it('refuses jit on when authz.orm.allowJit is truthy but not true', async () => {
    const Invoice = await world.defineInvoice();
    await world.boot();
    // The root config's set skips the schema, as an unvalidated config source would.
    world.setConfig(['authz', 'orm', 'allowJit'], 'true');
    const pg = lateDriver('on');

    refusedForJit(await failure(list(Invoice, pg.driver)));
  });

  it('lists on a driver with jit off and asks once across the boot and many queries', async () => {
    const Invoice = await world.defineInvoice();
    const pg = lateDriver('off');
    const own = world.db.driver('sqlite');
    // The boot sees the model on the fake connection; the queries compile for sqlite, where the table is.
    updateModelDescriptor(Invoice, (d) => {
      d.Driver = pg.driver;
    });
    await world.boot();
    updateModelDescriptor(Invoice, (d) => {
      d.Driver = own;
    });
    expect(pg.calls).to.deep.equal(['SHOW jit']);

    for (let i = 0; i < 5; i++) expect(await list(Invoice, pg.driver)).to.deep.equal(['i1']);
    expect(pg.calls).to.deep.equal(['SHOW jit']);
  });

  it('lists on a driver with jit on when authz.orm.allowJit is true, without a SHOW', async () => {
    const Invoice = await world.defineInvoice();
    await world.boot();
    world.setConfig(['authz', 'orm', 'allowJit'], true);
    const pg = lateDriver('on');

    expect(await list(Invoice, pg.driver)).to.deep.equal(['i1']);
    expect(pg.calls).to.deep.equal([]);
  });
});

describe('authz-orm: the jit check on a real Postgres database', function () {
  this.timeout(120000);
  const world = invoiceWorld(() => 'postgres');
  let admin: OrmDriver | undefined;
  let database: string | undefined;

  before(async function () {
    if (!(await TestDb.postgresReachable())) {
      if (process.env.L2_REQUIRE_PG === '1') throw new Error(`L2_REQUIRE_PG=1 but Postgres at ${POSTGRES.Host}:${POSTGRES.Port} is unreachable`);
      console.warn(`      Postgres at ${POSTGRES.Host}:${POSTGRES.Port} is unreachable, suite skipped (set L2_REQUIRE_PG=1 to fail instead)`);
      this.skip();
    }
    admin = (await DI.child().resolve(PostgresOrmDriver, [{ Name: 'authz-orm-jit-admin', Driver: 'orm-driver-postgres', ...POSTGRES, Pool: { Max: 1, AcquireTimeout: 15000 } }])) as OrmDriver;
    await admin.connect();
  });

  after(async () => {
    await admin?.disconnect();
  });

  const run = (sql: string) => (admin as unknown as { executeOnDb(s: string, p: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Schema);

  /** A throwaway database with this jit setting, the orm connected to it as 'postgres'; never the shared one. */
  async function openWith(jit: 'on' | 'off'): Promise<void> {
    database = `authz_orm_jit_${randomBytes(4).toString('hex')}`;
    await run(`CREATE DATABASE "${database}"`);
    await run(`ALTER DATABASE "${database}" SET jit = ${jit}`);
    world.setDb(await TestDb.open({ postgres: true, database }));
  }

  afterEach(async () => {
    await world.cleanup();
    await world.db?.close();
    world.setDb(undefined as never);
    if (database) await run(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    database = undefined;
  });

  it('fails the domain boot with jit on', async () => {
    await openWith('on');
    await world.defineInvoice();

    const e = await failure(world.boot());

    expect(e).to.be.instanceOf(AuthzConfigError);
    expect((e as Error).message).to.contain(fixes('postgres', POSTGRES.User, database!));
  });

  it('lists with jit off', async () => {
    await openWith('off');
    const Invoice = await world.defineInvoice();
    await world.boot();

    expect(ids(await runWithPrincipal(alice, async () => (await Invoice.query()) as ModelBase[]))).to.deep.equal(['i1']);
  });

  it('lists with jit on when authz.orm.allowJit is true', async () => {
    await openWith('on');
    world.setConfig(['authz', 'orm', 'allowJit'], true);
    const Invoice = await world.defineInvoice();
    await world.boot();

    expect(ids(await runWithPrincipal(alice, async () => (await Invoice.query()) as ModelBase[]))).to.deep.equal(['i1']);
  });
});
