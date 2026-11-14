import type { ColumnName, ColumnRef, ColumnValue, ModelBase, OrmStrict, RawQuery, RelationName, WhereValue } from '@spinajs/orm';
import { assertType } from './assert.js';
import type { Equal } from './assert.js';
import type { Team, User } from './models.js';

assertType<Equal<OrmStrict, false>>();
assertType<Equal<ColumnName<User>, 'Id' | 'Email' | 'Name' | 'IsActive' | 'CreatedAt' | 'DeletedAt'>>();
assertType<Equal<RelationName<User>, 'Metadata' | 'Team' | 'Owner' | 'Maybe' | 'Nul'>>();
assertType<Equal<ColumnName<any>, string>>();
assertType<Equal<ColumnName<unknown>, string>>();
assertType<Equal<ColumnName<ModelBase>, string>>();
assertType<Equal<ColumnValue<User, 'Id'>, number | number[] | RawQuery | null>>();
assertType<Equal<ColumnValue<User, 'Team'>, unknown>>();
assertType<Equal<WhereValue<User, 'Id'>, any>>();

export const free: ColumnRef<User> = 'anything';
export const undeclared: ColumnRef<Team> = 'legacy_column';
export const date: ColumnValue<User, 'CreatedAt'> = new Date();
