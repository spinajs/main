import type { Constructor } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

export interface TenantModelOptions { isolation?: 'row' | 'schema'; column?: string | false; rls?: boolean }
export declare function Tenant(options?: TenantModelOptions): ClassDecorator;
export declare function registerTenantModel(model: Constructor<ModelBase>, options?: TenantModelOptions): void;

export interface TenantQueryMethods { acrossTenants(reason: string): this }
export type SameQuery<B, _Row> = B;

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> { acrossTenants(reason: string): SameQuery<this, T> }
  interface SelectQueryBuilder<T> { acrossTenants(reason: string): SameQuery<this, T> }
  interface IUpdateQueryBuilder<T> { acrossTenants(reason: string): SameQuery<this, T> }
  interface UpdateQueryBuilder<T> { acrossTenants(reason: string): SameQuery<this, T> }
  interface IDeleteQueryBuilder<T> { acrossTenants(reason: string): SameQuery<this, T> }
  interface DeleteQueryBuilder<T> { acrossTenants(reason: string): SameQuery<this, T> }
}
