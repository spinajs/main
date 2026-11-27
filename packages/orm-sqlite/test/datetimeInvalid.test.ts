import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Connection, DateTime as DateTimeColumn, InsertBehaviour, Model, ModelBase, Orm, Primary, QueryContext } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

const expect = chai.expect;
const LIVE = '2026-12-01T10:00:00.000Z';

@Connection('sqlite')
@Model('dt_invalid_grant')
class Grant extends ModelBase<Grant> {
  @Primary()
  public Id: number;

  // NULL means "never expires": the reason an unreadable instant must not become NULL
  @DateTimeColumn({ nullable: true })
  public ExpiresAt: DateTime | null;
}

@Connection('sqlite')
@Model('dt_invalid_grant_ms')
class MillisGrant extends ModelBase<MillisGrant> {
  @Primary()
  public Id: number;

  @DateTimeColumn({ unit: 'milliseconds', nullable: true })
  public ExpiresAt: DateTime | null;
}

const NOT_AN_INSTANT: Array<[string, () => unknown]> = [
  ['DateTime.invalid', () => DateTime.invalid('test')],
  ['DateTime.fromMillis(NaN)', () => DateTime.fromMillis(NaN)],
  ['Invalid Date', () => new Date(NaN)],
  ['Infinity', () => Infinity],
  ['-Infinity', () => -Infinity],
];

function driver(): SqliteOrmDriver {
  return db().Connections.get('sqlite') as SqliteOrmDriver;
}

async function rows(table: string): Promise<Array<{ Id: number; ExpiresAt: unknown }>> {
  return (await driver().executeOnDb(`SELECT Id, ExpiresAt FROM ${table} ORDER BY Id`, [], QueryContext.Select)) as Array<{ Id: number; ExpiresAt: unknown }>;
}

async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('sqlite @DateTime refuses a present value that is not a valid instant', function () {
  this.timeout(20000);

  before(async () => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    await DI.resolve(Orm);
    await driver().executeOnDb('CREATE TABLE dt_invalid_grant (Id INTEGER PRIMARY KEY, ExpiresAt TEXT NULL)', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE dt_invalid_grant_ms (Id INTEGER PRIMARY KEY, ExpiresAt INTEGER NULL)', [], QueryContext.Schema);
    await db().reloadTableInfo();
  });

  beforeEach(async () => {
    await driver().executeOnDb('DELETE FROM dt_invalid_grant', [], QueryContext.Delete);
    await driver().executeOnDb('DELETE FROM dt_invalid_grant_ms', [], QueryContext.Delete);
    await driver().executeOnDb(`INSERT INTO dt_invalid_grant (Id, ExpiresAt) VALUES (1, '${LIVE}')`, [], QueryContext.Insert);
    await driver().executeOnDb(`INSERT INTO dt_invalid_grant_ms (Id, ExpiresAt) VALUES (1, ${Date.parse(LIVE)})`, [], QueryContext.Insert);
  });

  after(() => {
    DI.clearCache();
  });

  for (const [label, make] of NOT_AN_INSTANT) {
    describe(label, () => {
      it('model insert() throws and writes no row', async () => {
        const grant = new Grant({ Id: 2 });
        grant.ExpiresAt = make() as DateTime;

        expect(await rejection(grant.insert())).to.be.instanceOf(InvalidArgument);
        expect((await rows('dt_invalid_grant')).map((r) => r.Id)).to.deep.eq([1]);
      });

      it('static insert() of one and of several rows throws and writes no row', async () => {
        expect(await rejection(Grant.insert({ Id: 2, ExpiresAt: make() as DateTime }))).to.be.instanceOf(InvalidArgument);
        expect(await rejection(Grant.insert([{ Id: 3, ExpiresAt: DateTime.fromISO(LIVE) }, { Id: 4, ExpiresAt: make() as DateTime }]))).to.be.instanceOf(InvalidArgument);
        expect((await rows('dt_invalid_grant')).map((r) => r.Id)).to.deep.eq([1]);
      });

      it('an upsert over a live row throws and keeps the row', async () => {
        const grant = new Grant({ Id: 1 });
        grant.ExpiresAt = make() as DateTime;

        expect(await rejection(grant.insert(InsertBehaviour.InsertOrUpdate))).to.be.instanceOf(InvalidArgument);
        expect(await rows('dt_invalid_grant')).to.deep.eq([{ Id: 1, ExpiresAt: LIVE }]);
      });

      it('update() of a loaded model throws and keeps the stored instant', async () => {
        const grant = (await Grant.where('Id', 1).first())!;
        grant.ExpiresAt = make() as DateTime;

        expect(await rejection(grant.update())).to.be.instanceOf(InvalidArgument);
        expect(await rows('dt_invalid_grant')).to.deep.eq([{ Id: 1, ExpiresAt: LIVE }]);
      });

      it('query-builder update({ ExpiresAt }) throws and keeps the stored instant, also under unit milliseconds', async () => {
        expect(await rejection(Grant.update({ ExpiresAt: make() as DateTime }).where('Id', 1))).to.be.instanceOf(InvalidArgument);
        expect(await rejection(MillisGrant.update({ ExpiresAt: make() as DateTime }).where('Id', 1))).to.be.instanceOf(InvalidArgument);
        expect(await rows('dt_invalid_grant')).to.deep.eq([{ Id: 1, ExpiresAt: LIVE }]);
        expect(await rows('dt_invalid_grant_ms')).to.deep.eq([{ Id: 1, ExpiresAt: Date.parse(LIVE) }]);
      });

      it("where('ExpiresAt', '<', x) and whereIn throw naming the column instead of comparing with NULL", async () => {
        for (const query of [Grant.where('ExpiresAt', '<', make() as DateTime), Grant.where('ExpiresAt', '!=', make() as DateTime), Grant.query().whereIn('ExpiresAt', [DateTime.fromISO(LIVE), make() as DateTime])]) {
          const error = await rejection(query);
          expect(error).to.be.instanceOf(InvalidArgument);
          expect((error as Error).message).to.match(/^column ExpiresAt: /);
        }
      });

      // a raw parameter is converted only when it is a Date or a DateTime; a bare number is bound as given
      if (typeof make() !== 'number') {
        it('a raw executeOnDb parameter throws naming the parameter', async () => {
          const error = await rejection(driver().executeOnDb('SELECT Id FROM dt_invalid_grant WHERE ExpiresAt < ?', [make()], QueryContext.Select));
          expect(error).to.be.instanceOf(InvalidArgument);
          expect((error as Error).message).to.match(/^parameter: /);
        });
      }
    });
  }

  describe('what stays as it is', () => {
    it('null writes NULL on insert and on update', async () => {
      await Grant.insert({ Id: 2, ExpiresAt: null });
      await Grant.update({ ExpiresAt: null }).where('Id', 1);

      expect(await rows('dt_invalid_grant')).to.deep.eq([
        { Id: 1, ExpiresAt: null },
        { Id: 2, ExpiresAt: null },
      ]);
    });

    it('a valid DateTime is written as before', async () => {
      await Grant.insert({ Id: 2, ExpiresAt: DateTime.fromISO(LIVE) });
      await MillisGrant.insert({ Id: 2, ExpiresAt: DateTime.fromISO(LIVE) });

      expect((await rows('dt_invalid_grant'))[1]).to.deep.eq({ Id: 2, ExpiresAt: LIVE });
      expect((await rows('dt_invalid_grant_ms'))[1]).to.deep.eq({ Id: 2, ExpiresAt: Date.parse(LIVE) });
    });
  });
});
