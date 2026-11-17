import { AuditConfigError, listAudit, trailConfig } from '@spinajs/audit';
import type { AuditQuery, StoredAuditEvent } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { ModelAuditSource, extractModelDescriptor } from '@spinajs/orm';
import type { ModelAudit, ModelBase, RowAudit } from '@spinajs/orm';

declare module '@spinajs/orm' {
  interface ModelAudit {
    /** What was recorded about one row, oldest first. */
    of(id: string | number | bigint, query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
    /** What was recorded about the rows of this model after `seq`. */
    since(seq: number, query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
  }
  interface RowAudit {
    /** What was recorded about this row, oldest first. */
    entries(query?: AuditQuery): Promise<readonly StoredAuditEvent[]>;
  }
}

interface Named {
  readonly name: string;
}

/** The subject type of a model's rows: its table name. */
export function auditSubjectType(model: Named): string {
  const table = extractModelDescriptor(model)?.TableName;
  if (!table) throw new AuditConfigError(`audit: ${model.name} is not an ORM model with a table`);
  return table;
}

function modelAudit(model: Named, trail: string | undefined): ModelAudit {
  const config = trailConfig(trail);
  const type = auditSubjectType(model);
  // Transactional events sit beside the model's rows, so its connection is the default source.
  const scoped = (query: AuditQuery | undefined): AuditQuery => ({ ...query, source: query?.source ?? extractModelDescriptor(model)?.Driver?.Options.Name });
  return {
    of: (id, query) => listAudit(config, 'Model.audit().of', { subject: { type, id: typeof id === 'string' ? id : id.toString() } }, scoped(query)),
    since: (seq, query) => listAudit(config, 'Model.audit().since', { subjectType: type }, { ...scoped(query), afterSeq: Math.max(seq, query?.afterSeq ?? seq) }),
  };
}

@Injectable(ModelAuditSource)
export class OrmModelAuditSource extends ModelAuditSource {
  of(model: Constructor<ModelBase>, trail?: string): ModelAudit {
    return modelAudit(model, trail);
  }

  ofRow(row: ModelBase, trail?: string): RowAudit {
    const model: Named = row.constructor;
    const key: unknown = row.PrimaryKeyValue;
    if (typeof key !== 'string' && typeof key !== 'number' && typeof key !== 'bigint') {
      throw new AuditConfigError(`audit: this ${model.name} has no single primary key value yet, so no event can be about it; save it first`);
    }
    const all = modelAudit(model, trail);
    return { entries: (query) => all.of(key, query) };
  }
}
