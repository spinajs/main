import { AuditConfigError } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import type { OrmDriver } from '@spinajs/orm';

import { assertOwnTable } from '../own-tables.js';
import { auditConnection } from '../rows.js';
import { TableAuditStore } from '../table-store.js';

/** The connection that holds a shipping trail's archive table, named by the trail option `archiveConnection`. */
export function archiveDriver(trail: TrailConfig): OrmDriver {
  if (trail.archiveConnection === undefined) throw new AuditConfigError(`audit: audit.trails.${trail.name}.archiveConnection is not set; name the ORM connection that holds the archive table ${JSON.stringify(trail.table)}`);
  assertOwnTable(trail, TableAuditStore);
  return auditConnection(trail.archiveConnection);
}
