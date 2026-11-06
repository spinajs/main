import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, SelectQueryBuilder, type OrmDriver } from '@spinajs/orm';
import { WORKFLOW_CONNECTION } from './workflow-config.js';

/**
 * Bet 3 O10 (`v4-o-10-replicas`) adds `onPrimary()` to `SelectQueryBuilder`, which routes the select to the primary
 * instead of a read replica. Until that branch is merged this makes the call compile and run as a no-op, so every
 * primary read of this package is marked from day one. Delete the augmentation and the patch once O10 is in.
 */
declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    onPrimary(): ISelectQueryBuilder<T>;
  }
}

const selectPrototype = SelectQueryBuilder.prototype as { onPrimary?: () => unknown };
if (typeof selectPrototype.onPrimary !== 'function') {
  selectPrototype.onPrimary = function (this: unknown) {
    return this;
  };
}

export async function workflowDriver(): Promise<OrmDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get(WORKFLOW_CONNECTION);
  if (!driver) throw new InvalidOperation(`workflow: ORM connection '${WORKFLOW_CONNECTION}' not found; map it with db.Aliases.workflow`);
  return driver;
}
