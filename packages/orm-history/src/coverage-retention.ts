import { AuditRetentionListener } from '@spinajs/audit-orm';
import { DI, Injectable } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { holdsCoverageTable, moveCoverage } from './coverage-table.js';

/**
 * Moves the coverage of a trail up to a retention cutoff before the older events are deleted: a reader must never
 * take a pruned row for an unchanged one. A failure here keeps the events of that connection.
 */
@Injectable(AuditRetentionListener)
export class CoverageRetentionListener extends AuditRetentionListener {
  public async beforePrune(trail: string, connection: string | undefined, cutoff: Date): Promise<void> {
    const orm = DI.get(Orm);
    if (!orm) return;
    // Without a connection the trail has an archive, pruned once for the events of every source connection.
    const drivers: readonly (OrmDriver | undefined)[] = connection === undefined ? [...new Set(orm.Connections.values())] : [orm.Connections.get(connection)];
    for (const driver of drivers) {
      // A connection without the table holds no coverage to move, whatever trail is pruned there.
      if (driver !== undefined && (await holdsCoverageTable(driver))) await moveCoverage(driver, trail, cutoff);
    }
  }
}
