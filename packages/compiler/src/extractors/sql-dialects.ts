import ts from 'typescript';
import type { SqlDialectEntry, SqlDialectProfile } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';

const PLACEHOLDERS: readonly string[] = ['question', 'dollar', 'at-p0'] satisfies readonly SqlDialectProfile['placeholders'][];
const STRINGS = ['name', 'grammar', 'count', 'predicates'] as const;
const MAPS = ['families', 'sum', 'avg'] as const;

const isStringMap = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');

function profileProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'it is not an object literal the compiler can evaluate';
  const p = value as Record<string, unknown>;
  const missing = [...STRINGS.filter((k) => typeof p[k] !== 'string'), ...MAPS.filter((k) => !isStringMap(p[k]))];
  if (missing.length > 0) return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing or not literal`;
  return PLACEHOLDERS.includes(String(p.placeholders)) ? undefined : `placeholders must be one of ${PLACEHOLDERS.join(', ')}`;
}

function entryOf(node: ts.ClassDeclaration & { name: ts.Identifier }, ctx: ExtractorContext): SqlDialectEntry | undefined {
  const decorator = findDecorator(node, 'SqlDialect');
  if (!decorator) return undefined;
  const profile = literalValue(decorator.args[0], ctx);
  // `literalValue` turns a class reference into its name, which no `Connections[].Driver` string can name.
  const tokens = (findDecorator(node, 'Injectable')?.args ?? []).filter((a) => (ctx.checker.getTypeAtLocation(a).flags & ts.TypeFlags.StringLike) !== 0);
  const drivers = tokens.map((a) => literalValue(a, ctx)).filter((t): t is string => typeof t === 'string');
  const problem = profileProblem(profile) ?? (drivers.length === 0 ? 'the class has no @Injectable string token' : undefined);
  if (problem) {
    ctx.warn('CMP010', `@SqlDialect on ${node.name.text} is not recorded: ${problem}`, decorator.node);
    return undefined;
  }
  return { drivers, profile: profile as SqlDialectProfile, source: ctx.sourceRef(node) };
}

export const extractSqlDialects: Extractor<SqlDialectEntry> = (ctx, file) => {
  const out: SqlDialectEntry[] = [];
  const visit = (node: ts.Node): void => {
    const entry = ts.isClassDeclaration(node) && node.name ? entryOf(node as ts.ClassDeclaration & { name: ts.Identifier }, ctx) : undefined;
    if (entry) out.push(entry);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
