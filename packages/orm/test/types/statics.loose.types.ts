import { SqlOperator } from '@spinajs/orm';
import { assertType } from './assert.js';
import type { Equal } from './assert.js';
import { User } from './models.js';

export async function staticsLoose(dynamic: string): Promise<void> {
  await User.where('Id', 1).where('Nmae', 1);
  await User.where(dynamic, 'x');
  await User.where(dynamic, SqlOperator.EQ, 1);
  await User.where({ Email: 'a' });
  await User.where(true);
  const first = await User.first((b) => {
    b.where('Email', 'x').where(dynamic, 1);
  });
  assertType<Equal<typeof first, User>>();
  void first;
  await User.count((b) => b.where('IsActive', true));
}
