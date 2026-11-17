import { AuditReader } from '@spinajs/audit';
import type { AuditFilter, AuditSubject, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import type { OrmDriver } from '@spinajs/orm';

import { findConnection } from '../rows.js';
import { TableAuditReader } from '../table-reader.js';
import { archiveDriver } from './archive.js';

// The shipper files events under the driver's own name; a trail or a caller may name an alias of it, such as `default`.
const named = (connection: string): string => findConnection(connection)?.Options.Name ?? connection;
const withSource = (trail: TrailConfig): TrailConfig => ({ ...trail, connection: named(trail.connection) });

/**
 * Reads a shipping trail's archive table on its archive connection; `source` selects the connection the events were
 * recorded on. `seq` is the arrival order in the archive, unrelated to the buffer's.
 */
@Injectable(AuditReader)
export class ArchiveAuditReader extends TableAuditReader {
  protected override driver(trail: TrailConfig): OrmDriver {
    return archiveDriver(trail);
  }

  protected override hasSourceColumn(): boolean {
    return true;
  }

  override list(trail: TrailConfig, filter: AuditFilter, by?: 'seq' | 'at'): Promise<readonly StoredAuditEvent[]> {
    return super.list(withSource(trail), filter.source === undefined ? filter : { ...filter, source: named(filter.source) }, by);
  }

  override redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    return super.redact(trail, subject, source === undefined ? undefined : named(source));
  }

  override prune(trail: TrailConfig, before: Date, source?: string): Promise<number> {
    return super.prune(trail, before, source === undefined ? undefined : named(source));
  }
}
