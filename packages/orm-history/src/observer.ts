import { audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { Logger } from '@spinajs/log-common';
import type { Log } from '@spinajs/log-common';
import { WriteObserver } from '@spinajs/orm';
import type { CaptureInterest, CapturedWrite, UpdateQueryBuilder, WriteStatement } from '@spinajs/orm';

import { LOST_SUBJECT_ID, historyEntryOf } from './encode.js';
import type { PendingEntry } from './encode.js';
import { HistoryWriteError } from './errors.js';
import { HistorySpecs } from './registry.js';
import type { HistorySpec } from './registry.js';

function writesAny(query: UpdateQueryBuilder<unknown>, columns: readonly string[]): boolean {
  const written = new Set([...Object.keys(query.Value ?? {}), ...query.Increments.keys()]);
  return columns.some((c) => written.has(c));
}

const inputOf = (spec: HistorySpec, entry: PendingEntry, at: Date): AuditInput => ({ kind: 'data', action: entry.op, subject: { type: spec.entity, id: entry.id }, data: entry.data, at });

// A `lost` marker concerns the rows of the entity whose keys were never reported, not one row.
const lostInputOf = (spec: HistorySpec, at: Date): AuditInput => ({ kind: 'data', action: 'lost', subject: { type: spec.entity, id: LOST_SUBJECT_ID }, data: { reason: 'unknown_keys' }, at });

// The record joins the write's transaction, where a failed statement cannot be skipped on every dialect,
// so the trail's own onFailure is not consulted (H22).
function record(spec: HistorySpec, write: CapturedWrite, inputs: readonly AuditInput[]): Promise<void> {
  return audit().record(inputs, { trail: spec.trail, mode: 'transactional', transaction: write.driver, onFailure: 'reject' });
}

@Injectable(WriteObserver)
export class HistoryObserver extends WriteObserver {
  @Autoinject(HistorySpecs)
  protected Specs: HistorySpecs;

  @Config('audit.data.onUnknownKeys', { defaultValue: 'warn' })
  protected OnUnknownKeys: 'warn' | 'throw';

  @Logger('orm-history')
  protected Log: Log;

  private readonly warned = new WeakSet<object>();

  public interest(statement: WriteStatement): CaptureInterest | undefined {
    const spec = this.Specs.of(statement.model);
    if (!spec) return undefined;
    if (spec.columns !== '*' && statement.kind === 'update' && !writesAny(statement.query, spec.columns)) return undefined;
    return { columns: spec.columns, transactional: true };
  }

  public prepare(statement: WriteStatement): void {
    const spec = this.Specs.of(statement.model);
    if (spec && statement.kind === 'update' && writesAny(statement.query, [spec.pk])) {
      throw new HistoryWriteError(`orm-history: an update of ${spec.entity} writes its primary key ${spec.pk}; history is keyed by it, delete and insert the row instead`);
    }
  }

  public async observe(write: CapturedWrite): Promise<void> {
    const spec = this.Specs.of(write.model);
    if (!spec) return;
    const at = new Date();
    if (write.unknownKeys) return this.unknownKeys(spec, write, at);
    const inputs = write.rows.flatMap((row) => {
      const entry = historyEntryOf(spec, row);
      return entry ? [inputOf(spec, entry, at)] : [];
    });
    if (inputs.length > 0) await record(spec, write, inputs);
  }

  private async unknownKeys(spec: HistorySpec, write: CapturedWrite, at: Date): Promise<void> {
    if (this.OnUnknownKeys === 'throw') {
      throw new HistoryWriteError(`orm-history: an insert of ${spec.entity} did not report the keys it wrote, so its history cannot be recorded; insert one row at a time or supply the keys`);
    }
    await record(spec, write, [lostInputOf(spec, at)]);
    if (this.warned.has(spec.model)) return;
    this.warned.add(spec.model);
    this.Log.warn({ entity: spec.entity }, 'orm-history: an insert of ${entity} did not report the keys it wrote, so its history is missing; insert one row at a time, supply the keys or set audit.data.onUnknownKeys to throw');
  }
}
