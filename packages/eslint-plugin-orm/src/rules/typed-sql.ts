import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AST_NODE_TYPES, ASTUtils, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type { Diagnostic, Manifest, ModelSqlQuery, SqlRowColumn } from '@spinajs/manifest';
import { analyzeSql, GENERIC_SQL_DIALECT, isSqlStatement, readSqlDialects, renderSqlTemplate, resolveSqlDialect, SQL_IGNORE_MARKER, type SqlAnalysis } from '@spinajs/compiler/sql';

export interface TypedSqlOptions {
  /** The app manifest; by default the nearest `app.manifest.json` above the linted file. */
  readonly manifest?: string;
  /** A profile name or driver token; overrides `package.json#spinajs.orm.dialects` of the app. */
  readonly dialect?: string;
}

export type TypedSqlMessageIds = 'sqlProblem' | 'missingRowType' | 'unknownRowType' | 'suggestRecord' | 'staleManifest';

interface LoadedManifest { root: string; manifest: Manifest; dialects: Record<string, string> }

// Only error-level problems of these codes become lint errors (Q14): a doctor warning (SQL003 on a partial model) is dropped.
const REPORTED = new Set(['SQL002', 'SQL003', 'SQL004', 'SQL005', 'SQL006']);
const isReported = (p: Diagnostic): boolean => REPORTED.has(p.code) && p.severity === 'error';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const loaded = new Map<string, { mtimeMs: number; value: LoadedManifest }>();

const createRule = ESLintUtils.RuleCreator<{ recommended: boolean; requiresTypeChecking: boolean }>((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-orm/README.md#${name}`);

export function rowTypeText(row: readonly SqlRowColumn[]): string {
  const members = row.map((c) => `${IDENTIFIER.test(c.name) ? c.name : JSON.stringify(c.name)}: ${c.ts}${c.nullable && c.ts !== 'unknown' ? ' | null' : ''}`);
  return `{ ${members.join('; ')} }`;
}

/** `app.manifest.json` next to or above `file`, no further up than the package root: another package's manifest is never used (A15). */
function nearestManifest(file: string): string | undefined {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const candidate = join(dir, 'app.manifest.json');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, 'package.json')) || dirname(dir) === dir) return undefined;
  }
}

/** Re-read only when the file changes: an editor lints on every keystroke. */
function loadManifest(path: string): LoadedManifest | undefined {
  if (!existsSync(path)) return undefined;
  const { mtimeMs } = statSync(path);
  const cached = loaded.get(path);
  if (cached?.mtimeMs === mtimeMs) return cached.value;
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  // `source.file` is relative to the app's package root, which `spinajs build -o` may put elsewhere than the manifest.
  const root = isAbsolute(manifest.app.root) ? manifest.app.root : dirname(path);
  const value = { root, manifest, dialects: readSqlDialects(root) };
  loaded.set(path, { mtimeMs, value });
  return value;
}

const typeKey = (text: string): string => text.replace(/\s+/g, '').replace(/;}/g, '}');

/** The type argument in source is the recorded one, up to whitespace and the `;` before `}` that `typeToString` writes. */
const sameRowType = (source: string, recorded: string | undefined): boolean => recorded !== undefined && typeKey(source) === typeKey(recorded);

function isOrmSqlTag(tag: TSESTree.Expression, sourceCode: Readonly<TSESLint.SourceCode>): boolean {
  if (tag.type !== AST_NODE_TYPES.Identifier) return false;
  const definition = ASTUtils.findVariable(sourceCode.getScope(tag), tag)?.defs[0];
  const specifier = definition?.node;
  const declaration = definition?.parent;
  if (specifier?.type !== AST_NODE_TYPES.ImportSpecifier || declaration?.type !== AST_NODE_TYPES.ImportDeclaration) return false;
  const imported = specifier.imported.type === AST_NODE_TYPES.Identifier ? specifier.imported.name : specifier.imported.value;
  return imported === 'sql' && declaration.source.value === '@spinajs/orm';
}

/** The recorded query of a template: same text, at the same place or the nearest line (the file may have moved since the build). */
function recordedQuery(node: TSESTree.TaggedTemplateExpression, recorded: readonly ModelSqlQuery[]): ModelSqlQuery | undefined {
  const text = renderSqlTemplate(node.quasi.quasis.map((q) => q.value.cooked ?? q.value.raw));
  const { line, column } = node.loc.start;
  const same = recorded.filter((q) => q.text === text);
  const exact = same.find((q) => q.source.line === line && q.source.col === column + 1);
  return exact ?? [...same].sort((a, b) => Math.abs(a.source.line - line) - Math.abs(b.source.line - line))[0];
}

