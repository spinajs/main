import { ModelBase, OrmException, extractModelDescriptor, wherePk, IDeleteQueryBuilder, IQueryBuilder, ISelectQueryBuilder, IUpdateQueryBuilder } from '@spinajs/orm';
import { IRbacModelDescriptor } from './interfaces.js';
import type { User } from './models/User.js';

/**
 * Implementation of the ownership helpers declared on `IModelStatic` in
 * `interfaces.ts`. They were previously declared but never implemented, so any
 * call to `Model.ensureOwnership` / `Model.checkOwnership` threw
 * "not a function". They are attached to `ModelBase` so every model gets them.
 *
 * A model participates in ownership checks by decorating its owner column with
 * `@ResourceOwner()`, which sets `OwnerField` on the model descriptor.
 */

function rbacDescriptor(model: unknown): IRbacModelDescriptor {
  const descriptor = extractModelDescriptor(model as any) as IRbacModelDescriptor;

  if (!descriptor || !descriptor.OwnerField) {
    const name = descriptor?.Name ?? (model as any)?.name;
    throw new OrmException(`Model ${name} does not have an @ResourceOwner() field, cannot check ownership`);
  }

  return descriptor;
}

/**
 * Alters a query so it only returns/updates/deletes rows owned by `user`.
 */
(ModelBase as unknown as { ensureOwnership: unknown }).ensureOwnership = function (
  this: unknown,
  query: ISelectQueryBuilder<any> | IUpdateQueryBuilder<any> | IDeleteQueryBuilder<any>,
  user: User,
): IQueryBuilder {
  const descriptor = rbacDescriptor(this);
  return (query as any).where(descriptor.OwnerField, user.PrimaryKeyValue);
};

/**
 * Checks whether a model (or its primary key) is owned by `user`.
 * When passed a loaded model the owner column is compared in memory; when
 * passed a primary key the ownership is verified with a scoped DB query.
 */
(ModelBase as unknown as { checkOwnership: unknown }).checkOwnership = async function (
  this: unknown,
  modelOrPrimaryKey: ModelBase<any> | string | number,
  user: User,
): Promise<boolean> {
  const descriptor = rbacDescriptor(this);

  if (modelOrPrimaryKey instanceof ModelBase) {
    return (modelOrPrimaryKey as any)[descriptor.OwnerField] === user.PrimaryKeyValue;
  }

  // `descriptor.PrimaryKey` is a string[] since the composite-key refactor, so it cannot be
  // handed to `where()` as a column name — that took the whereObject path and filtered on
  // nothing. `wherePk` is the ORM's single home for key predicates and handles both shapes.
  const query = (this as any).query();
  wherePk(query, descriptor, modelOrPrimaryKey);

  const found = await query.where(descriptor.OwnerField, user.PrimaryKeyValue).first();

  return found !== undefined && found !== null;
};
