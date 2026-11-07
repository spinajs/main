import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { BelongsTo, Connection, Ignore, InsertBehaviour, Model, ModelBase, Orm, Primary, QueryContext, SingleRelation } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';
import { captureStatements } from './uowFixture.js';

@Connection('sqlite')
@Model('ignore_row')
class IgnoreRow extends ModelBase<IgnoreRow> {
  @Primary()
  public Id: number;

  public Name: string;

  @Ignore()
  public Scratch: string;
}

@Connection('sqlite')
@Model('ignore_present')
class IgnorePresent extends ModelBase<IgnorePresent> {
  @Primary()
  public Id: number;

  public Name: string;

  @Ignore()
  public Scratch: string;
}

@Connection('sqlite')
@Model('ignore_owner')
class IgnoreOwner extends ModelBase<IgnoreOwner> {
  @Primary()
  public Id: number;

  @BelongsTo(IgnoreRow, 'row_id')
  public Row: SingleRelation<IgnoreRow>;
}

const run = (sql: string) => (db().Connections.get('sqlite') as SqliteOrmDriver).executeOnDb(sql, [], QueryContext.Schema);

describe('sqlite @Ignore() property', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  beforeEach(async () => {
    await DI.resolve(Orm);
    await run('CREATE TABLE ignore_row (Id INTEGER PRIMARY KEY, Name TEXT NOT NULL UNIQUE)');
    await run('CREATE TABLE ignore_present (Id INTEGER PRIMARY KEY, Name TEXT, Scratch TEXT)');
    await run('CREATE TABLE ignore_owner (Id INTEGER PRIMARY KEY, row_id INTEGER)');
    await db().reloadTableInfo();
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('creates a row without naming the property in the SQL, and keeps it on the instance', async () => {
    const capture = captureStatements();
    const row = await IgnoreRow.create({ Name: 'a', Scratch: 'temp' });
    capture.restore();

    expect(row.Scratch).to.equal('temp');
    expect(capture.statements.map((s) => s.expression).join('\n')).to.not.contain('Scratch');
    expect((await IgnoreRow.get(row.Id)).Name).to.equal('a');
  });

  it('updates a row, and writes nothing when only the ignored property changed', async () => {
    const row = await IgnoreRow.create({ Name: 'a' });

    row.Scratch = 'only';
    const capture = captureStatements();
    await row.update();
    capture.restore();
    expect(capture.statements).to.have.length(0);

    row.Name = 'b';
    row.Scratch = 'again';
    await row.update();
    expect((await IgnoreRow.get(row.Id)).Name).to.equal('b');

    await IgnoreRow.update({ Name: 'c', Scratch: 'static' }).where({ Id: row.Id });
    expect((await IgnoreRow.get(row.Id)).Name).to.equal('c');
  });

  it('inserts many rows, models and plain objects alike', async () => {
    await IgnoreRow.insert([new IgnoreRow({ Name: 'a', Scratch: 'x' }), { Name: 'b', Scratch: 'y' }]);

    expect((await IgnoreRow.all()).map((r) => r.Name)).to.deep.equal(['a', 'b']);
  });

  it('upserts without the property in the insert or the update list', async () => {
    await IgnoreRow.create({ Name: 'a' });

    await new IgnoreRow({ Name: 'a', Scratch: 'x' }).insert(InsertBehaviour.InsertOrUpdate);
    await IgnoreRow.insert({ Name: 'a', Scratch: 'y' }, InsertBehaviour.InsertOrUpdate);

    expect(await IgnoreRow.all()).to.have.length(1);
  });

  it('saves through the unit of work', async () => {
    const row = new IgnoreRow({ Name: 'a', Scratch: 'x' });
    await row.save();

    row.Scratch = 'y';
    row.Name = 'b';
    await row.save();

    expect((await IgnoreRow.get(row.Id)).Name).to.equal('b');
  });

  it('is left out of toSql(), dehydrate() and the JSON schemas', () => {
    const row = new IgnoreRow({ Id: 1, Name: 'a', Scratch: 'x' });

    expect(row.toSql()).to.not.have.property('Scratch');
    expect(row.dehydrate()).to.not.have.property('Scratch');
    expect(IgnoreRow.getModelDescriptor().Schema).to.not.have.nested.property('properties.Scratch');
    expect(IgnoreRow.getModelDescriptor().ResponseSchema).to.not.have.nested.property('properties.Scratch');
  });

  it('hydrates a column the table does have, and never writes it back', async () => {
    await run("INSERT INTO ignore_present (Id, Name, Scratch) VALUES (1, 'a', 'stored')");

    const row = await IgnorePresent.get(1);
    expect(row.Scratch).to.equal('stored');

    row.Name = 'b';
    row.Scratch = 'changed';
    await row.update();

    const [raw] = (await (db().Connections.get('sqlite') as SqliteOrmDriver).executeOnDb('SELECT Name, Scratch FROM ignore_present', [], QueryContext.Select)) as Array<{ Name: string; Scratch: string }>;
    expect(raw).to.deep.equal({ Name: 'b', Scratch: 'stored' });
  });

  it('populates a relation to the model without selecting the property', async () => {
    const row = await IgnoreRow.create({ Name: 'a' });
    await IgnoreOwner.insert({ row_id: row.Id });

    const owner = await IgnoreOwner.where({ Id: 1 }).populate('Row').first();

    expect(owner.Row.Value.Name).to.equal('a');
  });
});