function reportProblems(context: Readonly<TSESLint.RuleContext<TypedSqlMessageIds, [TypedSqlOptions]>>, node: TSESTree.TaggedTemplateExpression, analysis: SqlAnalysis, problems: readonly Diagnostic[]): void {
  const typeArguments = node.typeArguments;
  const row = analysis.row;
  for (const p of problems) {
    const fixable = p.code === 'SQL005' && typeArguments && row !== 'unknown';
    context.report({ node, messageId: 'sqlProblem', data: { code: p.code, message: p.message }, fix: fixable ? (f) => f.replaceText(typeArguments, `<${rowTypeText(row)}>`) : null });
  }
}

function reportMissingType(context: Readonly<TSESLint.RuleContext<TypedSqlMessageIds, [TypedSqlOptions]>>, node: TSESTree.TaggedTemplateExpression, analysis: SqlAnalysis): void {
  const row = analysis.row;
  if (row === 'unknown') {
    context.report({ node, messageId: 'unknownRowType', suggest: [{ messageId: 'suggestRecord', fix: (f) => f.insertTextAfter(node.tag, '<Record<string, unknown>>') }] });
  } else if (row.length > 0) {
    context.report({ node, messageId: 'missingRowType', data: { row: rowTypeText(row) }, fix: (f) => f.insertTextAfter(node.tag, `<${rowTypeText(row)}>`) });
  }
}

function checkTemplate(context: Readonly<TSESLint.RuleContext<TypedSqlMessageIds, [TypedSqlOptions]>>, node: TSESTree.TaggedTemplateExpression, query: ModelSqlQuery, app: LoadedManifest, options: TypedSqlOptions): void {
  if (query.dynamic || !isSqlStatement(query.text) || query.text.includes(SQL_IGNORE_MARKER)) return;
  // A type argument the manifest does not know (edited, or just written by --fix) is newer than the manifest: SQL005 against the recorded row would be wrong (A13).
  const typeArgument = node.typeArguments?.params[0];
  const checked = typeArgument && !sameRowType(context.sourceCode.getText(typeArgument), query.declaredRow?.text) ? { ...query, declaredRow: undefined, declaredColumns: undefined } : query;
  const declared = options.dialect ?? app.dialects[query.connection ?? 'default'];
  const analysis = analyzeSql(checked, app.manifest, resolveSqlDialect(app.manifest, declared) ?? GENERIC_SQL_DIALECT);
  const problems = analysis.problems.filter(isReported);
  reportProblems(context, node, analysis, problems);
  if (!node.typeArguments && problems.length === 0) reportMissingType(context, node, analysis);
}

export const typedSql = createRule<[TypedSqlOptions], TypedSqlMessageIds>({
  name: 'typed-sql',
  meta: {
    type: 'problem',
    fixable: 'code',
    hasSuggestions: true,
    docs: { description: 'Check `sql` templates against the app manifest and write the row type they return', recommended: true, requiresTypeChecking: false },
    messages: {
      sqlProblem: '{{code}}: {{message}}',
      missingRowType: 'The query returns {{row}}; declare it as sql<{{row}}>.',
      unknownRowType: 'The row this query returns cannot be inferred; declare it with sql<…>.',
      suggestRecord: 'Declare the row as Record<string, unknown>.',
      staleManifest: '{{manifest}} does not know this query: run spinajs build. Other sql templates of this file are not checked until then.',
    },
    schema: [
      {
        type: 'object',
        properties: { manifest: { type: 'string', minLength: 1 }, dialect: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const filename = resolve(context.filename);
    const path = options.manifest ? resolve(context.cwd, options.manifest) : nearestManifest(filename);
    const app = path ? loadManifest(path) : undefined;
    if (!path || !app) return {};
    const file = relative(app.root, filename).replaceAll('\\', '/');
    if (file.startsWith('../')) return {};
    const recorded = (app.manifest.sqlQueries ?? []).filter((q) => q.source.package === app.manifest.app.name && q.source.file === file);
    const templates: TSESTree.TaggedTemplateExpression[] = [];

    return {
      TaggedTemplateExpression(node): void {
        if (isOrmSqlTag(node.tag, context.sourceCode)) templates.push(node);
      },
      'Program:exit'(): void {
        const pairs = templates.map((node) => ({ node, query: recordedQuery(node, recorded) }));
        const stale = pairs.find((p) => !p.query);
        if (stale) {
          context.report({ node: stale.node, messageId: 'staleManifest', data: { manifest: basename(path) } });
          return;
        }
        for (const { node, query } of pairs) if (query) checkTemplate(context, node, query, app, options);
      },
    };
  },
});
