import { Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { ScheduleModel } from '../models/ScheduleModel.js';
import { jsonColumn } from '../models/converters.js';
import { definitionHash, serializeDefinition, timingKey } from '../registry/definitions.js';
import { nextOccurrence } from '../time/spec.js';
import type { ScheduleDefinition } from '../interfaces.js';

export function initialNextRun(def: ScheduleDefinition, now: number): number | null {
  if (!def.enabled || def.runOn === 'all') return null;
  // Even when already past, so misfire handling sees it.
  if (def.spec.kind === 'at') return def.spec.at;
  return nextOccurrence(def.spec, now);
}

@Singleton()
@Injectable()
export class DefinitionSync {
  @Logger('SCHEDULER')
  protected Log: Log;

  public async sync(defs: ScheduleDefinition[], now: number): Promise<void> {
    const rows = await ScheduleModel.all();
    const byName = new Map(rows.map((r) => [r.Name, r]));

    for (const def of defs) {
      const serialized = serializeDefinition(def);
      const hash = definitionHash(def);
      const existing = byName.get(def.name);

      if (!existing) {
        try {
          await ScheduleModel.create({ Name: def.name, Definition: serialized, DefinitionHash: hash, NextRunAt: initialNextRun(def, now), Paused: false, HardPaused: false, PausedReason: null, ConsecutiveFailures: 0, Orphaned: false, UpdatedAt: now });
        } catch (err) {
          // another replica inserted it first
          this.Log.trace(`schedule ${def.name} already inserted: ${(err as Error).message}`);
        }
        continue;
      }

      if (existing.DefinitionHash === hash && !existing.Orphaned) continue;

      // Conditional on the old hash, so of several replicas booting together only one rewrites the row.
      const timingChanged = timingKey(existing.Definition ?? {}) !== timingKey(serialized);
      await ScheduleModel.update({ Definition: jsonColumn(serialized) as never, DefinitionHash: hash, Orphaned: false, NextRunAt: timingChanged ? initialNextRun(def, now) : existing.NextRunAt, UpdatedAt: now })
        .where('Name', def.name)
        .where('DefinitionHash', existing.DefinitionHash);
    }

    const known = new Set(defs.map((d) => d.name));
    for (const r of rows) {
      if (!known.has(r.Name) && !r.Orphaned) {
        await ScheduleModel.update({ Orphaned: true, UpdatedAt: now }).where('Name', r.Name).where('Orphaned', false);
        this.Log.warn(`schedule ${r.Name} has no definition any more; marked orphaned (scheduler:prune removes it)`);
      }
    }
  }
}
