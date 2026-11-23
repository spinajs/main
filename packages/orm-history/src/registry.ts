import { Config } from '@spinajs/configuration';
import { DI, Singleton } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { Logger } from '@spinajs/log-common';
import type { Log } from '@spinajs/log-common';
import { UuidConverter, extendModel, extractModelDescriptor, unextendModel } from '@spinajs/orm';
import type { IModelDescriptor, ModelBase, ModelMembers } from '@spinajs/orm';

import { HistoryConfigError } from './errors.js';
import { DEFAULT_HISTORY_TRAIL, lineageOf, ruleFor } from './rules.js';
import type { DataRule } from './rules.js';
import { ModelHistorySource } from './types.js';
import type { ModelHistory, RowHistory, TrackedModel, TrackedRow } from './types.js';

export interface HistoryOptions {
  readonly columns?: readonly string[];
  readonly exclude?: readonly string[];
  readonly entity?: string;
  /** Audit trail the changes are recorded in; default 'history'. */
  readonly trail?: string;
  readonly hidden?: 'mask' | 'record';
}

export interface HistorySpec {
  readonly model: Constructor<ModelBase>;
  readonly entity: string;
  readonly pk: string;
  readonly columns: readonly string[] | '*';
  readonly exclude: ReadonlySet<string>;
  readonly masked: ReadonlySet<string>;
  readonly softDelete: string | undefined;
  readonly trail: string;
}

const ENTITY_WIDTH = 128;
const NO_RULES: readonly DataRule[] = [];

// Decorators run when a class is defined, before any container exists, so the declarations are module state
// (as the rules of @AuditReads in @spinajs/audit-orm are). Everything resolved from them lives in HistorySpecs.
const declared = new Map<Constructor<ModelBase>, HistoryOptions | false>();

function validate(model: Constructor<ModelBase>, o: HistoryOptions): void {
  const at = `@History on ${model.name}`;
  if (o.columns !== undefined && o.exclude !== undefined) throw new HistoryConfigError(`${at}: columns and exclude cannot be combined`);
  if (o.columns !== undefined && o.columns.length === 0) throw new HistoryConfigError(`${at}: columns must name at least one column`);
  if (o.entity !== undefined && (o.entity.length === 0 || o.entity.length > ENTITY_WIDTH)) throw new HistoryConfigError(`${at}: entity must be 1 to ${ENTITY_WIDTH} characters`);
  if (o.trail !== undefined && o.trail.trim() === '') throw new HistoryConfigError(`${at}: trail must be a non-empty trail name`);
}

/** The history of a tracked model or of one of its rows. A marked model has the same as `Model.history()` and `row.history()`. */
export function historyOf(model: Constructor<ModelBase>): ModelHistory;
export function historyOf(row: ModelBase): RowHistory;
export function historyOf(target: Constructor<ModelBase> | ModelBase): ModelHistory | RowHistory {
  const source = DI.resolve(ModelHistorySource);
  return typeof target === 'function' ? source.of(target) : source.ofRow(target);
}

// What a marked model gets under the name `history`.
const MEMBERS: ModelMembers = {
  onModel(this: Constructor<ModelBase>): ModelHistory {
    return historyOf(this);
  },
  onRow(this: ModelBase): RowHistory {
    return historyOf(this);
  },
};

export function registerHistory(model: Constructor<ModelBase>, options: HistoryOptions | false = {}): void {
  if (options === false) {
    unextendModel(model, 'history');
  } else {
    validate(model, options);
    extendModel(model, 'history', MEMBERS);
  }
  declared.set(model, options);
}

/** A marked class declares the two members the mark installs; the signature refuses a class that does not. */
export function History(options: false): (target: Constructor<ModelBase>) => void;
export function History(options?: HistoryOptions): <M extends Constructor<ModelBase & TrackedRow> & TrackedModel>(target: M) => void;
export function History(options: HistoryOptions | false = {}) {
  return (target: Constructor<ModelBase>): void => registerHistory(target, options);
}

/** The models that declared tracking themselves; models tracked only by a rule are not listed. */
export function historyModels(): readonly Constructor<ModelBase>[] {
  return [...declared].flatMap(([model, options]) => (options === false ? [] : [model]));
}

/** The declaration of `model` or of the nearest base class that has one; `false` is an opt-out. */
function declaredFor(model: Constructor<ModelBase>): HistoryOptions | false | undefined {
  for (const c of lineageOf(model)) {
    const o = declared.get(c);
    if (o !== undefined) return o;
  }
  return undefined;
}

