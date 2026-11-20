import { DI } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';

import { OrmException } from './exceptions.js';
import type { ModelBase } from './model.js';

/** What `Model.audit()` returns; `@spinajs/audit-orm` adds the members through declaration merging. */
export interface ModelAudit {
  // Keeps the interface non-empty (no-empty-object-type); never set.
  readonly __audit?: never;
}

/** What `row.audit()` returns: the audit events about one row. */
export interface RowAudit {
  // Keeps the interface non-empty (no-empty-object-type); never set.
  readonly __rowAudit?: never;
}

/** Implemented and registered by `@spinajs/audit-orm`. */
export abstract class ModelAuditSource {
  abstract of(model: Constructor<ModelBase>, trail?: string): ModelAudit;
  abstract ofRow(row: ModelBase, trail?: string): RowAudit;
}

export function modelAuditSource(): ModelAuditSource {
  const container = DI.RootContainer;
  if (!container.hasRegistered(ModelAuditSource)) throw new OrmException('Model.audit() needs @spinajs/audit-orm: import it so its ModelAuditSource registers');
  return container.resolve(ModelAuditSource);
}
