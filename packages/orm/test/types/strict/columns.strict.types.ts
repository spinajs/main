import { RawQuery, SortOrder, SqlOperator } from '@spinajs/orm';
import type { ColumnName, ISelectQueryBuilder, ModelBase } from '@spinajs/orm';
import { Upload, User } from '../models.js';

declare const dynamic: string;
declare const anyQuery: ISelectQueryBuilder<any>;
declare const untyped: ISelectQueryBuilder;
declare const baseModel: ISelectQueryBuilder<ModelBase[]>;

export async function whereStrict(): Promise<void> {
  await User.query().where('Id', 1).where('Email', 'a').where('Name', null).where('Id', [1, 2]);
  await User.query().where('Team', 5).where('Team.Name', 'x').where('CreatedAt', '>', new Date());
  await User.query().where('Id', SqlOperator.GT, 1).where(new RawQuery('1 = 1')).where({ Email: 'a' });
  await User.query()
    .where(function () {
      this.where('IsActive', true);
    })
    .whereIn('Id', [1])
    .whereNull('Name');
  await User.query().whereColumn('Id', '=', 'Owner.Id').where('users.legacy_column', 'anything');
  await anyQuery.where('whatever', 1);
  await untyped.where('whatever', 1);
  await baseModel.where('whatever', 1);
  await Upload.query().ofSession('s').where('session_id', 's');
  await User.destroy().where('Id', 1);
  await User.update({ Email: 'x' }).where('Id', 1);

  // @ts-expect-error unknown column
  User.query().where('Nmae', 1);
  // @ts-expect-error the value does not match the column type
  User.query().where('Id', 'x');
  // @ts-expect-error the value does not match the column type behind an operator
  User.query().where('Id', '>', 'x');
  // @ts-expect-error a non-literal column is rejected
  User.query().where(dynamic, 1);
  // @ts-expect-error not an operator
  User.query().where('Id', dynamic, 1);
  // @ts-expect-error unknown column in orWhere
  User.query().orWhere('Nmae', 1);
  // @ts-expect-error unknown column in whereIn
  User.query().whereIn('Nmae', [1]);
  User.query().where(function () {
    // @ts-expect-error unknown column in a nested where
    this.where('Nmae', 1);
  });
  // @ts-expect-error unknown column on a delete
  User.destroy().where('Nmae', 1);
  // @ts-expect-error unknown column after a scope
  Upload.query().ofSession('s').where('sesion_id', 's');
}

export async function columnsStrict(): Promise<void> {
  await User.query().select('Id').select('Email', 'Mail').columns(['Id', 'Email']).select('*').select(new RawQuery('1 AS one'));
  await User.query().orderBy('CreatedAt').orderByDescending('users.Id').order('Email', SortOrder.ASC).groupBy('IsActive').groupBy(new RawQuery('1'));
  await User.query().min('Id', 'low').max('Id').sum('Id', 'total').avg('Id').count('Id');
  await User.query().selectCount('Id');
  await User.update({ Email: 'x' }).increment('Id');

  // @ts-expect-error unknown column in select
  User.query().select('Nope');
  // @ts-expect-error unknown column in columns
  User.query().columns(['Id', 'Nope']);
  // @ts-expect-error unknown column in orderBy
  User.query().orderBy('Nmae');
  // @ts-expect-error unknown column in order
  User.query().order('Nmae', SortOrder.ASC);
  // @ts-expect-error a plain string is rejected by orderBy
  User.query().orderBy(dynamic);
  // @ts-expect-error a plain string is rejected by orderByDescending
  User.query().orderByDescending(dynamic);
  // @ts-expect-error a plain string is rejected by order
  User.query().order(dynamic, SortOrder.ASC);
  await User.query().order({ column: 'Email', order: SortOrder.ASC }).order([{ column: 'users.Id' }, null]);
  // @ts-expect-error unknown column in the object form of order
  User.query().order({ column: 'Nmae', order: SortOrder.ASC });
  // @ts-expect-error a plain string is rejected by the object form of order
  User.query().order([{ column: dynamic }]);
  // @ts-expect-error unknown column in groupBy
  User.query().groupBy('Nmae');
  // @ts-expect-error unknown column in an aggregate
  User.query().max('Nmae', 'm');
  // @ts-expect-error unknown column in increment
  User.update({ Email: 'x' }).increment('Idd');
  // @ts-expect-error a relation is no column
  User.query().select('Team');
}

// A literal qualified name stays unchecked; a non-literal one could name anything, so it is rejected.
export async function literalColumnsStrict(legacy: 'users.legacy_column' | 'teams.Name', declared: ColumnName<User>): Promise<void> {
  await User.query().orderBy('users.legacy_column').orderBy(legacy).orderBy(declared).order(legacy, SortOrder.DESC);
  await User.query().where('users.legacy_column', 1).where(legacy, '>', 1).whereColumn('Id', '=', 'o.Id').columns(['t.Id', legacy, declared]);
  await User.query().order({ column: legacy }).order([{ column: 'x.Id' }, { column: declared, order: SortOrder.ASC }]).count(legacy, 'c');
  await User.where('users.legacy_column', 1).whereIn(legacy, [1]).groupBy(legacy).max(legacy);

  // @ts-expect-error a template pattern in orderBy
  User.query().orderBy(`users.${dynamic}`);
  // @ts-expect-error a template pattern in where
  User.query().where(`${dynamic}.Id`, 1);
  // @ts-expect-error a template pattern in the static where
  User.where(`${dynamic}.Id`, 1);
  // @ts-expect-error a template pattern in the object form of order
  User.query().order({ column: `x.${dynamic}` });
  // @ts-expect-error a template pattern in columns
  User.query().columns([`t.${dynamic}`]);
  // @ts-expect-error a template pattern on the right of whereColumn
  User.query().whereColumn('Id', '=', `o.${dynamic}`);
  // @ts-expect-error a template pattern on the left of whereColumn
  User.query().whereColumn(`o.${dynamic}`, '=', 'Id');
  // @ts-expect-error a template pattern in an aggregate
  User.query().sum(`a${dynamic}.b`, 's');
  // @ts-expect-error a template pattern in increment
  User.update({ Email: 'x' }).increment(`users.${dynamic}`);
}

export async function genericColumns<M>(query: () => ISelectQueryBuilder<M[]>, sort: ColumnName<M>, order: { column: ColumnName<M>; order: SortOrder }): Promise<void> {
  await query().orderBy(sort).orderByDescending(sort).order(sort, SortOrder.ASC).order(order).order([order, { column: sort }]);
  await query().whereNull(sort).whereIn(sort, [1]).groupBy(sort).count(sort, 'c');
  await query().columns([sort]);
}
