import { col } from '@spinajs/orm';
import type { ColumnRef, OrmStrict, RawQuery, WhereCatchAllColumn, WhereValue } from '@spinajs/orm';
import { assertType } from '../assert.js';
import type { Equal } from '../assert.js';
import type { User } from '../models.js';

assertType<Equal<OrmStrict, true>>();
assertType<Equal<WhereValue<User, 'Id'>, number | number[] | RawQuery | null>>();
assertType<Equal<WhereCatchAllColumn<User>, never>>();

// @ts-expect-error strict mode has no free-form column name
export const free: ColumnRef<User> = 'anything';
export const qualified: ColumnRef<User> = 'users.Id';
export const literal: ColumnRef<User> = col('legacy_column');
export const date: WhereValue<User, 'CreatedAt'> = new Date();
