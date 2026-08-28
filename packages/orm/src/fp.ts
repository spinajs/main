import { Constructor } from '@spinajs/di';
import { InsertBehaviour } from './interfaces.js';
import { ModelBase } from './model.js';
import { deleteModel, getEntity, insertModel, insertOrUpdateModel, updateModel } from './helpers.js';

/**
 * Functional-style wrappers kept for compatibility and composability -
 * each delegates to its imperative counterpart in helpers.ts.
 */

/**
 *
 * Gets entity from db
 *
 * @param idOrEntity - pkey or entity
 * @param c - entity class constructor
 * @param fresh - if entity, should it refresh from DB ?
 * @returns
 */
export function _getEntity<T extends ModelBase>(idOrEntity: number | T, c: Constructor<T>, fresh?: boolean) {
  return () => getEntity(idOrEntity, c, fresh);
}

/**
 * Update model with data
 *
 * @param data data to update
 * @returns
 */
export function _update<T extends ModelBase>(data?: Partial<T>): (model: T) => Promise<T> {
  return (model: T) => updateModel(model, data);
}

/**
 *
 * Insert model into database
 *
 * @returns
 */
export function _insert<T extends ModelBase>(behaviour?: InsertBehaviour): (model: T | T[]) => Promise<T | T[]> {
  return (model: T | T[]) => insertModel(model, behaviour);
}

export function _insertOrUpdate<T extends ModelBase>(): (model: T) => Promise<T> {
  return (model: T) => insertOrUpdateModel(model);
}

/**
 *
 * Delete model from database
 *
 * @returns
 */
export function _delete<T extends ModelBase>(): (model: T) => Promise<T> {
  return (model: T) => deleteModel(model);
}
