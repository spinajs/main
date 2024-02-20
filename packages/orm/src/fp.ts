import { IUpdateResult } from './interfaces.js';
import { ModelBase } from './model.js';

/**
 * Update model with data
 *
 * @param data data to update
 * @returns
 */
export function _update<T extends ModelBase>(data: Partial<T>): (user: T) => Promise<void> {
  return (model: T) => {
    return model.update(data);
  };
}

/**
 *
 * Insert model into database
 *
 * @returns
 */
export function _insert<T extends ModelBase>(): (model: T) => Promise<IUpdateResult> {
  return (model: T) => {
    return model.insert();
  };
}

/**
 *
 * Delete model from database
 *
 * @returns
 */
export function _delete<T extends ModelBase>(): (model: T) => Promise<void> {
  return (model: T) => {
    return model.destroy();
  };
}
