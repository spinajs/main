import { Injectable } from '@spinajs/di';
import { AuditConfigError, audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { QueryMiddleware, SelectQueryBuilder, WhereStatement, extractModelDescriptor, pkColumns } from '@spinajs/orm';
import type { IModelDescriptor, QueryBuilder } from '@spinajs/orm';

import { auditReadsOf, auditReadsOfName, hasAuditReads } from './rules.js';
import type { ReadRule } from './rules.js';
import { selectListOf } from './select-list.js';
import type { ReadSource } from './select-list.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object';

function keyText(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

/** The audited columns the select returns for one source; undefined when it returns none of them. */
function disclosed(source: ReadSource, rule: ReadRule, opaque: boolean): string[] | undefined {
  const everything = source.all || opaque;
  if (rule.columns === undefined) {
    if (everything) return ['*'];
    return source.keys.size === 0 ? undefined : [...source.keys.keys()];
  }

  const columns = everything ? [...rule.columns] : rule.columns.filter((c) => source.keys.has(c));
  return columns.length === 0 ? undefined : columns;
}

/** Row keys of the source's primary key; undefined when the select does not return all of it. */
function keyColumns(source: ReadSource): string[] | undefined {
  const keys: string[] = [];
  for (const pk of pkColumns(source.descriptor)) {
    const key = source.all ? pk : source.keys.get(pk);
    if (key === undefined) return undefined;
    keys.push(key);
  }

  return keys.length === 0 ? undefined : keys;
}

function rowId(row: Row, keys: readonly string[]): string | undefined {
  const parts: string[] = [];
  for (const key of keys) {
    const text = keyText(row[key]);
    if (text === undefined) return undefined;
    parts.push(text);
  }

  return parts.join(':');
}

/** Ids of the source's rows in the result, each once; undefined when a row of the queried table cannot be named. */
function subjectIds(source: ReadSource, rows: readonly unknown[]): string[] | undefined {
  const keys = keyColumns(source);
  if (!keys) return undefined;

  const ids = new Set<string>();
  for (const row of rows) {
    const id = isRow(row) ? rowId(row, keys) : undefined;
    if (id !== undefined) {
      ids.add(id);
    } else if (source.own) {
      // A joined table has no row where the left join matched nothing; the queried table always has one.
      return undefined;
    }
  }

  return [...ids];
}

const nameOf = (value: { readonly constructor: { readonly name: string } }): string => value.constructor.name;

/** Columns and operators of the where clauses; values stay out of the trail. */
function filterOf(query: SelectQueryBuilder<unknown>): Record<string, string>[] {
  return query.Statements.map((statement): Record<string, string> => {
    if (!(statement instanceof WhereStatement)) return { statement: nameOf(statement) };

    const column = statement.Column;
    return { column: typeof column === 'string' ? column : column.Column, operator: String(statement.Operator) };
  });
}

function statementEvent(entity: string, columns: readonly string[], rows: number, query: SelectQueryBuilder<unknown>, keyless: boolean): AuditInput {
  return { kind: 'read', action: `${entity}.read`, data: { columns, rows, filter: filterOf(query), ...(keyless ? { keyless: true } : {}) } };
}

function eventsOf(rule: ReadRule, source: ReadSource, columns: readonly string[], rows: readonly unknown[], query: SelectQueryBuilder<unknown>): AuditInput[] {
  const entity = source.descriptor.TableName;
  if (rule.mode === 'query') return [statementEvent(entity, columns, rows.length, query, false)];
  if (rows.length === 0) return [];

  const ids = subjectIds(source, rows);
  if (!ids) return [statementEvent(entity, columns, rows.length, query, true)];

  return ids.map((id) => ({ kind: 'read', action: `${entity}.read`, subject: { type: entity, id }, data: { columns } }));
}

/**
 * Records selects of `@AuditReads` models before their rows are returned. It acts on select builders that carry a
 * model: raw SQL, `driver.select()` and aggregates are not seen. Its own store writes are inserts, so they never
 * come back here.
 */
@Injectable(QueryMiddleware)
export class ReadAuditMiddleware extends QueryMiddleware {
  // After the authz hooks (90 to 100), so a select they refuse writes no record; before intl-orm (1000).
  public override order = 200;

  private readonly checked = new Set<string>();

  public afterQueryCreation(_query: QueryBuilder): void {}

  public beforeQueryExecution(_query: QueryBuilder): void {}

  public override async afterQueryExecution(query: QueryBuilder, result: unknown): Promise<void> {
    if (!hasAuditReads() || !(query instanceof SelectQueryBuilder) || !Array.isArray(result)) return;

    const root = extractModelDescriptor(query.Model);
    if (!root) return;

    const rows: readonly unknown[] = result;
    const list = selectListOf(query, root);
    for (const source of list.sources) {
      const rule = source.own ? auditReadsOf(query.Model) : auditReadsOfName(source.descriptor.Name);
      if (!rule) continue;

      this.verify(rule, source.descriptor);
      const columns = disclosed(source, rule, list.opaque);
      if (columns) {
        await this.write(rule, eventsOf(rule, source, columns, rows, query));
      }
    }
  }

  private verify(rule: ReadRule, descriptor: IModelDescriptor): void {
    if (!rule.columns || this.checked.has(descriptor.Name)) return;

    const unknown = rule.columns.filter((c) => !descriptor.Columns.some((d) => d.Name === c));
    if (unknown.length > 0) {
      throw new AuditConfigError(`@AuditReads on ${descriptor.Name}: ${descriptor.TableName} has no column ${unknown.join(', ')}`);
    }
    this.checked.add(descriptor.Name);
  }

  /** Confirmed: written and acknowledged before the rows go on. On a 'reject' rule a failed write throws AuditWriteFailed, which aborts the select. */
  private async write(rule: ReadRule, events: readonly AuditInput[]): Promise<void> {
    if (events.length === 0) return;

    await audit().record(events, { trail: rule.trail, mode: 'confirmed', onFailure: rule.onFailure });
  }
}
