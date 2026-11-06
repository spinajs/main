import { col, RawQuery, SortOrder, SqlOperator, Wrapper } from '@spinajs/orm';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { Upload, User } from './models.js';
import { assertType } from './assert.js';
import type { Equal } from './assert.js';

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

export async function columnsLoose(): Promise<void> {
  await User.query().select(dynamic).select('Nope', 'alias').columns([dynamic, 'x']).orderBy(dynamic).orderByDescending('Nope');
  await User.query().order(dynamic, SortOrder.DESC).order({ column: 'x', order: SortOrder.ASC }).groupBy(dynamic).groupBy(new RawQuery('1'));
  await User.query().min(dynamic).max('Nope', 'm').sum(dynamic, 's').avg(dynamic).count(dynamic, 'c').selectCount(dynamic);
  await User.query().select(new RawQuery('COUNT(*) AS c')).select(new Map([['Id', 'i']])).select('*');
  await User.update({ Email: 'x' }).increment(dynamic, 2);
  const _all = await User.query().select('Id');
  assertType<Equal<typeof _all, User[]>>();
}
