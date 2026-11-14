import type { ColumnFamily, Diagnostic, SqlDialectProfile, SqlRowColumn } from '@spinajs/manifest';
import type { SqlNode } from './parse.js';
import { asArray, asNode, lookupColumn, nameKey, nameOf, type Scope, type Source, type TableInfo } from './resolve.js';

export interface Problem { code: string; severity: Diagnostic['severity']; message: string }

/** `open`: a `*` over a partial model, so the database returns columns the row does not list. */
export interface InferredRow { columns: SqlRowColumn[]; open: boolean }

export interface InferContext {
  tables: Map<string, TableInfo>;
  ctes: Map<string, InferredRow | 'unknown'>;
  problems: Problem[];
  used: Array<{ table: string; column: string }>;
  usedTables: Set<string>;
  /** The query binds an array to a `?`, which expands to several values, so VALUES row lengths prove nothing (SQL006 is skipped). */
  listParameters: boolean;
  profile: SqlDialectProfile;
}

interface Typed { ts: string; nullable: boolean; family?: ColumnFamily }

const UNKNOWN: Typed = { ts: 'unknown', nullable: true };
const LITERALS: Readonly<Record<string, Typed>> = {
  single_quote_string: { ts: 'string', nullable: false },
  string: { ts: 'string', nullable: false },
  null: UNKNOWN,
};
const PREDICATES = new Set(['=', '!=', '<>', '<', '<=', '>', '>=', 'AND', 'OR', 'LIKE', 'NOT LIKE', 'ILIKE', 'IN', 'NOT IN', 'IS', 'IS NOT', 'BETWEEN', 'NOT BETWEEN']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const STRING_FUNCTIONS = new Set(['LOWER', 'UPPER', 'TRIM', 'LTRIM', 'RTRIM', 'CONCAT', 'SUBSTRING', 'SUBSTR', 'REPLACE']);

const report = (ctx: InferContext, code: string, severity: Diagnostic['severity'], message: string): void => {
  ctx.problems.push({ code, severity, message });
};

/** A subquery: postgres and mysql wrap it as `{ ast }`, some positions give the statement itself. */
function statementOf(node: SqlNode): SqlNode | undefined {
  const ast = asNode(node.ast);
  if (ast) return ast;
  return ['select', 'insert', 'update', 'delete'].includes(String(node.type)) ? node : undefined;
}

function missingColumn(ctx: InferContext, column: string, tables: TableInfo[], alias: string | undefined): void {
  if (alias && tables.length === 0) {
    report(ctx, 'SQL003', 'error', `${alias}.${column}: ${alias} is not a table or alias of the query`);
    return;
  }
  // Every source is a CTE or subquery with a known row (a `*` over a partial model keeps it a warning).
  if (tables.length === 0) {
    report(ctx, 'SQL003', 'warning', `Column ${column} is not declared by any table, subquery or CTE of the query`);
    return;
  }
  const severity = tables.every((t) => t.exhaustive) ? 'error' : 'warning';
  const where = tables.length === 1 ? tables[0].name : `any table of the query (${tables.map((t) => t.name).join(', ')})`;
  report(ctx, 'SQL003', severity, `Column ${column} is not declared on ${where}`);
}

const INT4_MAX = 2147483647;

/**
 * A literal with a fraction (`1.0` too) is NUMERIC/DECIMAL in every grammar, so it comes back as the driver returns
 * decimals. node-sql-parser keeps such a literal as text and an integer as a number. An integer past int4 is int8 or
 * NUMERIC depending on the database.
 */
function numberLiteral(node: SqlNode, ctx: InferContext): Typed {
  if (typeof node.value === 'string' && node.value.includes('.')) return { ts: ctx.profile.families.decimal ?? 'number', nullable: false, family: 'decimal' };
  if (typeof node.value === 'number' && Math.abs(node.value) > INT4_MAX) return UNKNOWN;
  return { ts: 'number', nullable: false, family: 'integer' };
}

function columnType(node: SqlNode, scope: Scope, ctx: InferContext): Typed {
  const column = nameOf(node.column);
  // T-SQL parameters (`@p1`) parse as column references.
  if (!column || column.startsWith('@')) return UNKNOWN;
  const alias = nameOf(node.table);
  const found = lookupColumn(scope, alias, column);
  if (found.kind === 'missing') missingColumn(ctx, column, found.tables, found.alias);
  if (found.kind === 'ambiguous') report(ctx, 'SQL004', 'error', `Column ${column} is ambiguous: ${found.sources.map((s) => s.alias).join(', ')} have it`);
  if (found.kind !== 'found') return UNKNOWN;
  if (found.source.table) ctx.used.push({ table: found.source.table.name, column: found.column.name });
  const family = found.column.family;
  return { ts: found.column.ts, nullable: found.column.nullable || found.source.nullable, ...(family ? { family } : {}) };
}

function argsOf(node: SqlNode): unknown[] {
  const args = asNode(node.args);
  if (!args) return [];
  return args.type === 'expr_list' ? asArray(args.value) : [args.expr];
}

function aggregateType(node: SqlNode, scope: Scope, ctx: InferContext): Typed {
  const name = String(node.name).toUpperCase();
  const args = argsOf(node).map((a) => typeOf(a, scope, ctx));
  if (name === 'COUNT') return { ts: ctx.profile.count, nullable: false };
  const family = args.length === 1 ? args[0].family : undefined;
  if (name === 'SUM' || name === 'AVG') {
    const byFamily = name === 'SUM' ? ctx.profile.sum : ctx.profile.avg;
    return { ts: (family && byFamily[family]) || 'unknown', nullable: true };
  }
  if ((name === 'MIN' || name === 'MAX') && args.length === 1) return { ...args[0], nullable: true };
  return UNKNOWN;
}

function functionType(node: SqlNode, scope: Scope, ctx: InferContext): Typed {
  const name = (nameOf(node.name) ?? '').toUpperCase();
  const args = argsOf(node).map((a) => typeOf(a, scope, ctx));
  if (name === 'COALESCE' && args.length > 0) {
    const ts = args.every((a) => a.ts === args[0].ts) ? args[0].ts : 'unknown';
    return { ts, nullable: args.every((a) => a.nullable) };
  }
  if (STRING_FUNCTIONS.has(name)) return { ts: 'string', nullable: args.some((a) => a.nullable) };
  return UNKNOWN;
}

function caseType(node: SqlNode, scope: Scope, ctx: InferContext): Typed {
  typeOf(node.expr, scope, ctx);
  const results: Typed[] = [];
  let hasElse = false;
  for (const branch of asArray(node.args).map(asNode)) {
    if (!branch) continue;
    if (branch.type === 'else') hasElse = true;
    else typeOf(branch.cond, scope, ctx);
    results.push(typeOf(branch.result, scope, ctx));
  }
  const ts = results.length > 0 && results.every((r) => r.ts === results[0].ts) ? results[0].ts : 'unknown';
  return { ts, nullable: !hasElse || results.some((r) => r.nullable) };
}

function binaryType(node: SqlNode, scope: Scope, ctx: InferContext): Typed {
  const left = typeOf(node.left, scope, ctx);
  const right = typeOf(node.right, scope, ctx);
  const operator = String(node.operator).toUpperCase();
  if (PREDICATES.has(operator)) return { ts: ctx.profile.predicates, nullable: left.nullable || right.nullable };
  if (ARITHMETIC.has(operator) && left.ts === 'number' && right.ts === 'number') return { ts: 'number', nullable: left.nullable || right.nullable };
  return UNKNOWN;
}

function visitChildren(node: SqlNode, scope: Scope, ctx: InferContext): void {
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (asNode(child)) typeOf(child, scope, ctx);
    }
  }
}

