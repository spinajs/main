import ts from 'typescript';
import type { ExtractorContext } from '../context.js';

export interface RegisterChain {
  target: ts.Expression;
  calls: { name: string; args: readonly ts.Expression[]; node: ts.CallExpression }[];
}

/** `DI.register(X).as(Y).singleInstance()` gives target X and the ordered chained calls after register(). */
export function registerChainOf(expr: ts.Expression): RegisterChain | undefined {
  const calls: RegisterChain['calls'] = [];
  let current: ts.Expression = expr;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const name = current.expression.name.text;
    if (name === 'register') {
      const owner = current.expression.expression;
      const ownerName = ts.isIdentifier(owner) ? owner.text : ts.isPropertyAccessExpression(owner) ? owner.name.text : '';
      if (!['DI', 'container', 'RootContainer'].includes(ownerName) && !ownerName.endsWith('Container')) return undefined;
      return current.arguments[0] ? { target: current.arguments[0], calls: calls.reverse() } : undefined;
    }
    calls.push({ name, args: current.arguments, node: current });
    current = current.expression.expression;
  }
  return undefined;
}

export function classDeclarationOf(expr: ts.Expression, ctx: ExtractorContext): ts.ClassDeclaration | undefined {
  const symbol = ts.isIdentifier(expr) ? ctx.checker.getSymbolAtLocation(expr) : undefined;
  const resolved = symbol && (symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol);
  const decl = resolved?.valueDeclaration;
  return decl && ts.isClassDeclaration(decl) ? decl : undefined;
}
