/* eslint-disable prettier/prettier */
import { OrmException } from './exceptions.js';
import { IModelDescriptor, IRelationDescriptor, OrphanPolicy } from './interfaces.js';

/**
 * Decides what to do with a row removed from `relation`.
 *
 * An explicit policy on the decorator always wins. With no explicit policy the default is
 * `nullify` — the only non-destructive answer.
 *
 * When the child's foreign key demonstrably cannot hold NULL ( the column is present in the
 * target descriptor, reflected from the database with a non-empty `NativeType`, and declared
 * non-nullable ) `nullify` cannot work either. This used to silently escalate to DELETE.
 * It now throws: destroying rows is not something to infer from a schema detail the developer
 * never pointed at. The same reasoning the old code gave for its conservative guard applies
 * here — *"a `nullify` the database rejects is a loud, recoverable failure; a wrong DELETE is
 * not"* — and an unasked-for DELETE is the unrecoverable branch, so it must be declared.
 *
 * The reflection guard still matters in the other direction: `_prepareColumnDesc` defaults
 * `Nullable` to `false` for a decorator-declared column, so a model whose table info has not
 * been loaded reports every column as non-nullable. Without the `NativeType` check that
 * would turn every unreflected model into a hard error.
 *
 * @param relation - the hasMany / manyToMany relation the member was removed from
 * @param target - descriptor of the model on the other side of that relation
 * @throws OrmException when no policy is declared and `nullify` cannot be applied, or when
 *         `soft-delete` is declared on a model with no `@SoftDelete` column
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
  // nothing about the database. Only act on what the database actually told us.
  if (!column.NativeType) {
    return OrphanPolicy.Nullify;
  }

  if (column.Nullable) {
    return OrphanPolicy.Nullify;
  }

  throw new OrmException(
    `relation ${relation.Name} on ${target.Name} removes rows whose foreign key ${relation.ForeignKey} is NOT NULL, so the default orphan policy 'nullify' cannot be applied. ` +
      `Declare what should happen explicitly: @HasMany(..., { orphan: OrphanPolicy.Delete }) to remove the row, OrphanPolicy.SoftDelete to stamp it, or OrphanPolicy.Disable to leave it alone. ` +
      `Removing rows is never inferred from schema nullability.`,
  );
}
