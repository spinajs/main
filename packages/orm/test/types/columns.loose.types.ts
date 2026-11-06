import { col, RawQuery, SqlOperator, Wrapper } from '@spinajs/orm';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { Upload, User } from './models.js';

declare const dynamic: string;
declare const anyQuery: ISelectQueryBuilder<any>;
declare const untyped: ISelectQueryBuilder;

// Loose mode keeps accepting everything that compiled before typed columns.
export async function whereLoose(): Promise<void> {
  await User.query().where('Id', 1).where(dynamic, 'x').where('Nmae', 1).whereIn(dynamic, [1]).whereNull(dynamic);
  await User.query().where(dynamic, SqlOperator.EQ, 1).andWhere('Id', '>', 5).orWhere(function () {
    this.where('Email', 'a');
  });
  await User.query().where({ Email: 'a' }).where(new RawQuery('1 = 1')).where(Wrapper.Text('Email'));
  await User.query().whereColumn('Id', '=', 'Owner.Id').whereBetween(dynamic, [1, 2]).whereStartsWith('Email', 'a');
  await Upload.query().ofSession('s').where('id', 'x');
  await anyQuery.where('whatever', 1).whereIn('x', [1]);
  await untyped.where('whatever', 1);
  await User.destroy().where('Id', 'not a number');
  await User.update({ Email: 'x' }).where(dynamic, 1);
  await User.query().where(col('legacy_column'), 1);
}
