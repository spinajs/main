import { rel } from '@spinajs/orm';
import type { SelectQueryBuilder, ISelectQueryBuilder, IColumnsBuilder } from '@spinajs/orm';
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
  assertType<Equal<typeof total.total, number>>();
  const plain = await User.query().count().first();
  assertType<Equal<typeof plain.count, number>>();
  const extremes = await User.query().max('Id', 'top').min('CreatedAt', 'first');
  assertType<Equal<(typeof extremes)[number]['top'], number>>();
  const sums = await User.query().select('IsActive').sum('Id', 'ids').avg('Id', 'mean').groupBy('IsActive');
  assertType<Equal<(typeof sums)[number]['IsActive'], boolean>>();
  assertType<Equal<(typeof sums)[number]['mean'], number>>();
  // @ts-expect-error count() replaces the select list
  void (await User.query().select('Id').count().first()).Id;
  // without an alias the column name of an aggregate is unknown, so the row is unchanged
  const unaliased = await User.query().max('Id');
  assertType<Equal<typeof unaliased, User[]>>();
  // on the class the narrowed builder is still the class, so class-only members survive
  User.all().count('Id', 'total').mergeStatements(User.all());
  void [total, plain, extremes, sums, unaliased];
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
  await User.query().populate(['Metadata', 'Team.Name']).populate({ Metadata: {} }).populate(Team).populate(rel(dynamic)).populate(null);
  await anyQuery.populate(dynamic).populate([dynamic]);
  // @ts-expect-error misspelled relation
  User.query().populate('Metdata');
  // @ts-expect-error misspelled relation in an array
  User.query().populate(['Metadata', 'Teem']);
  // @ts-expect-error a non-literal relation needs rel()
  User.query().populate(dynamic);
  // @ts-expect-error misspelled relation in the object form
  User.query().populate({ Metdata: {} });
  // @ts-expect-error a column is no relation
  User.query().populate('Email');
}
