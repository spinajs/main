import _ from 'lodash';
import { RelationType } from './interfaces.js';
import type { ModelBase } from './model.js';

/**
 * The value `model` writes for every foreign key a @BelongsTo currently manages, keyed by column name. A relation
 * holding a target owns its foreign key: `toSql()` writes the target's join-column value ( `Relation.PrimaryKey` — the
 * target's primary key unless `@BelongsTo` names another column ), so a direct write to the column never reaches the
 * database. A relation holding null or undefined owns nothing and is absent here, leaving the column to speak for
 * itself: NULL after a `detach()`, untouched after a `populate()` that found no row.
 *
 * A @Recursive relation is excluded whatever it holds: `toSql()` writes its foreign key from the raw column,
 * overriding the relation, so the column is what reaches the database.
 *
 * The single place that answers "what does this model persist for this column", so the snapshot baseline and the diff
 * can never read the question differently.
 */
export function effectiveForeignKeys(model: ModelBase): Map<string, unknown> {
  const effective = new Map<string, unknown>();

  for (const [, r] of model.ModelDescriptor?.Relations ?? []) {
    if (r.Type !== RelationType.One || !r.ForeignKey || r.Recursive) {
      continue;
    }

    const relation: unknown = Reflect.get(model, r.Name);
    const target: unknown = relation !== null && typeof relation === 'object' ? Reflect.get(relation, 'Value') : undefined;
    if (target !== null && typeof target === 'object') {
      effective.set(r.ForeignKey, Reflect.get(target, r.PrimaryKey));
    }
  }

  return effective;
}

/**
 * The values an UPDATE writes for `changed`. `toSql()` leaves out a relation-managed foreign key that is null while its
 * relation holds nothing, so that an INSERT lets the column default apply; an UPDATE of that change has to write NULL.
 */
export function updateValues(model: ModelBase, changed: readonly string[]): Record<string, unknown> {
  const values = _.pick(model.toSql() as Record<string, unknown>, changed);
  for (const column of changed) {
    if (!(column in values) && Reflect.get(model, column) === null) {
      values[column] = null;
    }
  }

  return values;
}

/**
 * Copies the value each @BelongsTo relation just wrote back onto its foreign-key column, so the model agrees with the
 * row. Call it after a statement that wrote those keys, before `takeSnapshot()`.
 *
 * Without it a foreign key written directly and then overridden by its relation keeps the overridden value in the
 * column, the snapshot records that value as the baseline, and the model reads dirty forever - every `save()` minting
 * an UPDATE that changes nothing.
 */
export function writeBackRelationKeys(model: ModelBase): void {
  for (const [name, value] of effectiveForeignKeys(model)) {
    Reflect.set(model, name, value);
  }
}
