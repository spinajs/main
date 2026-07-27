/* eslint-disable prettier/prettier */
import { OrmException } from './exceptions.js';
import { IModelDescriptor, IRelationDescriptor, OrphanPolicy } from './interfaces.js';

/**
 * Decides what to do with a row removed from `relation`.
 *
 * An explicit policy on the decorator always wins. With no explicit policy the default is
 * `nullify`, falling back to `delete` only when the child's foreign key demonstrably cannot
 * hold NULL: the column must be present in the target descriptor, be reflected from the
 * database ( `NativeType` non-empty ) and be declared non-nullable.
 *
 * The conservative guard matters because `_prepareColumnDesc` defaults `Nullable` to `false`
 * for a decorator-declared column, so a model whose table info has not been loaded would
 * otherwise report every column as non-nullable and silently escalate to DELETE. A `nullify`
 * the database rejects is a loud, recoverable failure; a wrong DELETE is not.
 *
 * @param relation - the hasMany / manyToMany relation the member was removed from
 * @param target - descriptor of the model on the other side of that relation
 */
export function resolveOrphanPolicy(relation: IRelationDescriptor, target: IModelDescriptor): OrphanPolicy {
  const policy = relation.Orphan ?? defaultPolicy(relation, target);

  if (policy === OrphanPolicy.SoftDelete && !target.SoftDelete?.DeletedAt) {
    throw new OrmException(`relation ${relation.Name} declares orphan policy soft-delete but model ${target.Name} has no @SoftDelete column`);
  }

  return policy;
}

function defaultPolicy(relation: IRelationDescriptor, target: IModelDescriptor): OrphanPolicy {
  const column = target.Columns?.find((c) => c.Name === relation.ForeignKey);

  if (!column) {
    return OrphanPolicy.Nullify;
  }

  // An unreflected column carries `Nullable: false` from the decorator defaults, which says
  // nothing about the database. Only escalate when the database actually told us.
  if (!column.NativeType) {
    return OrphanPolicy.Nullify;
  }

  return column.Nullable ? OrphanPolicy.Nullify : OrphanPolicy.Delete;
}