// The capture keys a row by the text of its raw key, and the 16 bytes UuidConverter writes have none.
function keyStoredAsBytes(d: IModelDescriptor): boolean {
  const converter = d.Converters.get(d.PrimaryKey[0])?.Class;
  return converter !== undefined && (converter === UuidConverter || converter.prototype instanceof UuidConverter);
}

function assertKeyed(model: Constructor<ModelBase>, d: IModelDescriptor | null | undefined): asserts d is IModelDescriptor {
  if (!d || d.PrimaryKey.length !== 1) throw new HistoryConfigError(`@History on ${model.name}: needs a single-column primary key, it has ${d?.PrimaryKey.length ?? 0}`);
  if (keyStoredAsBytes(d)) throw new HistoryConfigError(`@History on ${model.name}: its primary key ${d.PrimaryKey[0]} is stored as bytes by @Uuid(), which has no text for a subject id; history needs a string or integer key`);
}

function buildSpec(model: Constructor<ModelBase>, o: HistoryOptions): HistorySpec {
  const d = extractModelDescriptor(model);
  assertKeyed(model, d);
  const softDelete = d.SoftDelete?.DeletedAt || undefined;
  const always = [softDelete, d.Archived?.ArchivedAt].filter((c): c is string => !!c);
  const listed = new Set(o.columns ?? []);
  return {
    model,
    entity: o.entity ?? d.TableName,
    pk: d.PrimaryKey[0],
    columns: o.columns ? [...new Set([...o.columns, ...always])] : '*',
    exclude: new Set((o.exclude ?? []).filter((c) => c !== softDelete)),
    masked: o.hidden === 'record' ? new Set() : new Set((d.Hidden ?? []).filter((h) => !listed.has(h))),
    softDelete,
    trail: o.trail ?? DEFAULT_HISTORY_TRAIL,
  };
}

interface Resolved {
  readonly own: HistoryOptions | undefined;
  readonly rules: readonly DataRule[];
  readonly spec: HistorySpec | undefined;
}

/** Which models are tracked and how: a model's own `@History`, else the first `audit.data.rules` entry that matches it. */
@Singleton()
export class HistorySpecs {
  @Config('audit.data.rules', { defaultValue: NO_RULES })
  protected Rules: readonly DataRule[];

  @Logger('orm-history')
  protected Log: Log;

  private readonly resolved = new WeakMap<Constructor<ModelBase>, Resolved>();

  /** Resolved at first use: the descriptor exists only once the ORM loaded the model. An untracked model is remembered too. */
  public of(model: Constructor<ModelBase> | undefined): HistorySpec | undefined {
    if (!model) return undefined;
    const own = declaredFor(model);
    if (own === false) return undefined;
    // The same array until audit.data.rules is set again; a model with its own declaration never reads it.
    const rules = own === undefined ? this.Rules : NO_RULES;
    const hit = this.resolved.get(model);
    if (hit !== undefined && hit.own === own && hit.rules === rules) return hit.spec;
    const spec = own === undefined ? this.ruled(model, rules) : buildSpec(model, own);
    this.resolved.set(model, { own, rules, spec });
    return spec;
  }

  /** A rule covers what can be keyed; a model it cannot key is left out instead of failing its writes. */
  private ruled(model: Constructor<ModelBase>, rules: readonly DataRule[]): HistorySpec | undefined {
    const rule = ruleFor(model, rules);
    if (!rule) return undefined;
    const d = extractModelDescriptor(model);
    if (d?.PrimaryKey.length !== 1) {
      this.Log.warn({ model: model.name }, 'orm-history: ${model} matches audit.data.rules but has no single-column primary key, so it is not tracked');
      return undefined;
    }
    if (keyStoredAsBytes(d)) {
      this.Log.warn({ model: model.name, pk: d.PrimaryKey[0] }, 'orm-history: ${model} matches audit.data.rules but its primary key ${pk} is stored as bytes by @Uuid(), so it is not tracked');
      return undefined;
    }
    return buildSpec(model, rule.trail === undefined ? {} : { trail: rule.trail });
  }
}

/** For callers outside a container-built class; `HistoryObserver` and `OrmModelHistorySource` inject `HistorySpecs`. */
export function historySpecOf(model: Constructor<ModelBase> | undefined): HistorySpec | undefined {
  return DI.resolve(HistorySpecs).of(model);
}
