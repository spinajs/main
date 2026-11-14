import type { AggregateValue, ICompilerOutput, MinMaxValue, SelectQueryBuilder, ISelectQueryBuilder, IColumnsBuilder } from '@spinajs/orm';
import { assertType } from '../assert.js';
import type { Equal } from '../assert.js';
import { Team, User } from '../models.js';

export async function projectionStrict(): Promise<void> {
  const ids = await User.query().select('Id').select('Email', 'Mail').where('IsActive', true).orderBy('CreatedAt');
  assertType<Equal<(typeof ids)[number]['Id'], number>>();
  assertType<Equal<(typeof ids)[number]['Mail'], string>>();
  // @ts-expect-error an unselected column is not on the row
  void ids[0].Name;

  const one = await User.query().where('Id', 1).select('Id').first();
  assertType<Equal<typeof one.Id, number>>();

  const listed = await User.query().select('Name').columns(['Id', 'Email']);
  assertType<Equal<(typeof listed)[number]['Email'], string>>();
  // @ts-expect-error columns() replaces the select list
  void listed[0].Name;

  const star = await User.query().select('*');
  assertType<Equal<typeof star, User[]>>();

  // a scope typed on the full model runs before the projection
  await User.query().whereEmail('a').select('Id');
  // @ts-expect-error the projected builder is no ISelectQueryBuilder<User[]>
  User.query().select('Id').whereEmail('a');

  // the class stays assignable to the interfaces
  const cls: SelectQueryBuilder<User[]> = User.all();
  const asInterface: ISelectQueryBuilder<User[]> = cls;
  const asColumns: IColumnsBuilder = User.query();
  void [one, star, asInterface, asColumns];
}

export async function aggregatesStrict(): Promise<void> {
  const total = await User.query().count('Id', 'total').first();
  assertType<Equal<typeof total.total, AggregateValue>>();
  const plain = await User.query().count().first();
  assertType<Equal<typeof plain.count, AggregateValue>>();
  const extremes = await User.query().max('Id', 'top').min('CreatedAt', 'first').max('Email', 'last').min('IsActive', 'any');
  // MIN/MAX/SUM/AVG over zero rows are NULL; COUNT never is
  assertType<Equal<(typeof extremes)[number]['top'], number | null>>();
  assertType<Equal<(typeof extremes)[number]['first'], Date | string | number | null>>();
  assertType<Equal<(typeof extremes)[number]['last'], string | null>>();
  assertType<Equal<(typeof extremes)[number]['any'], boolean | null>>();
  assertType<Equal<MinMaxValue<User, 'DeletedAt'>, Date | string | number | null>>();
  const sums = await User.query().select('IsActive').sum('Id', 'ids').avg('Id', 'mean').groupBy('IsActive');
  assertType<Equal<(typeof sums)[number]['IsActive'], boolean>>();
  assertType<Equal<(typeof sums)[number]['mean'], AggregateValue | null>>();
  assertType<Equal<(typeof sums)[number]['ids'], AggregateValue | null>>();
  assertType<Equal<AggregateValue, number | string>>();
  // @ts-expect-error count() replaces the select list
  void (await User.query().select('Id').count().first()).Id;
  // without an alias the column name of an aggregate is unknown, so the row is unchanged
  const unaliased = await User.query().max('Id');
  assertType<Equal<typeof unaliased, User[]>>();
  // on the class the narrowed builder is still the class, so class-only members survive
  User.all().count('Id', 'total').mergeStatements(User.all());
  void [total, plain, extremes, sums, unaliased];
}

export async function dynamicAliasStrict(as: string): Promise<void> {
  // a non-literal alias names no known column, so the row is unchanged
  const counted = await User.query().count('Id', as);
  assertType<Equal<typeof counted, User[]>>();
  const aliased = await User.query().select('Email', as).max('Id', as).min('Id', as).sum('Id', as).avg('Id', as);
  assertType<Equal<typeof aliased, User[]>>();
  void [counted, aliased];
}

export function classCount(): SelectQueryBuilder<User[]> {
  // @ts-expect-error a strict aggregate changes the row type, so it is no longer a SelectQueryBuilder<User[]>
  return User.all().count();
}

