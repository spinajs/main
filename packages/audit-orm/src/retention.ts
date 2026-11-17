import { AuditWriteFailed, auditStore, trailConfig, trailNames } from '@spinajs/audit';
import type { AuditReader, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { assertOwnTables } from './table-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A table of the trail's name that lacks these is not a trail table, and retention leaves it alone.
const TRAIL_COLUMNS = ['seq', 'at', 'data_hash'];

export interface PruneAuditOptions {
  readonly now?: Date;
  /** Only this trail; default every configured trail. */
  readonly trail?: string;
}

export interface PruneFailure {
  readonly trail: string;
  /** Undefined when the trail failed before a connection was chosen, or for the single prune of a trail with an archive. */
  readonly connection: string | undefined;
  readonly error: unknown;
}

/** Thrown by `pruneAudit` after it pruned every trail and connection it could; `deleted` counts those. */
export class AuditPruneFailed extends AuditWriteFailed {
  constructor(public readonly deleted: number, public readonly failed: readonly PruneFailure[]) {
    super(`audit: retention failed for ${failed.map((f) => (f.connection === undefined ? f.trail : `${f.trail}@${f.connection}`)).join(', ')}; the other trails were pruned`, failed[0]?.error);
  }
}

function columnNames(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  const list: readonly unknown[] = columns;
  const names: string[] = [];
  for (const column of list) {
    const name: unknown = column !== null && typeof column === 'object' ? Reflect.get(column, 'Name') : undefined;
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

interface Run {
  deleted: number;
  readonly failed: PruneFailure[];
}

// Transactional events sit beside the data they describe, so a trail's table can exist on any connection.
async function sourcesOf(trail: TrailConfig, run: Run): Promise<string[]> {
  const drivers = new Set<OrmDriver>(DI.get(Orm)?.Connections.values() ?? []);
  const sources: string[] = [];
  for (const driver of drivers) {
    try {
      const names = columnNames(await driver.tableInfo(trail.table));
      if (TRAIL_COLUMNS.every((c) => names.includes(c))) sources.push(driver.Options.Name);
    } catch (error) {
      run.failed.push({ trail: trail.name, connection: driver.Options.Name, error });
    }
  }
  return sources;
}

async function pruneTrail(trail: TrailConfig, reader: AuditReader, before: Date, run: Run): Promise<void> {
  // An archive holds the events of every source connection in one table, and none of them has the archive connection as its source.
  const sources: readonly (string | undefined)[] = trail.archiveConnection === undefined ? await sourcesOf(trail, run) : [undefined];
  for (const source of sources) {
    try {
      run.deleted += await reader.prune(trail, before, source);
    } catch (error) {
      run.failed.push({ trail: trail.name, connection: source, error });
    }
  }
}

/**
 * Deletes the events older than each trail's `retentionDays`: per connection that holds the trail's table, or once for a
 * trail with an archive. A trail without `retentionDays`, or whose store has no reader, keeps everything. A trail or a
 * connection that fails does not stop the others: they are pruned first, then `AuditPruneFailed` is thrown.
 */
export async function pruneAudit(options: PruneAuditOptions = {}): Promise<number> {
  const now = options.now ?? new Date();
  // Before any delete: a table shared by two trails would be pruned at the shorter retention.
  await assertOwnTables();
  const run: Run = { deleted: 0, failed: [] };
  for (const name of options.trail === undefined ? trailNames() : [options.trail]) {
    try {
      const trail = trailConfig(name);
      if (trail.retentionDays === undefined) continue;
      const reader = await (await auditStore(trail)).reader(trail);
      if (!reader) continue;
      await pruneTrail(trail, reader, new Date(now.getTime() - trail.retentionDays * DAY_MS), run);
    } catch (error) {
      run.failed.push({ trail: name, connection: undefined, error });
    }
  }
  if (run.failed.length > 0) throw new AuditPruneFailed(run.deleted, run.failed);
  return run.deleted;
}