/** Resolves every column reference under `value` and returns the SQL expression's type. */
export function typeOf(value: unknown, scope: Scope, ctx: InferContext): Typed {
  const node = asNode(value);
  if (!node) return UNKNOWN;
  const sub = statementOf(node);
  if (sub) {
    const row = statementRow(sub, ctx, scope);
    return row !== 'unknown' && row.columns.length === 1 ? { ts: row.columns[0].ts, nullable: true } : UNKNOWN;
  }
  const type = String(node.type);
  if (Object.prototype.hasOwnProperty.call(LITERALS, type)) return LITERALS[type];
  if (type === 'number') return numberLiteral(node, ctx);
  if (type === 'bool' || type === 'boolean') return { ts: ctx.profile.predicates, nullable: false };
  if (type === 'column_ref') return columnType(node, scope, ctx);
  if (type === 'aggr_func') return aggregateType(node, scope, ctx);
  if (type === 'function') return functionType(node, scope, ctx);
  if (type === 'case') return caseType(node, scope, ctx);
  if (type === 'binary_expr') return binaryType(node, scope, ctx);
  visitChildren(node, scope, ctx);
  return UNKNOWN;
}

function derivedSource(alias: string, row: InferredRow | 'unknown', nullable: boolean): Source {
  return { alias, nullable, columns: row === 'unknown' ? undefined : new Map(row.columns.map((c) => [nameKey(c.name), c])) };
}

