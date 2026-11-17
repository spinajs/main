import { AuditConfigError, listAudit, trailConfig } from '@spinajs/audit';
import type { AuditFilter, AuditQuery, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { DI, Injectable } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { ModelAuditSource, Orm, extractModelDescriptor } from '@spinajs/orm';
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

type By = Pick<AuditFilter, 'subject' | 'subjectType'>;

const DEFAULT_LIMIT = 100;

/** The subject type of a model's rows: its table name. */
export function auditSubjectType(model: Named): string {
  const table = extractModelDescriptor(model)?.TableName;
  if (!table) throw new AuditConfigError(`audit: ${model.name} is not an ORM model with a table`);
  return table;
}

// Aliases such as `default` name the same driver as its own name.
const driverName = (connection: string): string => DI.get(Orm)?.Connections.get(connection)?.Options.Name ?? connection;

async function holdsTable(trail: TrailConfig, connection: string): Promise<boolean> {
  // An archive keeps every source in one table on its own connection; a source that wrote nothing reads as empty.
  if (trail.archiveConnection !== undefined) return true;
  try {
    const columns: unknown = await DI.get(Orm)?.Connections.get(connection)?.tableInfo(trail.table);
    return Array.isArray(columns) && columns.length > 0;
  } catch {
    return false;
  }
}

/** Transactional events sit on the model's connection, confirmed and deferred ones on the trail's: both are read and merged by time. */
async function listBoth(trail: TrailConfig, operation: string, by: By, query: AuditQuery, connections: readonly string[]): Promise<readonly StoredAuditEvent[]> {
  if ((query.afterSeq ?? 0) > 0) {
    throw new AuditConfigError(`audit: afterSeq is a position on one connection, and ${operation} reads trail ${JSON.stringify(trail.name)} on ${connections.map((c) => JSON.stringify(c)).join(' and ')}; pass query.source to page one of them`);
  }
  const lists = await Promise.all(connections.map(async (source) => ((await holdsTable(trail, source)) ? (await listAudit(trail, operation, by, { ...query, source })).map((event) => ({ event, source })) : [])));
  const direction = query.order === 'desc' ? -1 : 1;
  const merged = lists.flat().sort((a, b) => direction * (a.event.at.getTime() - b.event.at.getTime() || a.source.localeCompare(b.source) || a.event.seq - b.event.seq));
  return merged.slice(0, query.limit ?? DEFAULT_LIMIT).map((m) => m.event);
}

function modelAudit(model: Named, trail: string | undefined): ModelAudit {
  const config = trailConfig(trail);
  const type = auditSubjectType(model);
  const modelConnection = extractModelDescriptor(model)?.Driver?.Options.Name;
  const read = (operation: string, by: By, query: AuditQuery = {}): Promise<readonly StoredAuditEvent[]> => {
    if (query.source !== undefined || modelConnection === undefined) return listAudit(config, operation, by, { ...query, source: query.source ?? modelConnection });
    const own = driverName(modelConnection);
    const trails = driverName(config.connection);
    if (own === trails) return listAudit(config, operation, by, { ...query, source: own });
    return listBoth(config, operation, by, query, [own, trails]);
  };
  return {
    of: (id, query) => read('Model.audit().of', { subject: { type, id: typeof id === 'string' ? id : id.toString() } }, query),
    since: (seq, query) => read('Model.audit().since', { subjectType: type }, { ...query, afterSeq: Math.max(seq, query?.afterSeq ?? seq) }),
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
