import type { SelectQueryBuilder, ISelectQueryBuilder, IColumnsBuilder } from '@spinajs/orm';
import { assertType } from '../assert.js';
import type { Equal } from '../assert.js';
import { User } from '../models.js';

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
