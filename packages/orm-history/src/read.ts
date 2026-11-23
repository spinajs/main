import { audit } from '@spinajs/audit';
import type { AuditQuery, AuditTrail, StoredAuditEvent } from '@spinajs/audit';
import { auditSubjectId } from '@spinajs/audit-orm';
import { Autoinject, Injectable } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { ModelBase, extractModelDescriptor } from '@spinajs/orm';
import type { ModelBaseClass } from '@spinajs/orm';

import { asOfFrom, assertInstant } from './as-of.js';
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

// The same text as the write side's captureKeyText for a string, a safe integer and a bigint, the only keys recorded.
const keyOf = (id: string | number | bigint): string => auditSubjectId(id) ?? String(id);

function assertCursor(name: string, seq: number): void {
  if (!Number.isInteger(seq) || seq < 0) throw new HistoryConfigError(`orm-history: ${name} must be an integer of 0 or more`);
}

function assertWindow(q: HistoryQuery | undefined, afterSeq: number | undefined): void {
  if (afterSeq !== undefined) assertCursor('afterSeq', afterSeq);
  if (q?.from !== undefined) assertInstant('from', q.from);
  if (q?.to !== undefined) assertInstant('to', q.to);
}

/** Changes only: the erasure event of a forgotten row and the read events of an audited one are not part of its timeline. */
function windowOf(spec: HistorySpec, q: HistoryQuery | undefined, afterSeq: number | undefined): AuditQuery {
  assertWindow(q, afterSeq);
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

const PAGE = MAX_LIMIT;

type Page = (query: AuditQuery) => Promise<readonly StoredAuditEvent[]>;

// `changed` is inside the event payload, which a trail cannot filter: pages are read until `limit` entries match or the list ends.
async function matching(read: Page, query: AuditQuery, names: readonly string[], limit: number, found: HistoryEntry[]): Promise<readonly HistoryEntry[]> {
  const page = await read(query);
  for (const entry of entriesOf(page)) {
    if (!entry.changed.some((column) => names.includes(column))) continue;
    found.push(entry);
    if (found.length === limit) return found;
  }
  const last = page.at(-1);
  return last === undefined || page.length < PAGE ? found : matching(read, { ...query, afterSeq: last.seq }, names, limit, found);
}

async function listed(read: Page, query: AuditQuery, q: HistoryQuery | undefined): Promise<readonly HistoryEntry[]> {
  if (nothingAsked(query)) return [];
  const names = q?.changed;
  if (names === undefined) return entriesOf(await read(query));
  return names.length === 0 ? [] : matching(read, { ...query, limit: PAGE }, names, limitOf(q), []);
}

function modelHistory(model: ModelBaseClass, spec: HistorySpec | undefined): ModelHistory {
  if (!spec) throw new HistoryConfigError(`orm-history: ${model.name} is not tracked (no @History and no audit.data.rules match)`);
  const trail = (): AuditTrail => audit().trail(spec.trail);
  return {
    of: async (id, q) => listed((query) => trail().of({ type: spec.entity, id: keyOf(id) }, query), windowOf(spec, q, q?.afterSeq), q),
    since: async (seq, q) => {
      assertCursor('seq', seq);
      return listed((query) => trail().since(seq, query), { ...windowOf(spec, q, q?.afterSeq), subjectType: spec.entity }, q);
    },
    byActor: async (actor, q) => listed((query) => trail().byActor(actor, query), { ...windowOf(spec, q, q?.afterSeq), subjectType: spec.entity }, q),
    asOf: async (id, at) => asOfFrom(trail(), spec, sourceOf(spec), keyOf(id), at),
    forget: async (id) => trail().forget({ type: spec.entity, id: keyOf(id) }, sourceOf(spec)),
  };
}

const isModelClass = (c: unknown): c is Constructor<ModelBase> => typeof c === 'function' && c.prototype instanceof ModelBase;

// A JS caller can hand over an object whose `constructor` is not a model class.
function classOf(row: ModelBase): Constructor<ModelBase> {
  const model: unknown = row.constructor;
  if (isModelClass(model)) return model;
  throw new HistoryConfigError(`orm-history: ${typeof model === 'function' ? model.name : typeof model} is not tracked (no @History and no audit.data.rules match)`);
}

@Injectable(ModelHistorySource)
export class OrmModelHistorySource extends ModelHistorySource {
  @Autoinject(HistorySpecs)
  protected Specs: HistorySpecs;

  public of(model: ModelBaseClass): ModelHistory {
    return modelHistory(model, this.Specs.of(model));
  }

  public ofRow(row: ModelBase): RowHistory {
    const model = classOf(row);
    const all = modelHistory(model, this.Specs.of(model));
    const pk: unknown = row.PrimaryKeyValue;
    if (typeof pk !== 'string' && typeof pk !== 'number' && typeof pk !== 'bigint') {
      throw new HistoryConfigError(`orm-history: this ${model.name} has no primary key value yet, so it has no history; save it first`);
    }
    return { entries: (q) => all.of(pk, q), asOf: (at) => all.asOf(pk, at), forget: () => all.forget(pk) };
  }
}
