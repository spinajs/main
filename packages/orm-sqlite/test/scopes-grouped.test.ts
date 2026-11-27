import { Archived, Connection, Model, ModelBase, OrmDriver, Primary, RawQuery, SoftDelete, SortOrder } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import { db } from './common.js';
import { bootUow, registerUowConnection } from './uowFixture.js';

const expect = chai.expect;

@Connection('sqlite')
@Model('sg_item')
class SgItem extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  public owner_id: number;

  @SoftDelete()
  public DeletedAt: DateTime;

  @Archived()
  public ArchivedAt: DateTime;
}

@Connection('sqlite')
@Model('sg_owner')
class SgOwner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('sqlite')
@Model('sg_soft')
class SgSoft extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  @SoftDelete()
  public DeletedAt: DateTime;
}

function sqlite(): OrmDriver {
  return db().Connections.get('sqlite')!;
}

const titles = (rows: unknown): string[] => (rows as { Title: string }[]).map((r) => r.Title).sort();

const sql = (query: { toDB(): unknown }): string => {
  const out = query.toDB() as { expression: string } | { expression: string }[];
  return Array.isArray(out) ? out[0].expression : out.expression;
};

// a, b, c live; d soft-deleted; e archived.
describe('soft-delete and archive scopes stay apart from the query conditions', function () {
  this.timeout(20000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await sqlite()
      .schema()
      .createTable('sg_item', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Title');
        t.int('owner_id');
        t.dateTime('DeletedAt');
        t.dateTime('ArchivedAt');
      });
    await sqlite()
      .schema()
      .createTable('sg_owner', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Name');
      });
    await sqlite()
      .schema()
      .createTable('sg_soft', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Title');
        t.dateTime('DeletedAt');
      });
    await db().reloadTableInfo();

    const stamp = DateTime.utc().toISO();
    await sqlite().insert().into('sg_owner').values({ Id: 1, Name: 'o' });
    await sqlite()
      .insert()
      .into('sg_item')
      .values([
        { Id: 1, Title: 'a', owner_id: 1, DeletedAt: null, ArchivedAt: null },
        { Id: 2, Title: 'b', owner_id: 1, DeletedAt: null, ArchivedAt: null },
        { Id: 3, Title: 'c', owner_id: 1, DeletedAt: null, ArchivedAt: null },
        { Id: 4, Title: 'd', owner_id: 1, DeletedAt: stamp, ArchivedAt: null },
        { Id: 5, Title: 'e', owner_id: 1, DeletedAt: null, ArchivedAt: stamp },
      ]);
    await sqlite()
      .insert()
      .into('sg_soft')
      .values([
        { Id: 1, Title: 'a', DeletedAt: null },
        { Id: 2, Title: 'd', DeletedAt: stamp },
      ]);
  });
  afterEach(() => DI.clearCache());

  it('an orWhere on the key of a deleted row returns no row', async () => {
    expect(titles(await SgItem.query().orWhere('Id', 4))).to.deep.eq([]);
    expect(sql(SgItem.query().orWhere('Id', 4))).to.eq('SELECT * FROM `sg_item` WHERE `DeletedAt` IS NULL AND `ArchivedAt` IS NULL AND `Id` = ?');
  });

  it('an orWhere returns no deleted and no archived row', async () => {
    expect(titles(await SgItem.where('Title', 'a').orWhere('Title', 'd'))).to.deep.eq(['a']);
    expect(titles(await SgItem.where('Title', 'a').orWhere('Title', 'e'))).to.deep.eq(['a']);
    expect(sql(SgItem.where('Title', 'a').orWhere('Title', 'd'))).to.eq('SELECT * FROM `sg_item` WHERE `DeletedAt` IS NULL AND `ArchivedAt` IS NULL AND ( `Title` = ? OR `Title` = ? )');
  });

  it('a raw condition with an OR returns no deleted and no archived row', async () => {
    const query = () => SgItem.where(RawQuery.create('1 = 0 OR 1 = 1'));
    expect(titles(await query())).to.deep.eq(['a', 'b', 'c']);
    expect(sql(query())).to.eq('SELECT * FROM `sg_item` WHERE `DeletedAt` IS NULL AND `ArchivedAt` IS NULL AND ( 1 = 0 OR 1 = 1 )');
  });

  it('a query without an OR compiles as before', () => {
    expect(sql(SgItem.where('Title', 'a'))).to.eq('SELECT * FROM `sg_item` WHERE `DeletedAt` IS NULL AND `ArchivedAt` IS NULL AND `Title` = ?');
    expect(
      sql(
        SgItem.where('Title', 'a').where(function () {
          this.where('Title', 'b').orWhere('Title', 'c');
        }),
      ),
    ).to.eq('SELECT * FROM `sg_item` WHERE `DeletedAt` IS NULL AND `ArchivedAt` IS NULL AND `Title` = ? AND ( `Title` = ? OR `Title` = ? )');
  });

  it('withDeleted() and withArchived() drop one scope each and keep the other apart', async () => {
    expect(titles(await SgItem.query().withDeleted().where('Title', 'a').orWhere('Title', 'e'))).to.deep.eq(['a']);
    expect(titles(await SgItem.query().withArchived().where('Title', 'a').orWhere('Title', 'd'))).to.deep.eq(['a']);
    expect(titles(await SgItem.query().withDeleted().where('Title', 'a').orWhere('Title', 'd'))).to.deep.eq(['a', 'd']);
    expect(titles(await SgItem.query().withDeleted().withArchived().where('Title', 'a').orWhere('Title', 'd').orWhere('Title', 'e'))).to.deep.eq(['a', 'd', 'e']);
    expect(sql(SgItem.query().orWhere('Id', 4).withDeleted())).to.eq('SELECT * FROM `sg_item` WHERE `ArchivedAt` IS NULL AND `Id` = ?');
  });

  it('a model with only @SoftDelete keeps its one scope apart', async () => {
    expect(titles(await SgSoft.where('Title', 'a').orWhere('Title', 'd'))).to.deep.eq(['a']);
    expect(titles(await SgSoft.query().withArchived().where('Title', 'a').orWhere('Title', 'd'))).to.deep.eq(['a']);
    expect(titles(await SgSoft.query().withDeleted().where('Title', 'a').orWhere('Title', 'd'))).to.deep.eq(['a', 'd']);
  });

  it("withDeleted() keeps a whereNull the query wrote itself on the soft-delete column", async () => {
    expect(titles(await SgItem.query().whereNull('DeletedAt').withDeleted())).to.deep.eq(['a', 'b', 'c']);
  });

  it('first(), a count, resultExists() and an offset page read through the scopes', async () => {
    expect(await SgItem.query().orWhere('Id', 4).first()).to.eq(undefined);
    expect(await SgItem.where('Title', 'a').orWhere('Title', 'd').selectCount()).to.eq(1);
    expect(await SgItem.query().orWhere('Id', 4).resultExists()).to.eq(false);
    expect(titles(await SgItem.where('Title', 'd').orWhere('Title', 'e').take(10).skip(0))).to.deep.eq([]);
  });

  it('keyset pages and a stream read through the scopes, also on a clone', async () => {
    const page = await SgItem.where('Title', 'a').orWhere('Title', 'd').orWhere('Title', 'e').paginate({ orderBy: [['Id', 'asc']], limit: 10 });
    expect(titles(page.items)).to.deep.eq(['a']);

    const streamed: unknown[] = [];
    for await (const row of SgItem.where('Title', 'a').orWhere('Title', 'd').order('Id', SortOrder.ASC).stream()) {
      streamed.push(row);
    }
    expect(titles(streamed)).to.deep.eq(['a']);

    expect(titles(await SgItem.where('Title', 'a').orWhere('Title', 'd').clone())).to.deep.eq(['a']);
  });

  it('an EXISTS sub-select on the scoped model reads through its scopes', async () => {
    const owners = await SgOwner.query().whereExist(SgItem.where('Title', 'd').orWhere('Title', 'e'));
    expect(owners).to.have.length(0);
  });
});