export async function populateStrict(): Promise<void> {
  const projected = await User.query().select('Id').populate('Team').first();
  assertType<Equal<typeof projected.Id, number>>();
  const team: Team = projected.Team.Value;
  void team;
  await User.query().populate('Owner').where('Owner', 1);
  User.query().populate('Metadata', function () {
    // @ts-expect-error unknown column of the related model inside the callback
    this.where('Kee', 'k');
  });
  // @ts-expect-error an optional relation is no column
  User.query().select('Owner');
}

export async function populateNamesStrict(dynamic: string, anyQuery: ISelectQueryBuilder<any>): Promise<void> {
  await User.query().populate(['Metadata', 'Team.Name']).populate({ Metadata: {} }).populate(Team).populate(null);
  await anyQuery.populate(dynamic).populate([dynamic]);
  // @ts-expect-error misspelled relation
  User.query().populate('Metdata');
  // @ts-expect-error misspelled relation in an array
  User.query().populate(['Metadata', 'Teem']);
  // @ts-expect-error a plain string is rejected by populate
  User.query().populate(dynamic);
  // @ts-expect-error a string array is rejected by populate
  User.query().populate([dynamic]);
  // @ts-expect-error misspelled relation in the object form
  User.query().populate({ Metdata: {} });
  // @ts-expect-error a column is no relation
  User.query().populate('Email');
}

export async function streamStrict(): Promise<void> {
  for await (const row of User.query().select('Id').stream()) {
    assertType<Equal<typeof row.Id, number>>();
    // @ts-expect-error an unselected column is not on the row
    void row.Name;
  }
  for await (const _user of User.query().select('Id').populate('Team').stream()) {
    assertType<Equal<typeof _user.Team.Value, Team>>();
  }
  for await (const _row of User.all().count('Id', 'total').stream({ batchSize: 100 })) {
    assertType<Equal<typeof _row.total, AggregateValue>>();
  }
}

export async function paginateStrict(computed: string): Promise<void> {
  const page = await User.query().select('Id').paginate({ orderBy: [['CreatedAt', 'desc']], limit: 20 });
  assertType<Equal<(typeof page.items)[number]['Id'], number>>();
  // @ts-expect-error an unselected column is not on the row
  void page.items[0].Name;
  const _populated = await User.query().select('Id').populate('Team').paginate({ orderBy: [['Id', 'asc']], limit: 5 });
  assertType<Equal<(typeof _populated.items)[number]['Team']['Value'], Team>>();
  // @ts-expect-error strict mode refuses an undeclared column name
  void User.query().paginate({ orderBy: [['Nope', 'asc']], limit: 5 });
  // @ts-expect-error strict mode refuses a column name that is not a literal
  void User.query().paginate({ orderBy: [[computed, 'asc']], limit: 5 });
  // @ts-expect-error paginate() orders by the model's own columns, not a relation's
  void User.query().paginate({ orderBy: [['Team.Id', 'asc']], limit: 5 });
}

export function untypedStrict(raw: SelectQueryBuilder<unknown>, anyRows: SelectQueryBuilder<any>): void {
  // a builder without a model has no row to narrow, so it stays the class (`toDB()` returns one output)
  const one: ICompilerOutput = raw.select('id').columns(['id']).count('id', 'c').max('id', 'top').toDB();
  const other: ICompilerOutput = anyRows.select('id', 'alias').sum('id', 's').toDB();
  void [one, other];
}

export async function objectWhereAfterProjectionStrict(): Promise<void> {
  // the object form of where checks the model's columns, not the projection
  await User.query().columns(['Id']).where({ Email: 'a' }).orWhere({ IsActive: true }).andWhere({ Name: null });
  await User.query().select('Id').whereObject({ Email: 'a' });
}

export function untypedArrayStrict(rows: SelectQueryBuilder<any[]>): void {
  // an array of `any` rows has no model either
  const out: ICompilerOutput = rows.select('id').columns(['id']).count('id', 'c').toDB();
  void out;
}
