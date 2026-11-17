import { auditStore, trailConfig, trailNames } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneAuditOptions {
  readonly now?: Date;
  /** Only this trail; default every configured trail. */
  readonly trail?: string;
}

// Transactional events sit beside the data they describe, so a trail's table can exist on any connection.
async function sourcesOf(trail: TrailConfig): Promise<string[]> {
  const drivers = new Set<OrmDriver>(DI.get(Orm)?.Connections.values() ?? []);
  const sources: string[] = [];
  for (const driver of drivers) {
    const columns: unknown = await driver.tableInfo(trail.table);
    if (Array.isArray(columns) && columns.length > 0) sources.push(driver.Options.Name);
  }
  return sources;
}

/** Deletes the events older than each trail's `retentionDays`: per connection that holds the trail's table, or once for a trail with an archive. A trail without `retentionDays`, or whose store has no reader, keeps everything. */
export async function pruneAudit(options: PruneAuditOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  let deleted = 0;
  for (const name of options.trail === undefined ? trailNames() : [options.trail]) {
    const trail = trailConfig(name);
    if (trail.retentionDays === undefined) continue;
    const reader = await (await auditStore(trail)).reader(trail);
    if (!reader) continue;
    const before = new Date(now.getTime() - trail.retentionDays * DAY_MS);
    // An archive holds the events of every source connection in one table, and none of them has the archive connection as its source.
    const sources: readonly (string | undefined)[] = trail.archiveConnection === undefined ? await sourcesOf(trail) : [undefined];
    for (const source of sources) deleted += await reader.prune(trail, before, source);
  }
  return deleted;
}
