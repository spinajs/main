import { Constructor } from '@spinajs/di';
import { InsertBehaviour, IUpdateResult } from './interfaces.js';
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
    // A clean model short-circuits to { RowsAffected: 0 } - that is a no-op success,
    // not a failure, so we always resolve the model.
    return model.update(data).then(() => model);
  };
}

/**
 *
 * Insert model into database
 *
 * @returns
 */
export function _insert<T extends ModelBase>(behaviour?: InsertBehaviour): (model: T | T[]) => Promise<T | T[]> {
  return (model: T | T[]) => {
    if (_.isArray(model)) {
      if (model.length === 0) {
        return Promise.resolve(model);
      }
      return (model[0].constructor as typeof ModelBase).insert(model, behaviour).then((res: IUpdateResult) => {
        // UUID / non-auto-increment PKs yield LastInsertId 0 on a successful insert,
        // so only RowsAffected signals failure.
        if (res.RowsAffected <= 0) {
          return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
        }

        return model;
      }) as Promise<T[]>;
    }

    return model.insert(behaviour).then((res: IUpdateResult) => {
      if (res.RowsAffected <= 0) {
        return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
      }

      return model;
    });
  };
}

export function _insertOrUpdate<T extends ModelBase>(): (model: T) => Promise<T> {
  return (model: T) => {
    // insertOrUpdate on a clean model is a no-op success (RowsAffected 0) - resolve the model.
    return model.insertOrUpdate().then(() => model);
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
      if (res.RowsAffected <= 0) {
        return Promise.reject(new ErrorCode(E_ORM_CODES.E_NO_ROWS_AFFECTED));
      }

      return model;
    });
  };
}
