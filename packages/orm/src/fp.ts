import { IUpdateResult } from './interfaces.js';
import { ModelBase } from './model.js';

/**
 * Update model with data
 *
 * @param data data to update
 * @returns
 */
export function _update<T extends ModelBase>(data?: Partial<T>): (user: T) => Promise<T> {
  return (model: T) => {
    return model.update(data).then((res: IUpdateResult) => {
      if (res.LastInsertId <= 0 || res.RowsAffected <= 0) {
        return Promise.reject('E_NO_ROWS_AFFECTED');
      }

      return model;
    });
  };
}

/**
 *
 * Insert model into database
 *
 * @returns
 */
export function _insert<T extends ModelBase>(): (model: T) => Promise<T> {
  return (model: T) => {
    return model.insert().then((res: IUpdateResult) => {
      if (res.LastInsertId <= 0 || res.RowsAffected <= 0) {
        return Promise.reject('E_NO_ROWS_AFFECTED');
      }
      
      return model;
    });
  };
}

/**
 *
 * Delete model from database
 *
 * @returns
 */
export function _delete<T extends ModelBase>(): (model: T) => Promise<T> {
  return (model: T) => {
    return model.destroy().then((res: IUpdateResult) => {
      if (res.LastInsertId <= 0 || res.RowsAffected <= 0) {
        return Promise.reject('E_NO_ROWS_AFFECTED');
      }

      return model;
    });
  };
}
