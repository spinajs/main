import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, DataException, InvalidCursor, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class PgliteKeysetConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: 'pglite', Filename: ':memory:', Migration: { OnStartup: false } }] },
    });
  }
}

@Connection('pglite')
@Model('pgl_keyset')
class PglKeyset extends ModelBase {
  @Primary()
  public Id: number;

  public Score: number;

  public Name: string;
}

@Connection('pglite')
@Model('pgl_keyset_mood')
class PglMood extends ModelBase {
  @Primary()
  public Id: number;

  public Mood: string;
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) {
      return err;
    }
    throw err;
  }
  throw new Error('expected a rejection');
}

function withFirstValue(cursor: string, value: unknown): string {
  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { h: string; v: unknown[] };
  payload.v[0] = value;
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('paginate() on PGlite', function () {
  this.timeout(60000);

  let orm: Orm | undefined;

  before(async () => {
    DI.clearCache();
    DI.register(PgliteKeysetConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    orm = await DI.resolve(Orm);
    const driver = orm.Connections.get('pglite') as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_keyset ("Id" int PRIMARY KEY, "Score" int NOT NULL, "Name" text NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_keyset ("Id", "Score", "Name") SELECT g, g % 4, 'n' || (g % 3) FROM generate_series(1, 10) g`, [], QueryContext.Insert);
    await driver.executeOnDb(`CREATE TYPE pgl_mood AS ENUM ('calm', 'busy')`, [], QueryContext.Schema);
    await driver.executeOnDb('CREATE TABLE pgl_keyset_mood ("Id" int PRIMARY KEY, "Mood" pgl_mood NOT NULL)', [], QueryContext.Schema);
    await driver.executeOnDb(`INSERT INTO pgl_keyset_mood ("Id", "Mood") VALUES (1, 'calm'), (2, 'busy'), (3, 'calm')`, [], QueryContext.Insert);
    await orm.reloadTableInfo();
  });

  after(async () => {
    await orm?.dispose();
    DI.unregister(PgliteKeysetConf);
    DI.clearCache();
  });

  async function walk(page: (after: string | undefined) => Promise<{ items: Array<{ Id: number }>; next: string | null }>): Promise<number[]> {
    const ids: number[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const current = await page(after);
      ids.push(...current.items.map((i) => i.Id));
      if (current.next === null) {
        return ids;
      }
      after = current.next;
    }
    throw new Error('the walk did not end within 20 pages');
  }

  async function sortedIds(column: 'Score' | 'Name'): Promise<number[]> {
    return (await PglKeyset.select().orderByDescending(column).order('Id')).map((i) => i.Id);
  }

  it('walks an int and a text order column', async () => {
    expect(await walk((after) => PglKeyset.select().paginate({ orderBy: [['Score', 'desc']], limit: 3, after }))).to.deep.equal(await sortedIds('Score'));
    expect(await walk((after) => PglKeyset.select().paginate({ orderBy: [['Name', 'desc']], limit: 4, after }))).to.deep.equal(await sortedIds('Name'));
  });

  it('refuses a cursor value an int column cannot hold with InvalidCursor, never a SQL error', async () => {
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });

    for (const value of ['abc', 1.5, true, 2 ** 40, { $d: '2020-01-01' }, { $b: '99999999999999999999999' }, 'x'.repeat(2 * 1024 * 1024)]) {
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: withFirstValue(next!, value) }), JSON.stringify(value).slice(0, 40)).to.be.rejectedWith(InvalidCursor);
    }
  });

  it('refuses a number for a text order column', async () => {
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Name', 'asc']], limit: 1 });

    await expect(PglKeyset.select().paginate({ orderBy: [['Name', 'asc']], limit: 1, after: withFirstValue(next!, 5) })).to.be.rejectedWith(InvalidCursor);
  });

  it('adds the order columns to a narrowed select and walks every page', async () => {
    const ids = await walk((after) => PglKeyset.query().select('Id').paginate({ orderBy: [['Score', 'desc']], limit: 3, after }));

    expect(ids).to.deep.equal(await sortedIds('Score'));
  });

  it('turns a cursor value the column refuses into InvalidCursor', async () => {
    const { next } = await PglMood.select().paginate({ orderBy: [['Mood', 'asc']], limit: 1 });

    // a string fits the enum family, but the postgres enum has no such label: SQLSTATE 22P02, for the page and for the probe
    const err = await rejectionOf(PglMood.select().paginate({ orderBy: [['Mood', 'asc']], limit: 1, after: withFirstValue(next!, 'sleepy') }));

    expect(err).to.be.instanceOf(InvalidCursor);
    expect(err.message).to.not.contain('sleepy');
    expect(err.cause).to.be.instanceOf(DataException);
  });

  it('keeps a data error of the query itself, with a valid cursor as without one', async () => {
    const { next } = await PglMood.select().paginate({ orderBy: [['Id', 'asc']], limit: 1 });

    // the filter value is refused (22P02), the cursor is fine: the same error on the first page and on the next
    await expect(PglMood.where('Mood', 'sleepy').paginate({ orderBy: [['Id', 'asc']], limit: 1 })).to.be.rejectedWith(DataException);
    await expect(PglMood.where('Mood', 'sleepy').paginate({ orderBy: [['Id', 'asc']], limit: 1, after: next! })).to.be.rejectedWith(DataException);
  });

  it('asks the database about the cursor alone before it blames the cursor', async () => {
    const driver = orm!.Connections.get('pglite')!;
    const { next } = await PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });
    const execute = sinon.stub(driver, 'execute').callThrough();
    execute.onFirstCall().rejects(new DataException('value out of range'));
    try {
      // the page fails, the probe of the keyset predicate runs for real and is accepted
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: next! })).to.be.rejectedWith(DataException);
      expect(execute.callCount).to.eq(2);
    } finally {
      execute.restore();
    }
  });

  it('keeps a data error of a page without a cursor as it is, without a probe', async () => {
    const driver = orm!.Connections.get('pglite')!;
    const execute = sinon.stub(driver, 'execute').rejects(new DataException('value out of range'));
    try {
      await expect(PglKeyset.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 })).to.be.rejectedWith(DataException);
      expect(execute.callCount).to.eq(1);
    } finally {
      execute.restore();
    }
  });
});
