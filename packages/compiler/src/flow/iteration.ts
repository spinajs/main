import ts from 'typescript';
import { unwrap } from './query-values.js';

export interface Iteration {
  /** The loop variable or the callback's element parameter; undefined when it is destructured. */
  item: ts.Symbol | undefined;
  /** The `for…of` statement or the array method call. */
  loop: ts.Node;
  body: ts.Node;
  source: ts.Expression;
}

/** Array methods whose callback runs once per element; `reduce` passes the element second. */
export const ITERATING_METHODS = new Set(['forEach', 'map', 'flatMap', 'filter', 'some', 'every', 'find', 'findIndex', 'reduce']);

export function iterationCallback(call: ts.CallExpression): { callback: ts.ArrowFunction | ts.FunctionExpression; method: ts.PropertyAccessExpression } | undefined {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method) || !ITERATING_METHODS.has(method.name.text)) return undefined;
  const callback = call.arguments[0];
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? { callback, method } : undefined;
}

function loopVariable(checker: ts.TypeChecker, initializer: ts.ForInitializer): ts.Symbol | undefined {
  const declaration = ts.isVariableDeclarationList(initializer) ? initializer.declarations[0] : undefined;
  return declaration && ts.isIdentifier(declaration.name) ? checker.getSymbolAtLocation(declaration.name) : undefined;
}

function callbackIteration(checker: ts.TypeChecker, call: ts.CallExpression): Iteration | undefined {
  const found = iterationCallback(call);
  if (!found) return undefined;
  const parameter = found.callback.parameters[found.method.name.text === 'reduce' ? 1 : 0];
  const item = parameter && ts.isIdentifier(parameter.name) ? checker.getSymbolAtLocation(parameter.name) : undefined;
  return { item, loop: call, body: found.callback.body, source: found.method.expression };
}

/** Every `for…of` and per-element array callback in `body` whose iterated expression `matches`. */
export function iterations(body: ts.Node, checker: ts.TypeChecker, matches: (source: ts.Expression) => boolean): Iteration[] {
  const out: Iteration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && matches(node.expression)) out.push({ item: loopVariable(checker, node.initializer), loop: node, body: node.statement, source: node.expression });
    const iteration = ts.isCallExpression(node) ? callbackIteration(checker, node) : undefined;
    if (iteration && matches(iteration.source)) out.push(iteration);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

export function iterationsOver(body: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): Array<{ item: ts.Symbol | undefined; loop: ts.Node }> {
  const isSymbol = (source: ts.Expression): boolean => {
    const e = unwrap(source);
    return ts.isIdentifier(e) && checker.getSymbolAtLocation(e) === symbol;
  };
  return iterations(body, checker, isSymbol).map(({ item, loop }) => ({ item, loop }));
}
