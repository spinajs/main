/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import {
  Connection,
  BelongsTo,
  HasMany,
  HasManyToMany,
  Migration,
  Model,
  ModelBase,
  Orm,
  OrmDriver,
  OrmMigration,
  Primary,
  Relation,
  SingleRelation,
  extractModelDescriptor,
} from '@spinajs/orm';
import '@spinajs/log';

import { TestConfiguration } from './common.js';
// Declares IModelDescriptor.FilterableColumns and installs `filter()` on SelectQueryBuilder.
import '../src/extension.js';
import '../src/builders.js';
import { Filterable } from '../src/decorators.js';
import { MODEL_STATIC_MIXINS } from '../src/model.js';

/**
 * `@Filterable(ops, queryFn)` on a property that has NO column behind it: a filter-only,
 * "virtual" column - a search box mapped onto several real columns is the typical case.
 *
 * The decorator records the property as a `Virtual: true` entry in `descriptor.Columns` so the
 * filter schema and `filter()` can find it. That entry must be invisible to everything that
 * turns `Columns` into SQL or JSON: the own-table select and the insert/update converters
 * already skipped it, but every RELATION query selected it (so populating the model as a
 * HasMany / BelongsTo / HasManyToMany target failed with "no such column"), and the
 * dehydrator threw "Field <name> cannot be null" for it on every row. This suite pins each of
 * those paths against a real SQLite database.
 */

@Migration('default')
export class VirtualFilterColumn_2026_09_11_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('vfc_owner', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Name', 64);
    });
    await connection.schema().createTable('vfc_item', (table) => {
      table.int('Id').primaryKey().notNull();
      table.int('OwnerId');
      table.string('Name', 64);
    });
    await connection.schema().createTable('vfc_tag', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Label', 64);
    });
    await connection.schema().createTable('vfc_item_tag', (table) => {
      table.int('Id').primaryKey().notNull();
      table.int('ItemId');
      table.int('TagId');
    });

    await connection.insert().into('vfc_owner').values({ Id: 1, Name: 'owner' });
    await connection.insert().into('vfc_item').values({ Id: 1, OwnerId: 1, Name: 'alpha' });
    await connection.insert().into('vfc_item').values({ Id: 2, OwnerId: 1, Name: 'beta' });
    await connection.insert().into('vfc_tag').values({ Id: 1, Label: 'red' });
    await connection.insert().into('vfc_item_tag').values({ Id: 1, ItemId: 1, TagId: 1 });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}

@Connection('default')
@Model('vfc_tag')
export class VTag extends ModelBase {
  @Primary()
  public Id: number;

  public Label: string;

  /** Filter-only: the tag has no `search` column either. */
  @Filterable(['like'], (_operator, value) => function (this: any) {
    this.where('Label', 'like', `%${value}%`);
  })
  public search: string;
}

@Connection('default')
@Model('vfc_item_tag')
export class VItemTag extends ModelBase {
  @Primary()
  public Id: number;

  public ItemId: number;

  public TagId: number;
}

@Connection('default')
@Model('vfc_item')
export class VItem extends ModelBase {
  @Primary()
  public Id: number;

  public OwnerId: number;

  @Filterable(['eq', 'like'])
  public Name: string;

  /** The search box: one term over `Name` - there is no `search` column in `vfc_item`. */
  @Filterable(['like'], (_operator, value) => function (this: any) {
    this.where('Name', 'like', `%${value}%`);
  })
  public search: string;

  // By name: `VOwner` is declared below, and the registry resolves string targets at Orm boot.
  @BelongsTo('VOwner', 'OwnerId')
  public Owner: SingleRelation<VOwner>;

  @HasManyToMany(VItemTag, VTag, { junctionModelSourcePk: 'ItemId', junctionModelTargetPk: 'TagId' })
  public Tags: Relation<VTag, VItem>;
}

@Connection('default')
@Model('vfc_owner')
export class VOwner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany(VItem, { foreignKey: 'OwnerId' })
  public Items: Relation<VItem, VOwner>;
}

describe('@Filterable on a property with no column (virtual filter column)', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Orm);

    // orm-http's bootstrapper installs these on every loaded model in a full app boot.
    for (const model of [VItem, VTag, VOwner]) {
      for (const mixin in MODEL_STATIC_MIXINS) {
        (model as any)[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(model);
      }
    }
  });

  after(() => {
    DI.clearCache();
  });

  it('records the property as a nullable virtual column, so it is filterable but never a real column', () => {
    const column = extractModelDescriptor(VItem)!.Columns.find((c) => c.Name === 'search')!;

    expect(column, 'the decorator did not register the column').to.exist;
    expect(column.Virtual).to.equal(true);
    expect(column.Nullable, 'a filter-only column cannot be required').to.equal(true);
    expect((VItem as any).filterColumns().map((c: any) => c.column)).to.include('search');
  });

  it('filters through the custom query and never selects the virtual column', async () => {
    const query = (VItem.query() as any).filter([{ Column: 'search', Operator: 'like', Value: 'alph' }]);
    const sql = query.toDB();

    expect(sql.expression, sql.expression).to.match(/`Name` like \?/i);
    expect(sql.expression).to.not.match(/`search`/);

    const rows = await query;
    expect(rows.map((r: VItem) => r.Name)).to.deep.equal(['alpha']);
  });

  it('populates the model as a HasMany target', async () => {
    const owner = await VOwner.where('Id', 1).populate('Items').firstOrFail();

    expect([...owner.Items].map((i) => i.Name).sort()).to.deep.equal(['alpha', 'beta']);
  });

  it('populates the model as a BelongsTo target', async () => {
    const item = await VItem.where('Id', 1).populate('Owner').firstOrFail();

    expect(item.Owner.Value?.Name).to.equal('owner');
  });

  it('populates a virtual-column model as a HasManyToMany target', async () => {
    const item = await VItem.where('Id', 1).populate('Tags').firstOrFail();

    expect([...item.Tags].map((t) => t.Label)).to.deep.equal(['red']);
  });

  it('dehydrates without the virtual column and without throwing', async () => {
    const item = await VItem.where('Id', 1).populate('Owner').firstOrFail();

    const plain = item.dehydrate();
    expect(plain).to.not.have.property('search');
    expect(plain).to.include({ Id: 1, Name: 'alpha' });

    const withRelations = item.dehydrateWithRelations();
    expect(withRelations).to.not.have.property('search');
    expect(withRelations.Owner).to.include({ Id: 1, Name: 'owner' });
  });

  it('inserts and updates without touching the virtual column', async () => {
    const item = new VItem();
    item.hydrate({ Id: 3, OwnerId: 1, Name: 'gamma' } as any);
    await item.insert();

    item.Name = 'gamma-2';
    await item.update();

    const reloaded = await VItem.where('Id', 3).firstOrFail();
    expect(reloaded.Name).to.equal('gamma-2');
  });
});
