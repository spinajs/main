import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Orm, type OrmDriver } from '@spinajs/orm';
import { WORKFLOW_CONNECTION } from './workflow-config.js';

export async function workflowDriver(): Promise<OrmDriver> {
  const driver = (await DI.resolve(Orm)).Connections.get(WORKFLOW_CONNECTION);
  if (!driver) throw new InvalidOperation(`workflow: ORM connection '${WORKFLOW_CONNECTION}' not found; map it with db.Aliases.workflow`);
  return driver;
}
