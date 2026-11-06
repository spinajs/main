import type { Diagnostic, Manifest, ModelSqlQuery, SqlDialectProfile } from '@spinajs/manifest';
import { analyzeSql, GENERIC_SQL_DIALECT, isSqlStatement, resolveSqlDialect } from '../../sql/index.js';
import { configAt, diagnostic, type DoctorContext, type DoctorRule } from '../rule.js';

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function configuredDriver(config: Record<string, unknown> | undefined, connection: string): string | undefined {
  const connections = configAt(config, 'db.Connections');
  if (!Array.isArray(connections)) return undefined;
  const name = asString(configAt(config, `db.Aliases.${connection}`)) ?? (connection === 'default' ? asString(configAt(config, 'db.DefaultConnection')) : undefined) ?? connection;
  const found = (connections as Array<Record<string, unknown>>).find((c) => c.Name === name);
  return asString(found?.Driver);
}

/** D6 and P3: the app's package.json, then the driver of the loaded configuration, then the only installed dialect. */
export function dialectFor(connection: string, manifest: Manifest, ctx: DoctorContext): SqlDialectProfile | undefined {
  return resolveSqlDialect(manifest, ctx.sqlDialects?.[connection], configuredDriver(ctx.config, connection));
}

const UNCHECKED_TAIL = 'its queries are checked with the generic mysql grammar and driver-dependent columns are typed unknown';

function noDialectMessage(connection: string, declared: string | undefined): string {
  return declared
    ? `Connection '${connection}' names SQL dialect '${declared}', which no installed driver declares; ${UNCHECKED_TAIL}`
    : `No SQL dialect for connection '${connection}': set package.json#spinajs.orm.dialects.${connection} in the app; ${UNCHECKED_TAIL}`;
}

const results = new WeakMap<Manifest, WeakMap<DoctorContext, Diagnostic[]>>();

/** One analysis per manifest and context; each SQL rule keeps its own code. */
function analyzeAll(manifest: Manifest, ctx: DoctorContext): Diagnostic[] {
  const byContext = results.get(manifest) ?? new WeakMap<DoctorContext, Diagnostic[]>();
  results.set(manifest, byContext);
  const cached = byContext.get(ctx);
  if (cached) return cached;

  const out: Diagnostic[] = [];
  const undeclared = new Map<string, ModelSqlQuery>();
  for (const query of manifest.sqlQueries ?? []) {
    if (!isSqlStatement(query.text)) continue;
    if (query.dynamic) {
      out.push(diagnostic('SQL010', 'info', 'Dynamic SQL is not checked: the template interpolates a SqlFragment or sql.raw', query.source));
      continue;
    }
    const connection = query.connection ?? 'default';
    const dialect = dialectFor(connection, manifest, ctx);
    if (!dialect && !undeclared.has(connection)) undeclared.set(connection, query);
    out.push(...analyzeSql(query, manifest, dialect ?? GENERIC_SQL_DIALECT).problems);
  }
  for (const [connection, query] of undeclared) {
    out.push(diagnostic('SQL011', 'warning', noDialectMessage(connection, ctx.sqlDialects?.[connection]), query.source));
  }
  byContext.set(ctx, out);
  return out;
}

const sqlRule = (code: string, describe: string): DoctorRule => ({ code, describe, run: (manifest, ctx) => analyzeAll(manifest, ctx).filter((d) => d.code === code) });

export const sqlParseError = sqlRule('SQL001', 'An sql template parses in the dialect of its connection');
export const sqlUnknownTable = sqlRule('SQL002', 'An sql template reads only tables some model maps');
export const sqlUnknownColumn = sqlRule('SQL003', 'An sql template reads only columns its models declare');
export const sqlAmbiguousColumn = sqlRule('SQL004', 'An unqualified column of an sql template belongs to one table of the query');
export const sqlRowMismatch = sqlRule('SQL005', 'The row declared as sql<R> matches the row the query returns');
export const sqlInsertValueCount = sqlRule('SQL006', 'An INSERT VALUES row has as many values as the column list');
export const sqlDynamic = sqlRule('SQL010', 'Dynamic sql templates are listed as unchecked');
export const sqlNoDialect = sqlRule('SQL011', 'Every connection with sql templates has a dialect');
