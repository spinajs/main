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

const lostInputOf = (spec: HistorySpec, at: Date, reason = 'unknown_keys'): AuditInput => ({ kind: 'data', action: 'lost', subject: { type: spec.entity, id: LOST_SUBJECT_ID }, data: { reason }, at });

const statementOf = (write: CapturedWrite): 'an insert' | 'an update' | 'a delete' =>(write.kind === 'delete' ? 'a delete' : `an ${write.kind}`);

// The record joins the write's transaction, where a failed statement cannot be skipped on every dialect,
// so the trail's own onFailure is not consulted.
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
  private readonly warnedKeyless = new WeakSet<object>();

  public interest(statement: WriteStatement): CaptureInterest | undefined {
    const spec = this.Specs.of(statement.model);
    if (!spec) return undefined;
    if (spec.columns !== '*' && statement.kind === 'update' && !writesAny(statement.query, [spec.pk, ...spec.columns])) return undefined;
    return { columns: spec.columns, transactional: true };
  }

  public async observe(write: CapturedWrite): Promise<void> {
    const spec = this.Specs.of(write.model);
    if (!spec) return;
    const at = new Date();
    if (write.unknownKeys) return this.unknownKeys(spec, write, at);
    // The capture reads an update's after rows by the keys it read before, so a row whose key changed has no after;
    // a key named with its unchanged value is no change. The throw fails the write: outside a caller's transaction the
    // statement rolls back with the capture's own; inside one it has run, and only the caller's rollback undoes it.
    if (write.kind === 'update' && write.rows.some((r) => r.before !== undefined && r.after === undefined)) {
      throw new HistoryWriteError(`orm-history: an update of ${spec.entity} writes its primary key ${spec.pk}; history is keyed by it, delete and insert the row instead`);
    }
    const keyless = write.keylessRows > 0;
    if (keyless && this.OnUnknownKeys === 'throw') {
      throw new HistoryWriteError(`orm-history: ${statementOf(write)} of ${spec.entity} reached a primary key ${spec.pk} that has no text (bytes, a date or a number that is not a safe integer), so its history cannot be recorded; history needs a string or integer key`);
    }
    // The marker goes first: asOf reads only the markers after a row's last entry, and the rows this statement did
    // record are known.
    const inputs = [
      ...(keyless ? [lostInputOf(spec, at, 'keys_without_text')] : []),
      ...write.rows.flatMap((row) => {
        const entry = historyEntryOf(spec, row);
        return entry ? [inputOf(spec, entry, at)] : [];
      }),
    ];
    if (inputs.length > 0) await record(spec, write, inputs);
    if (!keyless || this.warnedKeyless.has(spec.model)) return;
    this.warnedKeyless.add(spec.model);
    // The log quotes a field value with spaces, so the statement goes into the message itself.
    this.Log.warn({ entity: spec.entity, pk: spec.pk }, `orm-history: ${statementOf(write)} of \${entity} reached a primary key \${pk} that has no text (bytes, a date or a number that is not a safe integer), so its history is missing; history needs a string or integer key`);
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
