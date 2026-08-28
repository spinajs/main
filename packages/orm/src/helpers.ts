import { Constructor } from '@spinajs/di';
import { InsertBehaviour, IUpdateResult } from './interfaces.js';
import { ModelBase } from './model.js';
import _ from 'lodash';
import { NoRowsAffected } from './exceptions.js';

/**
 *
 * Gets entity from db
 *
 * @param idOrEntity - pkey or entity
 * @param c - entity class constructor
 * @param fresh - if entity, should it refresh from DB ?
 * @returns
 */
export async function getEntity<T extends ModelBase>(idOrEntity: number | T, c: Constructor<T>, fresh?: boolean): Promise<T> {
  if (_.isNumber(idOrEntity)) {
    return (c as any).get(idOrEntity);
  }

  if (fresh) {
    return idOrEntity.fresh() as Promise<T>;
  }

  return idOrEntity;
}

/**
 * Update model with data
 *
 * @param model model to update
 * @param data data to update
 * @returns
 */
export async function updateModel<T extends ModelBase>(model: T, data?: Partial<T>): Promise<T> {
  // A clean model short-circuits to { RowsAffected: 0 } - that is a no-op success,
  // not a failure, so we always resolve the model.
  await model.update(data);
  return model;
}

/**
 *
 * Insert model into database
 *
 * @param model model or models to insert
 * @param behaviour insert behaviour
 * @returns
 */
export async function insertModel<T extends ModelBase>(model: T | T[], behaviour?: InsertBehaviour): Promise<T | T[]> {
  if (_.isArray(model)) {
    if (model.length === 0) {
      return model;
    }

    const res: IUpdateResult = await (model[0].constructor as typeof ModelBase).insert(model, behaviour);

    // `uuid` and `assigned` primary keys report LastInsertId 0 on a successful insert, so
    // only RowsAffected signals failure. See @Primary({ generated }) in the ORM docs.
    if (res.RowsAffected <= 0) {
      throw new NoRowsAffected();
    }

    return model;
  }

  const res: IUpdateResult = await model.insert(behaviour);
  if (res.RowsAffected <= 0) {
    throw new NoRowsAffected();
  }

  return model;
}

export async function insertOrUpdateModel<T extends ModelBase>(model: T): Promise<T> {
  // insertOrUpdate on a clean model is a no-op success (RowsAffected 0) - resolve the model.
  await model.insertOrUpdate();
  return model;
}

/**
 *
 * Delete model from database
 *
 * @param model model to delete
 * @returns
 */
export async function deleteModel<T extends ModelBase>(model: T): Promise<T> {
  const res = (await model.destroy()) as IUpdateResult;
  if (res.RowsAffected <= 0) {
    throw new NoRowsAffected();
  }

  return model;
}
