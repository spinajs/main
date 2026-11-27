import { createHash } from 'node:crypto';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { Connection, InvalidCursor, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import sinon from 'sinon';
import { PgliteOrmDriver } from '../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const CONNECTION = 'pglite-cursor-values';

class CursorValuesConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    Object.assign(this.Config, {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION, Filename: ':memory:' }] },
    });
  }
}

/** One column per family the cursor check knows on PostgreSQL. */
@Connection(CONNECTION)
@Model('pgl_cursor_values')
class PglCursorValues extends ModelBase {
  @Primary()
  public Id: number;

  public Small: number;
  public Big: string;
  public Price: string;
  public Ratio: number;
  public Name: string;
  public Done: boolean;
  public Day: unknown;
  public At: unknown;
  public Starts: string;
  public Ref: string;
}

// No `Starts`: `TimeValueConverter` hydrates a time column as a TimeSpan, which a cursor cannot hold, so the server makes
// no cursor for a time order column (an existing defect, not this test's).
const ORDER_COLUMNS = ['Small', 'Big', 'Price', 'Ratio', 'Name', 'Done', 'Day', 'At', 'Ref'] as const;

/** The cursor hash carries no secret, so a caller can write a cursor for any order, as here. */
function forgedStartsCursor(starts: unknown): string {
  const h = createHash('sha256').update(JSON.stringify([['Starts', 'asc'], ['Id', 'asc']])).digest('base64url').slice(0, 16);
  return Buffer.from(JSON.stringify({ h, v: [starts, 1] })).toString('base64url');
}

describe('keyset cursor values on PGlite', function () {
  this.timeout(60000);

  let orm: Orm | undefined;

  before(async () => {
    DI.clearCache();
    DI.register(CursorValuesConf).as(Configuration);
    DI.register(PgliteOrmDriver).as('orm-driver-pglite');
    orm = await DI.resolve(Orm);
    const driver = orm.Connections.get(CONNECTION);
    if (!(driver instanceof PgliteOrmDriver)) throw new Error('the pglite connection is not booted');
    await driver.executeOnDb(
      'CREATE TABLE pgl_cursor_values ("Id" int PRIMARY KEY, "Small" int4 NOT NULL, "Big" int8 NOT NULL, "Price" numeric(10,2) NOT NULL, "Ratio" float8 NOT NULL, "Name" text NOT NULL, "Done" bool NOT NULL, "Day" date NOT NULL, "At" timestamptz NOT NULL, "Starts" time NOT NULL, "Ref" uuid NOT NULL)',
      [],
      QueryContext.Schema,
    );
    await driver.executeOnDb(
      `INSERT INTO pgl_cursor_values SELECT g, g % 3, 9007199254740993 + g % 2, (g % 4) * 1.25, g / 3.0, 'n' || (g % 2), g % 2 = 0, DATE '2026-01-01' + g % 3, TIMESTAMPTZ '2026-01-01 00:00:00+00' + (g % 3) * INTERVAL '90 minutes', TIME '08:00' + (g % 4) * INTERVAL '15 minutes 0.25 seconds', md5(g::text)::uuid FROM generate_series(1, 7) g`,
      [],
      QueryContext.Insert,
    );
    await orm.reloadTableInfo();
  });

  after(async () => {
    await orm?.dispose();
    DI.unregister(CursorValuesConf);
    DI.clearCache();
  });

  it('refuses a forged time before any statement is sent', async () => {
    const driver = orm!.Connections.get(CONNECTION)!;
    const execute = sinon.spy(driver, 'execute');
    try {
      for (const value of ['99:99', '24:00', '08:60:00']) {
        await expect(PglCursorValues.select().paginate({ orderBy: [['Starts', 'asc']], limit: 1, after: forgedStartsCursor(value) }), value).to.be.rejectedWith(InvalidCursor, /Starts/);
      }
      expect(execute.callCount, 'statements sent').to.eq(0);
    } finally {
      execute.restore();
    }
  });

  it('still walks every page with the cursors the server made, for every order column family', async () => {
    for (const column of ORDER_COLUMNS) {
      const ids: number[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const page = await PglCursorValues.select().paginate({ orderBy: [[column, 'asc']], limit: 2, after });
        ids.push(...page.items.map((r) => r.Id));
        if (page.next === null) break;
        after = page.next;
      }
      const sorted = (await PglCursorValues.select().order(column).order('Id')).map((r) => r.Id);
      expect(ids, column).to.deep.equal(sorted);
    }
  });
});
