import { Injectable, Singleton } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { ScheduleModel } from '../models/ScheduleModel.js';
import { defined } from '../models/converters.js';
import { definitionHash, serializeDefinition, timingKey } from '../registry/definitions.js';
import { nextOccurrence } from '../time/spec.js';
import type { ScheduleDefinition } from '../interfaces.js';

export function initialNextRun(def: ScheduleDefinition, now: number): number | null {
  if (!def.enabled || def.runOn === 'all') return null;
  // Even when already past, so misfire handling sees it.
  if (def.spec.kind === 'at') return def.spec.at;
  return nextOccurrence(def.spec, now);
}

export interface DefinitionSyncOptions {
  /**
   * True (default) for the scheduler loop: it rewrites changed definitions and marks rows it does not
   * know orphaned (and un-orphans the ones it knows). False for a process that does not run schedules
   * (CLI, API-only replica): its definitions may be older or incomplete, so it only inserts missing rows.
   */
  owner?: boolean;
}

@Singleton()
@Injectable()
export class DefinitionSync {
  @Logger('SCHEDULER')
  protected Log: Log;

  public async sync(defs: ScheduleDefinition[], now: number, options: DefinitionSyncOptions = {}): Promise<void> {
    const owner = options.owner ?? true;
    const rows = await ScheduleModel.all();
    const byName = new Map(rows.map((r) => [r.Name, r]));

    for (const def of defs) {
      const serialized = serializeDefinition(def);
      const hash = definitionHash(def);
      const existing = byName.get(def.name);

      if (!existing) {
        await this.insert(def, serialized, hash, now);
        continue;
      }

      if (existing.DefinitionHash === hash && !existing.Orphaned) continue;

      // definition, NextRunAt and Orphaned stay as the loop wrote them
      if (!owner) continue;

      // Conditional on the old hash, so of several replicas booting together only one rewrites the row.
      // NextRunAt is written only on a timing change: the value read above may have been claimed and advanced since.
      const timingChanged = timingKey(existing.Definition ?? {}) !== timingKey(serialized);
      await ScheduleModel.update(
        defined({
          Definition: serialized,
          DefinitionHash: hash,
          Orphaned: false,
          NextRunAt: timingChanged ? initialNextRun(def, now) : undefined,
          UpdatedAt: now,
        }),
      )
        .where('Name', def.name)
        .where('DefinitionHash', existing.DefinitionHash);
    }

    if (!owner) return;
    const known = new Set(defs.map((d) => d.name));
    for (const r of rows) {
      if (!known.has(r.Name) && !r.Orphaned) {
        await ScheduleModel.update({ Orphaned: true, UpdatedAt: now }).where('Name', r.Name).where('Orphaned', false);
        this.Log.warn(`schedule ${r.Name} has no definition any more; marked orphaned (scheduler:prune removes it)`);
      }
    }
  }

  protected async insert(def: ScheduleDefinition, serialized: Record<string, unknown>, hash: string, now: number): Promise<void> {
    try {
      await ScheduleModel.create({
        Name: def.name,
        Definition: serialized,
        DefinitionHash: hash,
        NextRunAt: initialNextRun(def, now),
        Paused: false,
        HardPaused: false,
        PausedReason: null,
        ConsecutiveFailures: 0,
        Orphaned: false,
        UpdatedAt: now,
      });
    } catch (err) {
      if (!(await ScheduleModel.where('Name', def.name).first())) throw err;
      this.Log.trace(`schedule ${def.name} already inserted by another replica: ${(err as Error).message}`);
    }
  }
}
