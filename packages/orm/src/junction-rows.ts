import _ from 'lodash';
import { columnToDb } from './column-values.js';
import type { IModelDescriptor } from './interfaces.js';
import type { ModelBase } from './model.js';
import { pkColumns, pkGeneration } from './primary-keys.js';
import { writeBackRelationKeys } from './relation-keys.js';
import { refuseWriteOfMissingTable } from './versioning.js';

/** The two key columns of a many-to-many junction table. */
export interface IJunctionColumns {
  sourceColumn: string;
  targetColumn: string;
}

/** One new link: the key values of both sides, and the junction model a relation list holds for the member, if any. */
export interface IJunctionLink {
  ownerKey: unknown;
  targetKey: unknown;
  junction?: ModelBase;
}

export const autoKeyColumns = (descriptor: IModelDescriptor): string[] => pkColumns(descriptor).filter((c) => pkGeneration(descriptor, c) === 'auto');

/**
 * The row of a plain insert for one link: the junction model's own columns through its `toSql()`, then the two key
 * columns through their converters. A generated junction key is never carried over: the row is new even when its model
 * came from another link.
 */
export function junctionRow(descriptor: IModelDescriptor, columns: IJunctionColumns, link: IJunctionLink): Record<string, unknown> {
  // the link's own columns come from the junction model's toSql(), which knows only its declared columns
  if (link.junction) refuseWriteOfMissingTable(descriptor);
  const own = link.junction ? _.omit(link.junction.toSql() as Record<string, unknown>, autoKeyColumns(descriptor)) : {};

  return {
    ...own,
    [columns.sourceColumn]: columnToDb(descriptor, columns.sourceColumn, link.ownerKey, link.junction),
    [columns.targetColumn]: columnToDb(descriptor, columns.targetColumn, link.targetKey, link.junction),
  };
}

/**
 * The columns `fresh`, a new junction model, fills on construction ( defaults, `@CreatedAt`, client-side keys ), in their
 * database form, for a link added without junction data. Read column by column, not through `toSql()`: its not-null
 * check refuses a column that the insert's middleware or the database fills, such as a tenant column. A column the new
 * model leaves empty is left out of the row.
 */
export function constructedJunctionColumns(fresh: ModelBase, descriptor: IModelDescriptor, columns: IJunctionColumns): Record<string, unknown> {
  const managedForeignKeys = new Set([...descriptor.Relations.values()].map((r) => r.ForeignKey));
  const skipped = new Set([columns.sourceColumn, columns.targetColumn, ...autoKeyColumns(descriptor)]);
  const row: Record<string, unknown> = {};

  for (const c of descriptor.Columns) {
    if (c.Virtual || c.Ignore || skipped.has(c.Name) || (c.IsForeignKey && managedForeignKeys.has(c.Name))) {
      continue;
    }

    const value: unknown = Reflect.get(fresh, c.Name);
    if (value !== null && value !== undefined) {
      row[c.Name] = columnToDb(descriptor, c.Name, value, fresh);
    }
  }

  return row;
}

/**
 * Written, a junction model is a row: a later change of its columns is an update. Every @BelongsTo is copied back to
 * its column first, as after `ModelBase.insert()`; the two key columns then take the values the row was written with.
 */
export function settleJunction(junction: ModelBase, columns: IJunctionColumns, link: IJunctionLink): void {
  writeBackRelationKeys(junction);
  Reflect.set(junction, columns.sourceColumn, link.ownerKey);
  Reflect.set(junction, columns.targetColumn, link.targetKey);
  junction.takeSnapshot();
}
