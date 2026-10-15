import { AuthzConfigError, SYSTEM, currentPrincipal } from '@spinajs/authz';
import { Injectable } from '@spinajs/di';
import { InStatement, QueryMiddleware, SelectQueryBuilder, SqlOperator, WhereStatement, extractModelDescriptor } from '@spinajs/orm';
import type { IQueryStatement, QueryBuilder } from '@spinajs/orm';

import { ormLog, storageUnscoped } from '../host.js';
import { marksOf } from '../marker.js';
import { entryOf, nameOf } from '../registry.js';
import type { ResourceEntry } from '../registry.js';
import { guardMode } from './env.js';

const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint';

/**
 * Overview decision 11: exactly one primary-key value (`where(pk, v)`, `get(v)`, `findOrFail([v])`) is
 * a single-object load, which the route's check-before covers. The soft-delete and archive IS NULL
 * statements createQuery adds by default do not count.
 */
export function isSingleObjectLoad(query: SelectQueryBuilder, entry: ResourceEntry): boolean {
  const descriptor = extractModelDescriptor(query.Model as never);
  const defaults = [descriptor?.SoftDelete?.DeletedAt, descriptor?.Archived?.ArchivedAt].filter((c): c is string => typeof c === 'string' && c !== '');
  let keys = 0;
  for (const s of query.Statements as IQueryStatement[]) {
    if (s instanceof WhereStatement) {
      if (s.Operator === SqlOperator.NULL && typeof s.Column === 'string' && defaults.includes(s.Column)) continue;
      if (s.Column === entry.idColumn && s.Operator === SqlOperator.EQ && isScalar(s.Value)) {
        keys++;
        continue;
      }
      return false;
    }
    if (s instanceof InStatement) {
      // InStatement keeps its column and values in protected fields (statements.ts:288-302).
      const x = s as unknown as { _column: string; _val: unknown[]; _not: boolean };
      if (x._column === entry.idColumn && !x._not && x._val.length === 1 && isScalar(x._val[0])) {
        keys++;
        continue;
      }
      return false;
    }
    return false;
  }
  return keys === 1;
}

// The builder is built through DI and the ORM's statics, so their frames (and native ones such as the
// middleware loop's Array.forEach) sit between this hook and the app.
const INTERNAL = /[\\/](di|util|orm|orm-sql|orm-sqlite|orm-postgres|orm-mysql|orm-mssql|authz|authz-orm)[\\/](src|lib)[\\/]|node:internal|\(<anonymous>\)$|node_modules[\\/](typescript-mix|lodash)/;

/** The first stack frame outside the ORM and this package: the app line that built the query. */
function callSite(stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').slice(1).map((l) => l.trim());
  return frames.find((f) => f.startsWith('at ') && !INTERNAL.test(f)) ?? 'unknown call site';
}

/** Design §8: reads builders, never changes them. */
@Injectable(QueryMiddleware)
export class AccessGuardMiddleware extends QueryMiddleware {
  public order = 95;

  private readonly sites = new WeakMap<object, string>();
  private readonly warned = new Set<string>();

  afterQueryCreation(query: QueryBuilder): void {
    if (!(query instanceof SelectQueryBuilder) || !entryOf(query.Model)) return;
    // The stack is only worth taking where a warning may need it.
    if (guardMode() === 'warn') this.sites.set(query, callSite(new Error().stack));
  }

  beforeQueryExecution(query: QueryBuilder): void {
    if (!(query instanceof SelectQueryBuilder)) return;
    const entry = entryOf(query.Model);
    if (!entry) return;
    const marks = marksOf(query);
    if (marks?.accessible !== undefined || marks?.unscoped !== undefined) return;
    if (currentPrincipal() === SYSTEM || storageUnscoped() !== undefined) return;
    if (isSingleObjectLoad(query, entry)) return;
    const mode = guardMode();
    if (mode === 'off') return;
    const message = `authz-orm: a select of ${nameOf(query.Model)} (@AccessResource '${entry.type}') runs without .accessible(permission), .unscoped(reason) or runAs(SYSTEM)`;
    if (mode === 'throw') throw new AuthzConfigError(message);
    const site = this.sites.get(query) ?? 'unknown call site';
    if (this.warned.has(site)) return;
    this.warned.add(site);
    ormLog().warn(`${message} (${site})`);
  }
}
