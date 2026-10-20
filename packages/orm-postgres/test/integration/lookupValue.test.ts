import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Connection, Model, ModelBase, Primary, QueryContext, columnKind, extractModelDescriptor, lookupValue } from '@spinajs/orm';
import { bootPostgres, PgTestDb, requirePostgres } from './support.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const REF = '0b6c6f1e-5f43-4a3e-9d3e-2a4b1c0d9e8f';

@Connection('pg')
@Model('pg_gap_lookup')
class PgGapLookup extends ModelBase {
  @Primary()
  public Id: number;

  public Ref: string;

  public Code: string;

  public Amount: string;

  public Big: string;
}

const column = (name: string) => extractModelDescriptor(PgGapLookup)!.Columns.find((c) => c.Name === name)!;

describe('postgres column kinds and lookup values (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('lookup');
    await pgdb.driver.executeOnDb('CREATE TABLE pg_gap_lookup ("Id" integer PRIMARY KEY, "Ref" uuid, "Code" varchar(16), "Amount" numeric(10,2), "Big" bigint)', [], QueryContext.Schema);
    await pgdb.orm.reloadTableInfo();
    await pgdb.driver.executeOnDb(`INSERT INTO pg_gap_lookup ("Id", "Ref", "Code", "Amount", "Big") VALUES (1, '${REF}', 'a', 1.5, 9007199254740993), (2, NULL, 'b', 2, 2)`, [], QueryContext.Insert);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('names each column kind from the udt name the driver reports', () => {
    expect(columnKind(column('Id'))).to.eq('integer');
    expect(columnKind(column('Big'))).to.eq('integer');
    expect(columnKind(column('Ref'))).to.eq('uuid');
    expect(columnKind(column('Code'))).to.eq('text');
    expect(columnKind(column('Amount'))).to.eq('decimal');
  });

  it('text that is no integer, bound to an integer column, fails the query', async () => {
    await expect(PgGapLookup.query().whereIn('Id', ['1', 'abc'])).to.be.rejected;
  });

  it('lookup values keep only what each column can hold, and find the rows', async () => {
    const ids = ['1', 'abc', '2'].map((t) => lookupValue(column('Id'), t)).filter((v) => v !== undefined);
    expect(((await PgGapLookup.query().whereIn('Id', ids)) as PgGapLookup[]).map((m) => m.Id).sort()).to.deep.eq([1, 2]);

    const refs = ['nope', REF].map((t) => lookupValue(column('Ref'), t)).filter((v) => v !== undefined);
    expect(((await PgGapLookup.query().whereIn('Ref', refs)) as PgGapLookup[]).map((m) => m.Id)).to.deep.eq([1]);

    expect(lookupValue(column('Big'), '9007199254740993')).to.eq('9007199254740993');
    expect(((await PgGapLookup.query().where('Big', lookupValue(column('Big'), '9007199254740993'))) as PgGapLookup[]).map((m) => m.Id)).to.deep.eq([1]);

    const amounts = ['1.5', 'x'].map((t) => lookupValue(column('Amount'), t)).filter((v) => v !== undefined);
    expect(((await PgGapLookup.query().whereIn('Amount', amounts)) as PgGapLookup[]).map((m) => m.Id)).to.deep.eq([1]);
  });
});
