import { DI, Class } from '@spinajs/di';
import { MODELS } from '../tokens.js';
import { OrmConnectionMissing, OrmNotResolved } from '../exceptions.js';
import { QueryScope } from '../interfaces.js';
import type { OrmDriver } from '../driver.js';
import { ModelBase } from '../model.js';
import { DiscriminationMapMiddleware } from '../discrimination-middleware.js';
import { extractModelDescriptor } from '../descriptor.js';
import { QueryBuilder } from './base.js';
import { SelectQueryBuilder } from './select.js';
import { DeleteQueryBuilder } from './delete.js';
import { UpdateQueryBuilder } from './update.js';

export function _descriptor(model: Class<any>) {
  return extractModelDescriptor(model);
}

/**
 * Helper function to create query based on model
 *
 * @param model - source model for query
 * @param query - query class
 * @param injectModel - should inject model information into query, if not, query will return raw data
 * @param via - runs the query on this connection instead of the model's own - one on the same server
 *        ( see `IDriverOptions.SharedServer` ). The table stays qualified with the model's database.
 *
 * @returns
 */
export function createQuery<T extends QueryBuilder>(model: Class<any>, query: Class<T>, injectModel = true, via?: OrmDriver) {
  const dsc = _descriptor(model);

  if (!dsc) {
    throw new Error(`model ${model.name} does not have model descriptor. Use @model decorator on class`);
  }

  if (!DI.check('OrmConnection')) {
    throw new OrmNotResolved(`${model.name}: the Orm has not created its connections yet; inject or resolve the Orm first`);
  }

  const own = DI.resolve<OrmDriver>('OrmConnection', [dsc.Connection]);

  if (!own) {
    throw new OrmConnectionMissing(`model ${model.name} have invalid connection ${dsc.Connection}, please check your db config file or model connection name`, dsc.Connection!);
  }

  const driver = via ?? own;

  const cnt = driver.Container;
  const models = DI.getRegisteredTypes<ModelBase>(MODELS.key) ?? [];
  const qr = cnt.resolve<T>(query, [driver, injectModel ? models.find((x) => x.name === model.name) : undefined]);

  // Query scopes bind to every statement type that can carry a WHERE clause, not just selects.
  // `ModelBase.destroy()` and `ModelBase.update()` already DECLARE the scope intersection in
  // their return types ( model.ts ), so a select-only binding made those types lie at runtime.
  // InsertQueryBuilder is deliberately excluded: it has no WHERE clause to narrow.
  if (qr instanceof SelectQueryBuilder || qr instanceof DeleteQueryBuilder || qr instanceof UpdateQueryBuilder) {
    const scope = (model as any)._queryScopes as QueryScope;
    if (scope) {
      Object.getOwnPropertyNames((scope as any).__proto__)
        .filter((x) => x !== 'constructor')
        .forEach(function (property) {
          if (typeof (scope as any)[property] === 'function') {
            (qr as any)[property] = (scope as any)[property].bind(qr);
          }
        });
    }
  }

  qr.middleware(new DiscriminationMapMiddleware(dsc));
  qr.setTable(dsc.TableName);

  // Soft-delete read filtering: by default exclude rows that have been soft
  // deleted (DeletedAt IS NOT NULL). SelectQueryBuilder.withDeleted() removes
  // this default statement to include soft-deleted rows again.
  // Guarded on the DeletedAt column actually being present in the model's
  // reflected columns — a filter on a column the schema does not expose is
  // impossible anyway, and the guard keeps queries working when table info
  // has not (yet) surfaced the column.
  if (qr instanceof SelectQueryBuilder && dsc.SoftDelete?.DeletedAt && dsc.Columns?.some((c) => c.Name === dsc.SoftDelete.DeletedAt)) {
    (qr as unknown as SelectQueryBuilder).whereNull(dsc.SoftDelete.DeletedAt);
  }

  // Archive read filtering, symmetric with the soft-delete block above: by default exclude rows
  // that have been archived ( ArchivedAt IS NOT NULL ). SelectQueryBuilder.withArchived() removes
  // this default statement. Same column-presence guard, for the same reason.
  if (qr instanceof SelectQueryBuilder && dsc.Archived?.ArchivedAt && dsc.Columns?.some((c) => c.Name === dsc.Archived.ArchivedAt)) {
    (qr as unknown as SelectQueryBuilder).whereNull(dsc.Archived.ArchivedAt);
  }

  if (own.Options.Database) {
    qr.database(own.Options.Database);
  }

  return {
    query: qr,
    description: dsc,
    model,
    container: driver.Container,
  };
}
