import { col, RawQuery, SortOrder, SqlOperator } from '@spinajs/orm';
import type { ISelectQueryBuilder, ModelBase } from '@spinajs/orm';
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
  await User.query().whereColumn('Id', '=', 'Owner.Id').where(col('legacy_column'), 'anything');
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
  // @ts-expect-error a non-literal column needs col()
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
  // @ts-expect-error unknown column in groupBy
  User.query().groupBy('Nmae');
  // @ts-expect-error unknown column in an aggregate
  User.query().max('Nmae', 'm');
  // @ts-expect-error unknown column in increment
  User.update({ Email: 'x' }).increment('Idd');
  // @ts-expect-error a relation is no column
  User.query().select('Team');
}
