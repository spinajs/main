import { AuthzConfigError, SYSTEM, authzStorage, currentPrincipal } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, InStatement, QueryMiddleware, SelectQueryBuilder, SqlOperator, UpdateQueryBuilder, WhereBoolean, WhereStatement, extractModelDescriptor, relationSyncOf } from '@spinajs/orm';
import type { IQueryStatement, QueryBuilder } from '@spinajs/orm';

import { ormLog, storageUnscoped } from '../host.js';
import { marksOf } from '../marker.js';
import { entryOf, nameOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { guardMode } from './env.js';

const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';

/** The key column `s` compares with one value, if it does. */
function keyEquality(s: IQueryStatement, entry: ResourceEntry): string | undefined {
  const column = s instanceof WhereStatement || s instanceof InStatement ? s.Column : undefined;
  if (typeof column !== 'string' || !entry.idColumns.includes(column)) return undefined;
  if (s instanceof WhereStatement) return s.Operator === SqlOperator.EQ && isScalar(s.Value) ? column : undefined;
  return s instanceof InStatement && !s.Not && s.Values.length === 1 && isScalar(s.Values[0]) ? column : undefined;
}

/**
 * Overview decision 11: one value for each primary-key column (`where(pk, v)`, `get(v)`, `findOrFail([v])`; on a
 * composite key a top-level `where()` per column) is a single-object load, which the route's check-before covers.
 * The soft-delete and archive IS NULL statements createQuery adds by default do not count.
 */
export function isSingleObjectLoad(query: SelectQueryBuilder, entry: ResourceEntry): boolean {
  const descriptor = extractModelDescriptor(query.Model as never);
  const defaults = [descriptor?.SoftDelete?.DeletedAt, descriptor?.Archived?.ArchivedAt].filter((c): c is string => typeof c === 'string' && c !== '');
  const bound: string[] = [];
  for (const [i, s] of (query.Statements as IQueryStatement[]).entries()) {
    // The ORM joins statements without grouping: `deleted_at IS NULL OR id = 7` reads every live row.
    if (i > 0 && s.Boolean === WhereBoolean.OR) return false;
    if (s instanceof WhereStatement && s.Operator === SqlOperator.NULL && typeof s.Column === 'string' && defaults.includes(s.Column)) continue;
    const column = keyEquality(s, entry);
    if (column === undefined) return false;
    bound.push(column);
  }
  // Each key column exactly once: one bound twice and another left out is a list.
  return bound.length === entry.idColumns.length && entry.idColumns.every((c) => bound.includes(c));
}

// The builder is built through DI and the ORM's statics, so their frames (and native ones such as the
// middleware loop's Array.forEach) sit between this hook and the app. Any orm-* package counts as a
// driver, so a new one needs no change here.
const INTERNAL = /[\\/](di|util|orm(-[a-z0-9]+)?|authz|authz-orm)[\\/](src|lib)[\\/]|node:internal|\(<anonymous>\)$|node_modules[\\/](typescript-mix|lodash)/;

// On an async stack, a query awaited inside Promise.all() and its siblings has the combinator as a frame of its own,
// the same for every call site of the app.
const COMBINATOR = /^at async Promise\.(all|allSettled|any|race) \(index \d+\)$/;

const UNKNOWN_SITE = 'unknown call site';

/** The first stack frame outside the ORM and this package: the app line that built the query. */
export function callSite(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').slice(1).map((l) => l.trim());
  return frames.find((f) => f.startsWith('at ') && !INTERNAL.test(f) && !COMBINATOR.test(f)) ?? UNKNOWN_SITE;
}

// Between a sync() statement's middleware and the app's call sit the builder, the list and the transaction: as many
// frames as the default limit of 10 holds, so the app's own frame would be cut off.
const SYNC_STACK_FRAMES = 50;

function deepStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = SYNC_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** A route's check-before covers a single-object load only when it was unconditional; outside a route nothing decided. */
function routeDecisionCovers(): boolean {
  const decision = authzStorage().getStore()?.AuthzDecision;
  return decision === undefined || decision.residual.op === 'true';
}

/** Marked on the builder, run as SYSTEM, or in a route marked `@Unscoped(reason)`. */
function authorized(query: QueryBuilder): boolean {
  const marks = marksOf(query);
  if (marks?.accessible !== undefined || marks?.unscoped !== undefined) return true;
  return currentPrincipal() === SYSTEM || storageUnscoped() !== undefined;
}

/** Design §8: reads builders, never changes them. */
@Injectable(QueryMiddleware)
export class AccessGuardMiddleware extends QueryMiddleware {
  public order = 95;

  private readonly sites = new WeakMap<object, string>();

  afterQueryCreation(query: QueryBuilder): void {
    if (!(query instanceof SelectQueryBuilder) || !entryOf(query.Model)) return;
    // The stack is only worth taking where a warning may need it.
    if (guardMode() === 'warn') this.sites.set(query, callSite(new Error().stack));
  }

  beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder) this.guardSelect(query);
    else if (query instanceof UpdateQueryBuilder || query instanceof DeleteQueryBuilder) this.guardSync(query);
  }

  protected guardSelect(query: SelectQueryBuilder): void {
    const entry = entryOf(query.Model);
    // The read sync() and update() use to tell existing junction rows from missing ones; its rows never reach the caller.
    if (!entry || relationSyncOf(query) !== undefined || authorized(query)) return;
    if (isSingleObjectLoad(query, entry) && routeDecisionCovers()) return;
    const mode = guardMode();
    if (mode === 'off') return;
    const message = `authz-orm: a select of ${nameOf(query.Model)} (@AccessResource '${entry.type}') runs without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`;
    if (mode === 'throw') throw new AuthzConfigError(message);
    const site = this.sites.get(query) ?? UNKNOWN_SITE;
    ormLog().warnOnce(`unguarded-select:${site}`,{ model: nameOf(query.Model), resourceType: entry.type, site }, 'authz-orm: a select of ${model} (@AccessResource ${resourceType}) runs without .accessible(permission), .unscoped(reason) or runAs(SYSTEM) (${site})');
  }

  /** Only the statements a relation list's sync() builds itself; the app's own updates and deletes stay unguarded. */
  protected guardSync(query: UpdateQueryBuilder<unknown> | DeleteQueryBuilder<unknown>): void {
    const sync = relationSyncOf(query);
    const entry = sync !== undefined ? entryOf(query.Model) : undefined;
    if (sync === undefined || !entry || authorized(query)) return;
    const mode = guardMode();
    if (mode === 'off') return;
    const owner = nameOf(sync.owner);
    const model = nameOf(query.Model);
    if (mode === 'throw') throw new AuthzConfigError(`authz-orm: sync() of ${owner}.${sync.relation} writes ${model} (@AccessResource '${entry.type}') without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`);
    // Taken when about to warn: the awaits of sync() keep the app's frame on the async stack, except behind a driver's
    // queue of outermost transactions (SQLite), whose .then() ends that stack; the relation then stands in for it.
    const site = callSite(deepStack());
    const key = site === UNKNOWN_SITE ? `${owner}.${sync.relation}` : site;
    ormLog().warnOnce(`unguarded-sync:${key}`, { owner, relation: sync.relation, model, resourceType: entry.type, site }, "authz-orm: sync() of ${owner}.${relation} writes ${model} (@AccessResource '${resourceType}') without .accessible(permission), .unscoped(reason) or runAs(SYSTEM) (${site})");
  }
}
