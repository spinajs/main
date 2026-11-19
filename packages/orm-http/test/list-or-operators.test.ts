import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Connection, HasMany, Migration, Model, ModelBase, OrmDriver, OrmMigration, Primary, Relation } from '@spinajs/orm';
import { FilterableLogicalOperators, FilterableOperators, IFilterEntry } from '../src/interfaces.js';
import { Filterable } from '../src/decorators.js';
import { bootListFixture, idsOf } from './list-fixture.js';
import { installFilterStatics } from './filter-statics.js';

@Migration('default')
export class ListOrOperators_2026_11_19_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('fo_item', (table) => {
      table.int('Id').primaryKey().notNull();
      table.string('Name', 32);
      table.int('Amount').notNull();
      table.string('Tags', 32).notNull();
    });
    await connection.schema().createTable('fo_note', (table) => {
      table.int('Id').primaryKey().notNull();
      table.int('ItemId').notNull();
    });

    await connection.insert().into('fo_item').values({ Id: 1, Name: 'alpha', Amount: 10, Tags: 'a,b' });
    await connection.insert().into('fo_item').values({ Id: 2, Name: 'beta', Amount: 20, Tags: 'b' });
    await connection.insert().into('fo_item').values({ Id: 3, Name: null, Amount: 30, Tags: 'c' });
    await connection.insert().into('fo_item').values({ Id: 4, Name: '', Amount: 40, Tags: 'a' });

    await connection.insert().into('fo_note').values({ Id: 1, ItemId: 1 });
    await connection.insert().into('fo_note').values({ Id: 2, ItemId: 3 });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}

@Connection('default')
@Model('fo_note')
export class FoNote extends ModelBase {
  @Primary()
  public Id: number;

  public ItemId: number;
}

@Connection('default')
@Model('fo_item')
export class FoItem extends ModelBase {
  @Primary()
  @Filterable(['eq'])
  public Id: number;

  @Filterable(['like', 'b-like', 'e-like', 'nlike', 'nb-like', 'ne-like', 'empty', 'nempty', 'isnull', 'notnull', 'regexp'])
  public Name: string;

  @Filterable(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'notbetween', 'in', 'nin'])
  public Amount: number;

  @Filterable(['in-set', 'nin-set'])
  public Tags: string;

  @Filterable(['exists', 'n-exists'])
  @HasMany(FoNote, { foreignKey: 'ItemId' })
  public Notes: Relation<FoNote, FoItem>;
}

/** Every operator of the operator map but `regexp` (checked by its SQL below), with a filter on the fixture rows and the rows it keeps. */
const CASES: Array<[FilterableOperators, string, unknown, number[]]> = [
  ['eq', 'Amount', 20, [2]],
  ['neq', 'Amount', 20, [1, 3, 4]],
  ['gt', 'Amount', 20, [3, 4]],
  ['gte', 'Amount', 20, [2, 3, 4]],
  ['lt', 'Amount', 20, [1]],
  ['lte', 'Amount', 20, [1, 2]],
  ['like', 'Name', 'lph', [1]],
  ['b-like', 'Name', 'ta', [2]],
  ['e-like', 'Name', 'al', [1]],
  ['nlike', 'Name', 'lph', [2, 4]],
  ['nb-like', 'Name', 'ta', [1, 4]],
  ['ne-like', 'Name', 'al', [2, 4]],
  ['empty', 'Name', undefined, [3, 4]],
  ['nempty', 'Name', undefined, [1, 2]],
  ['between', 'Amount', [15, 35], [2, 3]],
  ['notbetween', 'Amount', [15, 35], [1, 4]],
  ['isnull', 'Name', undefined, [3]],
  ['notnull', 'Name', undefined, [1, 2, 4]],
  ['in', 'Amount', [10, 30], [1, 3]],
  ['nin', 'Amount', [10, 30], [2, 4]],
  ['exists', 'Notes', undefined, [1, 3]],
  ['n-exists', 'Notes', undefined, [2, 4]],
  ['in-set', 'Tags', ['a'], [1, 4]],
  ['nin-set', 'Tags', ['a'], [2, 3]],
];

const NO_ROW: IFilterEntry = { Column: 'Id', Operator: 'eq', Value: 999 };
const ROW_2: IFilterEntry = { Column: 'Id', Operator: 'eq', Value: 2 };

async function ids(filters: IFilterEntry[], op: FilterableLogicalOperators): Promise<number[]> {
  return idsOf(await FoItem.query().filter(filters, op));
}

describe('filter(): every operator as an alternative of an or group', function () {
  this.timeout(15000);

  before(async () => {
    await bootListFixture();
    installFilterStatics(FoItem);
  });
  after(() => DI.clearCache());

  for (const [operator, column, value, expected] of CASES) {
    describe(operator, () => {
      const filter: IFilterEntry = { Column: column, Operator: operator, Value: value };

      it('keeps its rows at the top level of an or', async () => {
        expect(await ids([filter, NO_ROW], FilterableLogicalOperators.Or)).to.deep.equal(expected);
      });

      it('keeps its rows in an or group nested in an and', async () => {
        expect(await ids([{ op: FilterableLogicalOperators.Or, filters: [filter, NO_ROW] }], FilterableLogicalOperators.And)).to.deep.equal(expected);
      });

      it('keeps its rows in an or group nested in an or', async () => {
        expect(await ids([{ op: FilterableLogicalOperators.Or, filters: [filter, NO_ROW] }, NO_ROW], FilterableLogicalOperators.Or)).to.deep.equal(expected);
      });
    });
  }

  for (const [operator, filter] of [
    ['in', { Column: 'Amount', Operator: 'in', Value: [10, 30] }],
    ['exists', { Column: 'Notes', Operator: 'exists', Value: undefined }],
  ] as Array<[string, IFilterEntry]>) {
    it(`${operator} in second place adds its rows to those of the condition before it`, async () => {
      expect(await ids([ROW_2, filter], FilterableLogicalOperators.Or)).to.deep.equal([1, 2, 3]);
      expect(await ids([{ op: FilterableLogicalOperators.Or, filters: [ROW_2, filter] }], FilterableLogicalOperators.And)).to.deep.equal([1, 2, 3]);
    });
  }

  it('refuses in with an empty array under an or, as under an and', () => {
    const empty: IFilterEntry = { Column: 'Amount', Operator: 'in', Value: [] };

    for (const op of [FilterableLogicalOperators.Or, FilterableLogicalOperators.And]) {
      expect(() => FoItem.query().filter([ROW_2, empty], op), op)
        .to.throw(InvalidArgument, "Operator 'in' for column 'Amount' requires an array with at least 1 value")
        .with.property('errorCode', 'LENGTH_TOO_SHORT');
    }
  });

  // SQLite has no REGEXP function, so the operator is checked by the SQL it compiles to
  it('regexp compiles to the same condition under an or as under an and', () => {
    const filter: IFilterEntry = { Column: 'Name', Operator: 'regexp', Value: '^a' };

    const or = FoItem.query().filter([filter, NO_ROW], FilterableLogicalOperators.Or).toDB();
    const nested = FoItem.query().filter([{ op: FilterableLogicalOperators.Or, filters: [filter, NO_ROW] }]).toDB();

    for (const compiled of [or, nested]) {
      const out = Array.isArray(compiled) ? compiled[0] : compiled;
      expect(out.expression).to.match(/`Name` REGEXP \? OR `Id` = \?/);
      expect(out.bindings).to.deep.equal(['^a', 999]);
    }
  });
});
