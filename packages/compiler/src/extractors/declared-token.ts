import ts from 'typescript';
import { dirname, resolve } from 'node:path';

const MAX_DEPTH = 6;

function parse(file: string): ts.SourceFile | undefined {
  const text = ts.sys.readFile(file);
  return text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function topLevelConst(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const found = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (found) return found.initializer;
  }
  return undefined;
}

/** Modules that `export * from`, `export { name } from` or `import { name } from` bring `name` in from. */
function reexportSources(sf: ts.SourceFile, name: string): { spec: string; exported: string }[] {
  const out: { spec: string; exported: string }[] = [];
  for (const s of sf.statements) {
    if (!ts.isExportDeclaration(s) && !ts.isImportDeclaration(s)) continue;
    const spec = s.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) continue;
    const clause = ts.isExportDeclaration(s) ? s.exportClause : s.importClause?.namedBindings;
    if (!clause) out.push({ spec: spec.text, exported: name });
    else if (ts.isNamedExports(clause) || ts.isNamedImports(clause)) {
      for (const el of clause.elements) if (el.name.text === name) out.push({ spec: spec.text, exported: el.propertyName?.text ?? name });
    }
  }
  return out;
}

function stringConst(sf: ts.SourceFile, name: string, options: ts.CompilerOptions, depth: number): string | undefined {
  const init = topLevelConst(sf, name);
  if (init) return stringValue(init, sf, options, depth + 1);
  if (depth >= MAX_DEPTH) return undefined;
  for (const { spec, exported } of reexportSources(sf, name)) {
    const file = ts.resolveModuleName(spec, sf.fileName, options, ts.sys).resolvedModule?.resolvedFileName;
    const next = file && parse(file);
    const value = next ? stringConst(next, exported, options, depth + 1) : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringValue(expr: ts.Expression, sf: ts.SourceFile, options: ts.CompilerOptions, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return stringValue(expr.expression, sf, options, depth);
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isIdentifier(expr)) return stringConst(sf, expr.text, options, depth);
  if (!ts.isTemplateExpression(expr)) return undefined;
  let out = expr.head.text;
  for (const span of expr.templateSpans) {
    const part = stringValue(span.expression, sf, options, depth);
    if (part === undefined) return undefined;
    out += part + span.literal.text;
  }
  return out;
}

function sourceOfDeclaration(declarationFile: string): string | undefined {
  const map = ts.sys.readFile(`${declarationFile}.map`);
  if (!map) return undefined;
  const { sources, sourceRoot } = JSON.parse(map) as { sources?: string[]; sourceRoot?: string };
  return sources?.[0] ? resolve(dirname(declarationFile), sourceRoot ?? '', sources[0]) : undefined;
}

/**
 * Key of `export const NAME = token<T>(key)` read from the original source of a declaration file, found
 * through its declaration map. Works for workspace packages; a published package ships no source.
 */
export function declaredTokenKey(declarationFile: string, name: string, options: ts.CompilerOptions): string | undefined {
  const sourceFile = sourceOfDeclaration(declarationFile);
  const sf = sourceFile && parse(sourceFile);
  const init = sf && topLevelConst(sf, name);
  if (!sf || !init || !ts.isCallExpression(init)) return undefined;
  const callee = ts.isIdentifier(init.expression) ? init.expression.text : ts.isPropertyAccessExpression(init.expression) ? init.expression.name.text : '';
  const arg = init.arguments[0];
  return callee === 'token' && arg ? stringValue(arg, sf, options, 0) : undefined;
}
