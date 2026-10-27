import ts from 'typescript';
import type { Condition } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf } from '../decorators.js';
import { isConfigurationReceiver } from './config-receiver.js';

function configGetPath(expr: ts.CallExpression, ctx: ExtractorContext): string | undefined {
  if (!ts.isPropertyAccessExpression(expr.expression) || expr.expression.name.text !== 'get') return undefined;
  const arg = expr.arguments[0];
  const receiver = ctx.checker.getTypeAtLocation(expr.expression.expression);
  return arg && ts.isStringLiteralLike(arg) && isConfigurationReceiver(receiver, ctx) ? arg.text : undefined;
}

function configPropertyDecorated(expr: ts.Expression, ctx: ExtractorContext): string | undefined {
  if (!ts.isPropertyAccessExpression(expr)) return undefined;
  const decl = ctx.checker.getSymbolAtLocation(expr.name)?.valueDeclaration;
  if (!decl || !ts.isPropertyDeclaration(decl)) return undefined;
  const arg = decoratorsOf(decl).find((d) => d.name === 'Config')?.args[0];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
}

function configPropertyPath(expr: ts.PropertyAccessExpression, ctx: ExtractorContext): string | undefined {
  const direct = configPropertyDecorated(expr, ctx);
  if (direct) return direct;
  const base = configPropertyDecorated(expr.expression, ctx);
  return base ? `${base}.${expr.name.text}` : undefined;
}

/** `config.get('a.b')`, `this.prop` with `@Config('a.b')` or `this.prop.member` gives 'a.b' or 'a.b.member'. */
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

function isLoopOrTry(node: ts.Node): boolean {
  return ts.isIterationStatement(node, false) || ts.isSwitchStatement(node) || ts.isTryStatement(node);
}

const BOOTSTRAP = Symbol('bootstrap');
const SCOPE = Symbol('scope');
const ELSE: Condition = { kind: 'dynamic', reason: 'else branch' };

function guard(expr: ts.Expression, ctx: ExtractorContext): Condition {
  const path = configPathOf(expr, ctx);
  return path ? { kind: 'config', path } : { kind: 'dynamic', reason: 'non-config or negated guard' };
}

function branchOf(current: ts.Node, child: ts.Node, ctx: ExtractorContext): Condition | undefined {
  if (ts.isIfStatement(current)) {
    if (child === current.thenStatement) return guard(current.expression, ctx);
    return child === current.elseStatement ? ELSE : undefined;
  }
  if (ts.isConditionalExpression(current)) {
    if (child === current.whenTrue) return guard(current.condition, ctx);
    return child === current.whenFalse ? ELSE : undefined;
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === current.right) {
    return guard(current.left, ctx);
  }
  return undefined;
}

function classify(current: ts.Node, child: ts.Node, ctx: ExtractorContext): Condition | typeof BOOTSTRAP | typeof SCOPE | undefined {
  const branch = branchOf(current, child, ctx);
  if (branch) return branch;
  if (isBootstrapMethod(current, ctx)) return BOOTSTRAP;
  if (isLoopOrTry(current)) return { kind: 'dynamic', reason: `inside ${ts.SyntaxKind[current.kind]}` };
  return ts.isFunctionLike(current) || ts.isClassDeclaration(current) ? SCOPE : undefined;
}

export function conditionOf(node: ts.Node, ctx: ExtractorContext): Condition | undefined {
  let inBootstrap = false;
  let found: Condition | undefined;
  let child = node;
  for (let current = node.parent; current && !ts.isSourceFile(current); child = current, current = current.parent) {
    const result = classify(current, child, ctx);
    if (result === BOOTSTRAP) inBootstrap = true;
    else if (result === SCOPE) {
      // An arbitrary function or non-bootstrapper class cannot be predicted; bootstrap() members are handled below.
      if (!found && !inBootstrap) found = { kind: 'dynamic', reason: `inside ${ts.SyntaxKind[current.kind]}` };
    } else if (result && !found) {
      // Only the innermost guard is recorded: Condition models a single check and outer guards are not combined.
      found = result;
    }
  }
  if (!found && inBootstrap) found = { kind: 'dynamic', reason: 'registered in bootstrap()' };
  if (found?.kind === 'dynamic') ctx.info('CMP003', `registration cannot be decided statically: ${found.reason}`, node);
  return found;
}
