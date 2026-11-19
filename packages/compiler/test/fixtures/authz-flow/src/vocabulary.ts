import type { DeleteQueryBuilder, IDeleteQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder, InsertQueryBuilder, SelectQueryBuilder, SelectQueryBuilderC, UpdateQueryBuilder } from '@spinajs/orm';
import { SYSTEM, authz, type DefaultAuthzService } from '@spinajs/authz';
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
export declare const host: DefaultAuthzService;
export const hostRun = () => host.runAs(SYSTEM, 'vocabulary', async () => 1);
export const scopedEach = () => [
  iSelect.accessible('invoice:read'), iSelect.unscoped('vocabulary'),
  select.accessible('invoice:read'), select.unscoped('vocabulary'),
  iUpdate.accessible('invoice:read'), iUpdate.unscoped('vocabulary'),
  update.accessible('invoice:read'), update.unscoped('vocabulary'),
  iDelete.accessible('invoice:read'), iDelete.unscoped('vocabulary'),
  del.accessible('invoice:read'), del.unscoped('vocabulary'),
];
