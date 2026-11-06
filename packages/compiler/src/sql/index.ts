import type { Diagnostic, Manifest, ModelSqlQuery, SqlRowColumn } from '@spinajs/manifest';
import { statementRow, type InferContext, type InferredRow } from './infer.js';
import type { SqlDialect } from './dialects.js';
import { parseSql } from './parse.js';
import { isSqlStatement, SQL_IGNORE_MARKER } from './render.js';
import { schemaIndex } from './resolve.js';

export { SQL_DIALECTS, dialectOfDriver, isSqlDialect, readSqlDialects, type SqlDialect } from './dialects.js';
export { bindParameters, parseSql, type ParseResult, type SqlNode } from './parse.js';
export { isSqlStatement, renderSqlTemplate, SQL_IGNORE_MARKER } from './render.js';

export interface SqlAnalysis {
  tables: string[];
  columns: Array<{ table: string; column: string }>;
  row: SqlRowColumn[] | 'unknown';
  problems: Diagnostic[];
}

const UNCHECKED: SqlAnalysis = { tables: [], columns: [], row: 'unknown', problems: [] };

const typeMatches = (declared: string, inferred: string): boolean => inferred === 'unknown' || declared === 'unknown' || declared === 'any' || declared === inferred;

function rowDifferences(declared: SqlRowColumn[], row: InferredRow): string[] {
  const out: string[] = [];
  const byName = new Map(declared.map((c) => [c.name, c]));
  for (const c of row.columns) {
    const d = byName.get(c.name);
    if (!d) out.push(`${c.name} is returned but not declared`);
    else if (!typeMatches(d.ts, c.ts)) out.push(`${c.name} is ${c.ts}, declared ${d.ts}`);
    else if (c.ts !== 'unknown' && c.nullable && !d.nullable) out.push(`${c.name} can be null, declared ${d.ts}`);
  }
  const returned = new Set(row.columns.map((c) => c.name));
  if (!row.open) for (const d of declared) if (!returned.has(d.name)) out.push(`${d.name} is declared but not returned`);
  return out;
}

const declaredRowDifferences = (query: ModelSqlQuery, row: InferredRow | 'unknown'): string[] =>
  query.declaredColumns && row !== 'unknown' ? rowDifferences(query.declaredColumns, row) : [];

/** Checks one `sql` template against the models of `manifest`. A fragment, a dynamic query or one marked `-- spinajs-sql-ignore` is not checked. */
export function analyzeSql(query: ModelSqlQuery, manifest: Manifest, dialect: SqlDialect): SqlAnalysis {
  if (query.dynamic || !isSqlStatement(query.text) || query.text.includes(SQL_IGNORE_MARKER)) return UNCHECKED;
  const at = (code: string, severity: Diagnostic['severity'], message: string): Diagnostic => ({ code, severity, message, source: query.source });
  const listParameters = (query.lists?.length ?? 0) > 0;
  const parsed = parseSql(query.text, dialect);
  if (!parsed.ok && parsed.valuesRow === undefined) return { ...UNCHECKED, problems: [at('SQL001', 'error', `SQL does not parse as ${dialect}: ${parsed.message}`)] };
  // The grammar rejected the VALUES row itself (A6 fallback). An array bound to one placeholder expands to several values, so the count it saw proves nothing.
  if (!parsed.ok && listParameters) return UNCHECKED;
  if (!parsed.ok) return { ...UNCHECKED, problems: [at('SQL006', 'error', `INSERT column list and VALUES row ${parsed.valuesRow} differ in length`)] };

  const ctx: InferContext = { tables: schemaIndex(manifest, query.connection), ctes: new Map(), problems: [], used: [], usedTables: new Set(), listParameters };
  const rows = parsed.statements.map((s) => statementRow(s, ctx, undefined));
  const row: InferredRow | 'unknown' = rows.length === 1 ? rows[0] : 'unknown';
  const problems = ctx.problems.map((p) => at(p.code, p.severity, p.message));
  const differences = declaredRowDifferences(query, row);
  if (differences.length > 0) problems.push(at('SQL005', 'error', `sql<…> row differs from the query: ${differences.join('; ')}`));
  return { tables: [...ctx.usedTables], columns: ctx.used, row: row === 'unknown' ? 'unknown' : row.columns, problems };
}