function tableSource(item: SqlNode, ctx: InferContext): Source | undefined {
  const name = nameOf(item.table);
  if (!name) return undefined;
  const alias = nameOf(item.as) ?? name;
  const cte = ctx.ctes.get(nameKey(name));
  if (cte) return derivedSource(alias, cte, false);
  const table = ctx.tables.get(nameKey(name));
  if (!table) {
    report(ctx, 'SQL002', 'error', `Table ${name} is not the table of any model`);
    return { alias, nullable: false };
  }
  ctx.usedTables.add(table.name);
  return { alias, table, nullable: false };
}

function fromItem(item: SqlNode, ctx: InferContext, parent: Scope | undefined): Source | undefined {
  const expr = asNode(item.expr);
  const sub = expr && statementOf(expr);
  if (sub) return derivedSource(nameOf(item.as) ?? '', statementRow(sub, ctx, parent), false);
  return tableSource(item, ctx);
}

function fromSources(from: unknown, ctx: InferContext, parent: Scope | undefined): Scope {
  const scope: Scope = { sources: [], parent };
  const items = asArray(from).map(asNode).filter((i): i is SqlNode => !!i);
  for (const item of items) {
    const source = fromItem(item, ctx, parent);
    if (!source) continue;
    const join = typeof item.join === 'string' ? item.join.toUpperCase() : '';
    if (join.includes('LEFT') || join.includes('FULL')) source.nullable = true;
    if (join.includes('RIGHT') || join.includes('FULL')) scope.sources.forEach((s) => (s.nullable = true));
    scope.sources.push(source);
  }
  for (const item of items) typeOf(item.on, scope, ctx);
  return scope;
}

function starColumns(node: SqlNode, scope: Scope): InferredRow | 'unknown' {
  const alias = nameOf(node.table);
  const sources = alias ? scope.sources.filter((s) => nameKey(s.alias) === nameKey(alias)) : scope.sources;
  const columns: SqlRowColumn[] = [];
  let open = false;
  for (const source of sources) {
    const known = source.table ? source.table.columns : source.columns;
    if (!known) return 'unknown';
    open = open || (!!source.table && !source.table.exhaustive);
    for (const c of known.values()) columns.push({ name: c.name, ts: c.ts, nullable: c.nullable || source.nullable });
  }
  return { columns, open };
}

const merge = (a: InferredRow | 'unknown', b: InferredRow | 'unknown'): InferredRow | 'unknown' =>
  a === 'unknown' || b === 'unknown' ? 'unknown' : { columns: [...a.columns, ...b.columns], open: a.open || b.open };

function selectItem(item: SqlNode, expr: SqlNode, scope: Scope, ctx: InferContext): InferredRow | 'unknown' {
  if (expr.type === 'column_ref' && nameOf(expr.column) === '*') return starColumns(expr, scope);
  const typed = typeOf(expr, scope, ctx);
  const name = nameOf(item.as) ?? (expr.type === 'column_ref' ? nameOf(expr.column) : undefined);
  // An unnamed expression column is named differently by each database.
  return name ? { columns: [{ name, ts: typed.ts, nullable: typed.nullable }], open: false } : 'unknown';
}

function projection(list: unknown, scope: Scope, ctx: InferContext): InferredRow | 'unknown' {
  let row: InferredRow | 'unknown' = { columns: [], open: false };
  const items = list === '*' ? [{ expr: { type: 'column_ref', column: '*' } }] : asArray(list);
  for (const item of items.map(asNode)) {
    const expr = asNode(item?.expr);
    if (item && expr) row = merge(row, selectItem(item, expr, scope, ctx));
  }
  return row;
}

function visitClauses(node: SqlNode, scope: Scope, ctx: InferContext, row: InferredRow | 'unknown'): void {
  typeOf(node.where, scope, ctx);
  const aliases = new Set(row === 'unknown' ? [] : row.columns.map((c) => nameKey(c.name)));
  // ORDER BY, GROUP BY and HAVING may name an output column instead of a table column.
  const outputOrTable = (value: unknown): void => {
    const node = asNode(value);
    const name = node?.type === 'column_ref' && !node.table ? nameOf(node.column) : undefined;
    if (!name || !aliases.has(nameKey(name))) typeOf(value, scope, ctx);
  };
  asArray(asNode(node.groupby)?.columns ?? node.groupby).forEach(outputOrTable);
  outputOrTable(node.having);
  asArray(node.orderby).forEach((o) => outputOrTable(asNode(o)?.expr));
}

