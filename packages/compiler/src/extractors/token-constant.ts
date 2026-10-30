import ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { identifierName } from '../decorators.js';
import { unresolvedTokenKey } from '../token-key.js';
import { evaluateKey, type IdentifierResolver } from './key-evaluator.js';
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

function moduleOf(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  const at = normalized.lastIndexOf('node_modules/');
  return at >= 0 ? normalized.slice(at + 'node_modules/'.length) : normalized.split('/').slice(-2).join('/');
}

function unresolved(decl: ts.VariableDeclaration, reason: string, expr: ts.Expression, ctx: ExtractorContext): string {
  const name = ts.isIdentifier(decl.name) ? decl.name.text : decl.name.getText();
  ctx.warn('CMP005', `cannot read the key of token ${name}: ${reason}`, expr);
  return unresolvedTokenKey(moduleOf(decl.getSourceFile().fileName), name);
}

function declaredKey(decl: ts.VariableDeclaration, expr: ts.Expression, ctx: ExtractorContext): string | undefined {
  if (ctx.checker.getTypeAtLocation(decl).getSymbol()?.name !== 'Token' || !ts.isIdentifier(decl.name)) return undefined;
  const found = declaredTokenKey(decl.getSourceFile().fileName, decl.name.text, ctx.program.getCompilerOptions());
  return 'key' in found ? found.key : unresolved(decl, found.failure, expr, ctx);
}

const MAX_DEPTH = 8;

function programResolver(ctx: ExtractorContext, depth = 0): IdentifierResolver {
  return (id) => {
    if (depth > MAX_DEPTH) return undefined;
    const symbol = ctx.checker.getSymbolAtLocation(ts.isIdentifier(id) ? id : id.name);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol);
    const decl = target?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) {
      const value = evaluateKey(decl.initializer, programResolver(ctx, depth + 1));
      if (value !== undefined) return value;
    }
    const type = ctx.checker.getTypeAtLocation(id);
    return type.isStringLiteral() ? type.value : undefined;
  };
}

/**
 * Key of a `const X = token<T>('key')` constant, followed through imports and re-exports. `X.key` gives
 * the same key. Undefined when the expression is not such a constant. A token declared in a `.d.ts`
 * has no initializer: its key is read from the original source named by the declaration map, else a reserved unresolvable key and a CMP005 warning.
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
  const arg = init.arguments[0];
  const key = arg && evaluateKey(arg, programResolver(ctx));
  return key ?? unresolved(decl, 'its key is not a literal string', expr, ctx);
}

/** The DI key an expression stands for: a token constant's key, otherwise the identifier name. */
export function injectedName(expr: ts.Expression | undefined, ctx: ExtractorContext): string | undefined {
  return tokenConstantKey(expr, ctx) ?? identifierName(expr);
}
