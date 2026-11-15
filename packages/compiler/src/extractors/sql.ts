import ts from 'typescript';
import type { ModelSqlQuery, SqlRowColumn } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { literalValue } from '../decorators.js';
import { ORM } from '../model-members.js';
import { isDeclaredIn } from '../schema/framework-members.js';
import { renderSqlTemplate } from '../sql/render.js';

type Interpolation = 'value' | 'list' | 'fragment';

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined;

function isOrmSqlTag(tag: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(tag)) return false;
  let symbol = checker.getSymbolAtLocation(tag);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.name === 'sql' && isDeclaredIn(symbol.valueDeclaration ?? symbol.declarations?.[0], ORM);
}

function interpolation(type: ts.Type, checker: ts.TypeChecker): Interpolation {
  const value = checker.getNonNullableType(type);
  if (value.getProperty('sql') && value.getProperty('bindings')) return 'fragment';
  return checker.isArrayType(value) || checker.isTupleType(value) ? 'list' : 'value';
}

function declaredColumns(row: ts.Type, at: ts.Node, checker: ts.TypeChecker): SqlRowColumn[] {
  return checker.getPropertiesOfType(row).map((p) => {
    const type = checker.getTypeOfSymbolAtLocation(p, at);
    const nullable = !!(p.flags & ts.SymbolFlags.Optional) || (type.isUnion() && type.types.some((t) => (t.flags & NULLISH) !== 0));
    return { name: p.name, ts: checker.typeToString(checker.getNonNullableType(type), undefined, ts.TypeFormatFlags.NoTruncation), nullable };
  });
}

/** `executeSql(sql\`…\`, { connection: 'x' })`: the only place a template names its connection. */
function connectionOf(node: ts.TaggedTemplateExpression, ctx: ExtractorContext): string | undefined {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node || !ts.isIdentifier(call.expression) || call.expression.text !== 'executeSql') return undefined;
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const connection = (literalValue(options, ctx) as { connection?: unknown }).connection;
  return typeof connection === 'string' ? connection : undefined;
}

function sqlQuery(node: ts.TaggedTemplateExpression, ctx: ExtractorContext): ModelSqlQuery {
  const template = node.template;
  const strings = ts.isNoSubstitutionTemplateLiteral(template) ? [template.text] : [template.head.text, ...template.templateSpans.map((s) => s.literal.text)];
  const spans = ts.isNoSubstitutionTemplateLiteral(template) ? [] : template.templateSpans;
  const kinds = spans.map((s) => interpolation(ctx.checker.getTypeAtLocation(s.expression), ctx.checker));
  const lists = kinds.flatMap((k, i) => (k === 'list' ? [i] : []));
  const row = node.typeArguments?.[0] && ctx.checker.getTypeFromTypeNode(node.typeArguments[0]);
  const connection = connectionOf(node, ctx);
  const source = ctx.sourceRef(node);
  return {
    id: `${source.file}:${source.line}:${source.col}`,
    text: renderSqlTemplate(strings),
    placeholders: kinds.filter((k) => k !== 'fragment').length,
    dynamic: kinds.includes('fragment'),
    ...(row ? { declaredRow: ctx.plainTypeRef(row), declaredColumns: declaredColumns(row, node, ctx.checker) } : {}),
    ...(lists.length > 0 ? { lists } : {}),
    ...(connection ? { connection } : {}),
    source,
  };
}

/** Every `sql` template of `@spinajs/orm`; nested fragments too, which the doctor skips as non-statements. */
export const extractSqlQueries: Extractor<ModelSqlQuery> = (ctx, file) => {
  const out: ModelSqlQuery[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isOrmSqlTag(node.tag, ctx.checker)) out.push(sqlQuery(node, ctx));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
