import { col, RawQuery, SqlOperator } from '@spinajs/orm';
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
