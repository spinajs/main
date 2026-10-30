import ts from 'typescript';
import { dirname, resolve } from 'node:path';
import { evaluateKey } from './key-evaluator.js';

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
  return evaluateKey(expr, (id) => (ts.isIdentifier(id) ? stringConst(sf, id.text, options, depth) : undefined));
}

type MapSource = { sf: ts.SourceFile } | { failure: string };

function sourceOfDeclaration(declarationFile: string): MapSource {
  const text = ts.sys.readFile(`${declarationFile}.map`);
  if (!text) return { failure: 'its declaration file has no declaration map' };
  let map: { sources?: string[]; sourceRoot?: string; sourcesContent?: (string | null)[] };
  try {
    map = JSON.parse(text);
  } catch {
    return { failure: 'its declaration map is malformed' };
  }
  const source = map.sources?.[0];
  if (typeof source !== 'string') return { failure: 'its declaration map lists no source' };
  const file = resolve(dirname(declarationFile), map.sourceRoot ?? '', source);
  const embedded = map.sourcesContent?.[0];
  if (typeof embedded === 'string') return { sf: ts.createSourceFile(file, embedded, ts.ScriptTarget.Latest, true) };
  const sf = parse(file);
  return sf ? { sf } : { failure: `its declaration map points to ${source}, which is not on disk` };
}

/**
 * Key of `export const NAME = token<T>(key)` read from the original source of a declaration file, found
 * through its declaration map (embedded `sourcesContent` first). Works for workspace packages; a published
 * package usually ships neither. A failure names the step that failed.
 */
export function declaredTokenKey(declarationFile: string, name: string, options: ts.CompilerOptions): { key: string } | { failure: string } {
  const found = sourceOfDeclaration(declarationFile);
  if ('failure' in found) return found;
  const init = topLevelConst(found.sf, name);
  if (!init || !ts.isCallExpression(init)) return { failure: `${name} is not a top-level token(...) constant in its source` };
  const callee = ts.isIdentifier(init.expression) ? init.expression.text : ts.isPropertyAccessExpression(init.expression) ? init.expression.name.text : '';
  const arg = init.arguments[0];
  if (callee !== 'token' || !arg) return { failure: `${name} is not a top-level token(...) constant in its source` };
  const key = stringValue(arg, found.sf, options, 0);
  return key === undefined ? { failure: 'its key in the source is not a literal string' } : { key };
}
