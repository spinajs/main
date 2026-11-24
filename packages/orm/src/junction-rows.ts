import _ from 'lodash';
import { columnToDb } from './column-values.js';
import type { IModelDescriptor } from './interfaces.js';
import type { ModelBase } from './model.js';
import { pkColumns, pkGeneration } from './primary-keys.js';

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

/**
 * The row of a plain insert for one link: the junction model's own columns through its `toSql()`, then the two key
 * columns through their converters. A generated junction key is never carried over: the row is new even when its model
 * came from another link.
 */
export function junctionRow(descriptor: IModelDescriptor, columns: IJunctionColumns, link: IJunctionLink): Record<string, unknown> {
  const generated = pkColumns(descriptor).filter((c) => pkGeneration(descriptor, c) === 'auto');
  const own = link.junction ? _.omit(link.junction.toSql() as Record<string, unknown>, generated) : {};

  return {
    ...own,
    [columns.sourceColumn]: columnToDb(descriptor, columns.sourceColumn, link.ownerKey, link.junction),
    [columns.targetColumn]: columnToDb(descriptor, columns.targetColumn, link.targetKey, link.junction),
  };
}

/** Written, a junction model is a row: a later change of its columns is an update. */
export function settleJunction(junction: ModelBase, columns: IJunctionColumns, link: IJunctionLink): void {
  Reflect.set(junction, columns.sourceColumn, link.ownerKey);
  Reflect.set(junction, columns.targetColumn, link.targetKey);
  junction.takeSnapshot();
}
