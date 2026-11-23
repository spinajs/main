import { trailConfig } from '@spinajs/audit';
import { AuditTrailTableMigration } from '@spinajs/audit-orm';
import { Migration } from '@spinajs/orm';

import { DEFAULT_HISTORY_TRAIL } from './rules.js';

/** The table of the built-in `history` trail on the default connection. Another connection: a subclass with its own `@Migration`. */
@Migration('default')
export class OrmHistory_2026_11_16_00_00_00 extends AuditTrailTableMigration {
  protected override table(): string {
    return trailConfig(DEFAULT_HISTORY_TRAIL).table;
  }
}
