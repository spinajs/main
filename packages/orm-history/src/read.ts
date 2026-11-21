import { audit } from '@spinajs/audit';
import type { AuditQuery, AuditTrail, StoredAuditEvent } from '@spinajs/audit';
import { auditSubjectId } from '@spinajs/audit-orm';
import { Autoinject, Injectable } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { extractModelDescriptor } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { asOfFrom } from './as-of.js';
import { HISTORY_OPS } from './encode.js';
import { toHistoryEntry } from './entry.js';
import { HistoryConfigError } from './errors.js';
import { HistorySpecs } from './registry.js';
import type { HistorySpec } from './registry.js';
import { ModelHistorySource } from './types.js';
import type { HistoryEntry, HistoryQuery, ModelHistory, RowHistory } from './types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function limitOf(q: HistoryQuery | undefined): number {
  const limit = q?.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new HistoryConfigError(`orm-history: limit must be an integer from 1 to ${MAX_LIMIT}`);
  return limit;
}

/** Transactional events live on the connection of the write, so that is where a model's history is read. */
function sourceOf(spec: HistorySpec): string {
  const d = extractModelDescriptor(spec.model)?.Driver;
  if (!d) throw new HistoryConfigError(`orm-history: ${spec.model.name} has no ORM connection yet (is the ORM booted?)`);
  return d.Options.Name;
}

// The text the capture gives the write side (captureKeyText) and Model.audit() the read side.
const keyOf = (id: string | number | bigint): string => auditSubjectId(id) ?? String(id);

/** Changes only: the erasure event of a forgotten row and the read events of an audited one are not part of its timeline. */
function windowOf(spec: HistorySpec, q: HistoryQuery | undefined, afterSeq: number | undefined): AuditQuery {
  const ops = q?.ops;
  return {
    source: sourceOf(spec),
    kinds: ['data'],
    actions: ops === undefined ? HISTORY_OPS : HISTORY_OPS.filter((o) => ops.includes(o)),
    limit: limitOf(q),
    ...(afterSeq === undefined ? {} : { afterSeq }),
    ...(q?.from === undefined ? {} : { from: q.from }),
    ...(q?.to === undefined ? {} : { to: q.to }),
  };
}

const nothingAsked = (query: AuditQuery): boolean => query.actions?.length === 0;
const entriesOf = (events: readonly StoredAuditEvent[]): HistoryEntry[] => events.flatMap((e) => toHistoryEntry(e) ?? []);

function modelHistory(model: Constructor<ModelBase>, spec: HistorySpec | undefined): ModelHistory {
  if (!spec) throw new HistoryConfigError(`orm-history: ${model.name} is not tracked (no @History and no audit.data.rules match)`);
  const trail = (): AuditTrail => audit().trail(spec.trail);
  return {
    of: async (id, q) => {
      const query = windowOf(spec, q, q?.afterSeq);
      return nothingAsked(query) ? [] : entriesOf(await trail().of({ type: spec.entity, id: keyOf(id) }, query));
    },
    since: async (seq, q) => {
      const query = { ...windowOf(spec, q, q?.afterSeq), subjectType: spec.entity };
      return nothingAsked(query) ? [] : entriesOf(await trail().since(seq, query));
    },
    asOf: async (id, at) => asOfFrom(trail(), spec, sourceOf(spec), keyOf(id), at),
    forget: async (id) => trail().forget({ type: spec.entity, id: keyOf(id) }, sourceOf(spec)),
  };
}

@Injectable(ModelHistorySource)
export class OrmModelHistorySource extends ModelHistorySource {
  @Autoinject(HistorySpecs)
  protected Specs: HistorySpecs;

  public of(model: Constructor<ModelBase>): ModelHistory {
    return modelHistory(model, this.Specs.of(model));
  }

  public ofRow(row: ModelBase): RowHistory {
    const model = row.constructor as Constructor<ModelBase>;
    const all = modelHistory(model, this.Specs.of(model));
    const pk: unknown = row.PrimaryKeyValue;
    if (typeof pk !== 'string' && typeof pk !== 'number' && typeof pk !== 'bigint') {
      throw new HistoryConfigError(`orm-history: this ${model.name} has no primary key value yet, so it has no history; save it first`);
    }
    return { entries: (q) => all.of(pk, q), asOf: (at) => all.asOf(pk, at), forget: () => all.forget(pk) };
  }
}
