import { Injectable } from '@spinajs/di';
import { AuditConfigError, audit } from '@spinajs/audit';
import type { AuditInput } from '@spinajs/audit';
import { QueryMiddleware, SelectQueryBuilder, WhereStatement, extractModelDescriptor, pkColumns } from '@spinajs/orm';
import type { IModelDescriptor, QueryBuilder } from '@spinajs/orm';

import { auditSubjectId } from '../model-audit.js';
import { auditReadsOf, hasAuditReads } from './rules.js';
import type { ReadRule } from './rules.js';
import { lc, selectListOf } from './select-list.js';
import type { ReadSource } from './select-list.js';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object';

/** The row's value under `key`, matched without case where the driver returned another spelling. */
function valueOf(row: Row, key: string): unknown {
  const entries = Object.entries(row);
  return (entries.find(([k]) => k === key) ?? entries.find(([k]) => lc(k) === lc(key)))?.[1];
}

interface Disclosure {
  readonly columns: readonly string[];
  /** Some value left inside an expression (an aggregate, a raw or condition column), so no row of the model can be named. */
  readonly computed: boolean;
}

function columnName(source: ReadSource, name: string): string {
  return source.descriptor.Columns.find((c) => lc(c.Name) === name)?.Name ?? name;
}

/** The audited columns the select returns for one source; undefined when it returns none of them. */
function disclosed(source: ReadSource, rule: ReadRule): Disclosure | undefined {
  const everything = source.all || source.opaque;
  if (rule.columns === undefined) {
    if (everything) return { columns: ['*'], computed: source.opaque || source.computed.size > 0 };
    const names = [...new Set([...source.keys.keys(), ...source.computed])].map((name) => columnName(source, name));
    return names.length === 0 ? undefined : { columns: names, computed: source.computed.size > 0 };
  }

  const columns = everything ? [...rule.columns] : rule.columns.filter((c) => source.keys.has(lc(c)) || source.computed.has(lc(c)));
  if (columns.length === 0) return undefined;
  return { columns, computed: source.opaque || columns.some((c) => source.computed.has(lc(c))) };
}

/** Row keys of the source's primary key; undefined when the select does not return all of it under a known key. */
function keyColumns(source: ReadSource): string[] | undefined {
  const keys: string[] = [];
  for (const pk of pkColumns(source.descriptor)) {
    // `*` of a joined table returns its columns under names the queried table's may overwrite.
    const key = source.all && source.own ? pk : source.keys.get(lc(pk));
    if (key === undefined) return undefined;
    keys.push(key);
  }

  return keys.length === 0 ? undefined : keys;
}

function rowId(row: Row, keys: readonly string[]): string | undefined {
  return auditSubjectId(keys.length === 1 ? valueOf(row, keys[0]) : keys.map((key) => valueOf(row, key)));
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

/** Grouped rows are no rows of the model. */
function grouped(query: SelectQueryBuilder<unknown>): boolean {
  const groups: unknown = Reflect.get(query, 'GroupStatements');
  return Array.isArray(groups) && groups.length > 0;
}

function statementEvent(entity: string, columns: readonly string[], rows: number, query: SelectQueryBuilder<unknown>, keyless: boolean): AuditInput {
  return { kind: 'read', action: `${entity}.read`, data: { columns, rows, filter: filterOf(query), ...(keyless ? { keyless: true } : {}) } };
}

function eventsOf(rule: ReadRule, source: ReadSource, disclosure: Disclosure, rows: readonly unknown[], query: SelectQueryBuilder<unknown>): AuditInput[] {
  const entity = source.descriptor.TableName;
  const { columns } = disclosure;
  if (rule.mode === 'query') return [statementEvent(entity, columns, rows.length, query, false)];
  if (rows.length === 0) return [];

  const ids = disclosure.computed || grouped(query) ? undefined : subjectIds(source, rows);
  if (!ids) return [statementEvent(entity, columns, rows.length, query, true)];

  return ids.map((id) => ({ kind: 'read', action: `${entity}.read`, subject: { type: entity, id }, data: { columns } }));
}

function rulesOf(source: ReadSource): ReadRule[] {
  const rules = new Set<ReadRule>();
  for (const model of source.models) {
    const rule = auditReadsOf(model);
    if (rule) rules.add(rule);
  }

  return [...rules];
}

/**
 * Records selects of `@AuditReads` models before their rows are returned. It acts on select builders that carry a
 * model: raw SQL and `driver.select()` are not seen. Its own store writes are inserts, so they never come back here.
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
    for (const source of selectListOf(query, root)) {
      for (const rule of rulesOf(source)) {
        this.verify(rule, source.descriptor);
        const disclosure = disclosed(source, rule);
        if (disclosure) {
          await this.write(rule, eventsOf(rule, source, disclosure, rows, query));
        }
      }
    }
  }

  private verify(rule: ReadRule, descriptor: IModelDescriptor): void {
    if (!rule.columns || this.checked.has(descriptor.Name)) return;

    const unknown = rule.columns.filter((c) => !descriptor.Columns.some((d) => lc(d.Name) === lc(c)));
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