function registerCtes(node: SqlNode, ctx: InferContext, parent: Scope | undefined): void {
  for (const cte of asArray(node.with).map(asNode)) {
    const name = cte && nameOf(cte.name);
    const stmt = cte && asNode(cte.stmt);
    const body = stmt && statementOf(stmt);
    if (name && body) ctx.ctes.set(nameKey(name), statementRow(body, ctx, parent));
  }
}

function selectRow(node: SqlNode, ctx: InferContext, parent: Scope | undefined): InferredRow | 'unknown' {
  registerCtes(node, ctx, parent);
  const scope = fromSources(node.from, ctx, parent);
  const row = projection(node.columns, scope, ctx);
  visitClauses(node, scope, ctx, row);
  const next = asNode(node._next);
  if (next) statementRow(next, ctx, parent);
  return row;
}

function returningRow(node: SqlNode, scope: Scope, ctx: InferContext): InferredRow | 'unknown' {
  const returning = asNode(node.returning);
  return returning ? projection(returning.columns, scope, ctx) : { columns: [], open: false };
}

/** SQL006 from the AST (A6). A grammar that rejects the statement itself never gets here; `analyzeSql` reports the same message from `valuesRow`. */
function visitValues(node: SqlNode, scope: Scope, ctx: InferContext, columnCount: number): void {
  const values = asNode(node.values);
  const rows = values?.type === 'values' ? asArray(values.values) : [];
  rows.forEach((row, i) => {
    const items = asArray(asNode(row)?.value);
    items.forEach((v) => typeOf(v, scope, ctx));
    if (!ctx.listParameters && columnCount > 0 && items.length !== columnCount && !ctx.problems.some((p) => p.code === 'SQL006')) {
      report(ctx, 'SQL006', 'error', `INSERT column list and VALUES row ${i + 1} differ in length`);
    }
  });
  const select = values && statementOf(values);
  if (select) statementRow(select, ctx, scope.parent);
}

function targetScope(tables: unknown, ctx: InferContext, parent: Scope | undefined): Scope {
  const target = asArray(tables).map(asNode).find((t): t is SqlNode => !!t);
  const source = target && tableSource(target, ctx);
  return { sources: source ? [source] : [], parent };
}

function insertRow(node: SqlNode, ctx: InferContext, parent: Scope | undefined): InferredRow | 'unknown' {
  const scope = targetScope(node.table, ctx, parent);
  const columns = asArray(node.columns).map(nameOf).filter((c): c is string => !!c);
  for (const column of columns) typeOf({ type: 'column_ref', table: scope.sources[0]?.alias, column }, scope, ctx);
  visitValues(node, scope, ctx, columns.length);
  return returningRow(node, scope, ctx);
}

function updateRow(node: SqlNode, ctx: InferContext, parent: Scope | undefined): InferredRow | 'unknown' {
  const scope = targetScope(node.table, ctx, parent);
  if (node.from) scope.sources.push(...fromSources(node.from, ctx, parent).sources);
  for (const item of asArray(node.set).map(asNode)) {
    const column = item && nameOf(item.column);
    if (column) typeOf({ type: 'column_ref', table: scope.sources[0]?.alias, column }, scope, ctx);
    typeOf(item?.value, scope, ctx);
  }
  typeOf(node.where, scope, ctx);
  return returningRow(node, scope, ctx);
}

function deleteRow(node: SqlNode, ctx: InferContext, parent: Scope | undefined): InferredRow | 'unknown' {
  const scope = fromSources(node.from ?? node.table, ctx, parent);
  typeOf(node.where, scope, ctx);
  return returningRow(node, scope, ctx);
}

/** The row a statement returns, reporting what it references that the models do not declare. */
export function statementRow(node: SqlNode, ctx: InferContext, parent: Scope | undefined): InferredRow | 'unknown' {
  switch (node.type) {
    case 'select':
      return selectRow(node, ctx, parent);
    case 'insert':
    case 'replace':
      return insertRow(node, ctx, parent);
    case 'update':
      return updateRow(node, ctx, parent);
    case 'delete':
      return deleteRow(node, ctx, parent);
    default:
      return 'unknown';
  }
}
