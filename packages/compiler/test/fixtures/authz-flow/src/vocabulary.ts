import type { DeleteQueryBuilder, IDeleteQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder, InsertQueryBuilder, SelectQueryBuilder, SelectQueryBuilderC, UpdateQueryBuilder } from '@spinajs/orm';
import { SYSTEM, authz } from '@spinajs/authz';
import type { Invoice } from './models.js';

export declare const iSelect: ISelectQueryBuilder<Invoice>;
export declare const select: SelectQueryBuilder<Invoice>;
export declare const selectC: SelectQueryBuilderC<Invoice>;
export declare const iUpdate: IUpdateQueryBuilder<Invoice>;
export declare const update: UpdateQueryBuilder<Invoice>;
export declare const iDelete: IDeleteQueryBuilder<Invoice>;
export declare const del: DeleteQueryBuilder<Invoice>;
export declare const insert: InsertQueryBuilder;

export const scoped = (q: ISelectQueryBuilder<Invoice>) => q.accessible('invoice:read').unscoped('vocabulary');
export const copied = (q: ISelectQueryBuilder<Invoice>, c: SelectQueryBuilder<Invoice>) => [q.clone(), c.clone()];
export const systemRun = () => authz().runAs(SYSTEM, 'vocabulary', async () => 1);
