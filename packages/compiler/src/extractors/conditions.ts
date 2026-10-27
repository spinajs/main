import ts from 'typescript';
import type { Condition } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf } from '../decorators.js';

const CONFIG_TYPES = new Set(['Configuration', 'FrameworkConfiguration']);

function configGetPath(expr: ts.CallExpression, ctx: ExtractorContext): string | undefined {
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== 'get') return undefined;
  const arg = expr.arguments[0];
  const receiver = ctx.checker.getTypeAtLocation(expr.expression.expression).getSymbol()?.name ?? '';
  return arg && ts.isStringLiteralLike(arg) && CONFIG_TYPES.has(receiver) ? arg.text : undefined;
}

function configPropertyPath(expr: ts.PropertyAccessExpression, ctx: ExtractorContext): string | undefined {
  const decl = ctx.checker.getSymbolAtLocation(expr.name)?.valueDeclaration;
  if (!decl || !ts.isPropertyDeclaration(decl)) return undefined;
  const arg = decoratorsOf(decl).find((d) => d.name === 'Config')?.args[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

/** `config.get('a.b')` or `this.prop` where prop has `@Config('a.b')` gives 'a.b'. */
function configPathOf(expr: ts.Expression, ctx: ExtractorContext): string | undefined {
  if (ts.isParenthesizedExpression(expr)) return configPathOf(expr.expression, ctx);
  if (ts.isCallExpression(expr)) return configGetPath(expr, ctx);
  if (ts.isPropertyAccessExpression(expr)) return configPropertyPath(expr, ctx);
  return undefined;
}

function isBootstrapMethod(node: ts.Node, ctx: ExtractorContext): boolean {
  return (
    ts.isMethodDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'bootstrap' &&
    ts.isClassDeclaration(node.parent) &&
    ctx.isSubclassOf(node.parent, 'Bootstrapper')
  );
}

function isBranching(node: ts.Node): boolean {
  return ts.isConditionalExpression(node) || ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node);
}

const BOOTSTRAP = Symbol('bootstrap');

function classify(current: ts.Node, ctx: ExtractorContext): Condition | typeof BOOTSTRAP | undefined {
  if (ts.isIfStatement(current)) {
    const path = configPathOf(current.expression, ctx);
    return path ? { kind: 'config', path } : { kind: 'dynamic', reason: 'inside IfStatement' };
  }
  if (isBootstrapMethod(current, ctx)) return BOOTSTRAP;
  if (isBranching(current) || ts.isFunctionLike(current) || ts.isClassDeclaration(current)) {
    return { kind: 'dynamic', reason: `inside ${ts.SyntaxKind[current.kind]}` };
  }
  return undefined;
}

export function conditionOf(node: ts.Node, ctx: ExtractorContext): Condition | undefined {
  let inBootstrap = false;
  let found: Condition | undefined;
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    const result = classify(current, ctx);
    if (result === BOOTSTRAP) inBootstrap = true;
    // An arbitrary function or non-bootstrapper class cannot be predicted; bootstrap() members are handled below.
    else if (result && !found && !(inBootstrap && !isBranching(current) && !ts.isIfStatement(current))) found = result;
  }
  if (!found && inBootstrap) found = { kind: 'dynamic', reason: 'registered in bootstrap()' };
  if (found?.kind === 'dynamic') ctx.info('CMP003', `registration cannot be decided statically: ${found.reason}`, node);
  return found;
}
