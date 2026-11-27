import ts from 'typescript';
import type { LiteralContext } from '../decorators.js';

export function initializerOf(symbol: ts.Symbol | undefined, ctx: LiteralContext): ts.Expression | undefined {
  const decl = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol).valueDeclaration;
  // a let or var may be reassigned before the decorator runs, so only a const is held to its initializer
  return decl && ts.isVariableDeclaration(decl) && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const ? decl.initializer : undefined;
}

/** The object literal `expr` is written as, through wrappers and constants. */
export function objectLiteralOf(expr: ts.Expression, ctx: LiteralContext): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return objectLiteralOf(expr.expression, ctx);
  if (ts.isCallExpression(expr) && expr.expression.getText() === 'Object.freeze' && expr.arguments[0]) return objectLiteralOf(expr.arguments[0], ctx);
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return undefined;
  const initializer = initializerOf(ctx.checker.getSymbolAtLocation(ts.isIdentifier(expr) ? expr : expr.name), ctx);
  return initializer && objectLiteralOf(initializer, ctx);
}

export function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every(isPlainJson);
  return false;
}
