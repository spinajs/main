import { Constructor } from '@spinajs/di';
import { IUpdateResult } from './interfaces.js';
import { ModelBase } from './model.js';
import _ from 'lodash';
import { ErrorCode } from '@spinajs/exceptions';

export enum E_ORM_CODES {
  E_NO_ROWS_AFFECTED,
}

/**
 *
 * Gets entity from db
 *
 * @param idOrEntity - pkey or entity
 * @param c - entity class constructor
 * @param fresh - if entity, should it refresh from DB ?
 * @returns
 */
export function _get_entity<T extends ModelBase>(idOrEntity: number | T, c: Constructor<T>, fresh?: boolean) {
  return async () => {
    if (_.isNumber(idOrEntity)) {
      return (c as any).get(idOrEntity);
    }

    if (fresh) {
      return idOrEntity.fresh();
    }

    return Promise.resolve(idOrEntity);
  };
}

/**
 * Update model with data
 *
 * @param data data to update
 * @returns
 */
export function _update<T extends ModelBase>(data?: Partial<T>): (data: T) => Promise<T> {
  return (model: T) => {
    return model.update(data).then((res: IUpdateResult) => {
      if (res.LastInsertId <= 0 || res.RowsAffected <= 0) {
        return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
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
        return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
      }

      return model;
    });
  };
}

export function _insertOrUpdate<T extends ModelBase>(): (model: T) => Promise<T> {
  return (model: T) => {
    return model.insertOrUpdate().then((res: IUpdateResult) => {
      if (res.LastInsertId <= 0 || res.RowsAffected <= 0) {
        return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
      }

      return model;
    });
  }
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
        return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
      }

      return model;
    });
  };
}
