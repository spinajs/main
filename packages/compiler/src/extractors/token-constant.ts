import ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { identifierName, literalValue } from '../decorators.js';
import { declaredTokenKey } from './declared-token.js';

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

function declarationOf(expr: ts.Expression, ctx: ExtractorContext): ts.VariableDeclaration | undefined {
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return undefined;
  const symbol = ctx.checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name);
  const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol);
  const decl = target?.valueDeclaration;
  return decl && ts.isVariableDeclaration(decl) ? decl : undefined;
}

function isTokenFactory(callee: ts.Expression, ctx: ExtractorContext): boolean {
  const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
  if (!name) return false;
  const symbol = ctx.checker.getSymbolAtLocation(name);
  const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol);
  return target?.name === 'token' && !!target.declarations?.some((d) => ts.isFunctionDeclaration(d));
}

function declaredKey(decl: ts.VariableDeclaration, expr: ts.Expression, ctx: ExtractorContext): string | undefined {
  if (ctx.checker.getTypeAtLocation(decl).getSymbol()?.name !== 'Token' || !ts.isIdentifier(decl.name)) return undefined;
  const key = declaredTokenKey(decl.getSourceFile().fileName, decl.name.text, ctx.program.getCompilerOptions());
  if (key === undefined) ctx.info('CMP005', `cannot read the key of token ${decl.name.text}: its declaration file has no source map to the original`, expr);
  return key;
}

/**
 * Key of a `const X = token<T>('key')` constant, followed through imports and re-exports. `X.key` gives
 * the same key. Undefined when the expression is not such a constant. A token declared in a `.d.ts`
 * has no initializer: its key is read from the original source named by the declaration map, else CMP005.
 */
export function tokenConstantKey(expr: ts.Expression | undefined, ctx: ExtractorContext): string | undefined {
  if (!expr) return undefined;
  const node = unwrap(expr);
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'key') {
    const inner = tokenConstantKey(node.expression, ctx);
    if (inner !== undefined) return inner;
  }
  const decl = declarationOf(node, ctx);
  if (!decl) return undefined;
  const init = decl.initializer && unwrap(decl.initializer);
  if (!init) return declaredKey(decl, expr, ctx);
  if (!ts.isCallExpression(init) || !isTokenFactory(init.expression, ctx)) return undefined;
  const key = literalValue(init.arguments[0], ctx);
  return typeof key === 'string' ? key : undefined;
}

/** The DI key an expression stands for: a token constant's key, otherwise the identifier name. */
export function injectedName(expr: ts.Expression | undefined, ctx: ExtractorContext): string | undefined {
  return tokenConstantKey(expr, ctx) ?? identifierName(expr);
}
