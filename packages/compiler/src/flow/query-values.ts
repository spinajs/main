import ts from 'typescript';
import { isModelType } from '../model-members.js';

export interface QueryValue {
  /** The expression the value was read from. */
  node: ts.Node;
  model: string;
  /** Relation paths the query populates; `a.b` also lists `a`. */
  populated: Set<string>;
  scoped: { accessible: boolean; unscoped: boolean };
  shape: 'many' | 'one';
}

/** A query result, or a builder nobody awaited yet (`pending`). */
export interface Traced {
  value: QueryValue;
  pending: boolean;
}

export interface Chain {
  root: ts.Expression;
  calls: Array<{ name: string; call: ts.CallExpression }>;
}

const MANY_OF_MANY = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'toSorted', 'toReversed']);
const ONE_OF_MANY = new Set(['find', 'findLast', 'at', 'pop', 'shift']);

export function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** `a.b(x).c(y)` as its root `a` and the calls `b` and `c`, in source order. */
export function chainOf(expr: ts.Expression): Chain | undefined {
  const calls: Chain['calls'] = [];
  let current = unwrap(expr);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    calls.unshift({ name: current.expression.name.text, call: current });
    current = unwrap(current.expression.expression);
  }
  return calls.length > 0 ? { root: current, calls } : undefined;
}

/** The model class `expr` evaluates to (`Post` in `Post.where(...)`), found by the instance its constructor builds. */
export function modelClassName(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
  const instance = checker
    .getTypeAtLocation(expr)
    .getConstructSignatures()
    .map((s) => s.getReturnType())
    .find((t) => isModelType(checker, t));
  return instance?.getSymbol()?.name;
}

export function modelShape(checker: ts.TypeChecker, type: ts.Type): { model: string; shape: QueryValue['shape'] } | undefined {
  const bare = checker.getNonNullableType(type);
  const many = checker.isArrayType(bare);
  const element = many ? checker.getTypeArguments(bare as ts.TypeReference)[0] : bare;
  if (!element || !isModelType(checker, element)) return undefined;
  return { model: element.getSymbol()?.name ?? 'unknown', shape: many ? 'many' : 'one' };
}

const withPrefixes = (paths: string[]): string[] => paths.flatMap((path) => path.split('.').map((_, i, parts) => parts.slice(0, i + 1).join('.')));

function headsOf(first: ts.Expression | undefined): string[] {
  if (first && ts.isStringLiteralLike(first)) return [first.text];
  if (first && ts.isArrayLiteralExpression(first)) return first.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
  return [];
}

const isThisPopulate = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'populate' && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword;

/** `populate('a')`, `populate(['a', 'b'])`, and `populate('a', function () { this.populate('b') })`, which loads `a.b`. */
export function populatedPaths(call: ts.CallExpression): string[] {
  const [first, callback] = call.arguments;
  const heads = headsOf(first);
  const nested: string[] = [];
  if (heads.length === 1 && callback && (ts.isFunctionExpression(callback) || ts.isArrowFunction(callback))) {
    const visit = (node: ts.Node): void => {
      if (isThisPopulate(node)) nested.push(...populatedPaths(node).map((path) => `${heads[0]}.${path}`));
      ts.forEachChild(node, visit);
    };
    visit(callback.body);
  }
  return withPrefixes([...heads, ...nested]);
}

const fresh = (model: string, node: ts.Node): QueryValue => ({ node, model, populated: new Set(), scoped: { accessible: false, unscoped: false }, shape: 'many' });

function copy(value: QueryValue, node: ts.Node, shape: QueryValue['shape'] = value.shape): QueryValue {
  return { node, model: value.model, populated: new Set(value.populated), scoped: { ...value.scoped }, shape };
}

function applyCalls(value: QueryValue, calls: Chain['calls']): void {
  for (const { name, call } of calls) {
    if (name === 'populate') populatedPaths(call).forEach((path) => value.populated.add(path));
    if (name === 'accessible') value.scoped.accessible = true;
    if (name === 'unscoped') value.scoped.unscoped = true;
  }
}

/**
 * Follows query results through one function body: builders rooted at a model class, `await`, aliases, array
 * destructuring, and the array methods that keep or pick rows. A value returned by a call into another function is not followed.
 */
export class QueryTracer {
  public readonly values = new Map<ts.Symbol, QueryValue>();

  public readonly builders = new Map<ts.Symbol, QueryValue>();

  constructor(protected readonly checker: ts.TypeChecker) {}

  public run(body: ts.Node): this {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) this.bind(node.name, this.traced(node.initializer));
      if (ts.isExpressionStatement(node)) this.extendBuilder(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(body);
    return this;
  }

  public traced(expr: ts.Expression): Traced | undefined {
    const e = unwrap(expr);
    if (ts.isAwaitExpression(e)) return this.awaited(e);
    if (ts.isIdentifier(e)) return this.ofSymbol(e);
    if (ts.isElementAccessExpression(e)) return this.picked(this.traced(e.expression), e);
    const chain = chainOf(e);
    return chain ? (this.query(chain, e) ?? this.arrayMethod(chain, e)) : undefined;
  }

  protected ofSymbol(id: ts.Identifier): Traced | undefined {
    const symbol = this.checker.getSymbolAtLocation(id);
    if (!symbol) return undefined;
    const value = this.values.get(symbol);
    if (value) return { value, pending: false };
    const builder = this.builders.get(symbol);
    return builder ? { value: builder, pending: true } : undefined;
  }

  protected awaited(e: ts.AwaitExpression): Traced | undefined {
    const inner = this.traced(e.expression);
    if (!inner?.pending) return inner;
    const shape = modelShape(this.checker, this.checker.getTypeAtLocation(e));
    return shape ? { value: { ...copy(inner.value, e, shape.shape), model: shape.model }, pending: false } : undefined;
  }

  protected query(chain: Chain, e: ts.Expression): Traced | undefined {
    const model = modelClassName(this.checker, chain.root);
    const base = model ? fresh(model, e) : this.builderAt(chain.root);
    if (!base) return undefined;
    const value = copy(base, e);
    applyCalls(value, chain.calls);
    return { value, pending: true };
  }

  protected builderAt(root: ts.Expression): QueryValue | undefined {
    const traced = ts.isIdentifier(root) ? this.ofSymbol(root) : undefined;
    return traced?.pending ? traced.value : undefined;
  }

  protected arrayMethod(chain: Chain, e: ts.Expression): Traced | undefined {
    const source = chain.calls.length === 1 ? this.traced(chain.root) : undefined;
    if (!source || source.pending || source.value.shape !== 'many') return undefined;
    const name = chain.calls[0].name;
    if (MANY_OF_MANY.has(name)) return { value: copy(source.value, e), pending: false };
    return ONE_OF_MANY.has(name) ? { value: copy(source.value, e, 'one'), pending: false } : undefined;
  }

  protected picked(source: Traced | undefined, e: ts.Expression): Traced | undefined {
    return source && !source.pending && source.value.shape === 'many' ? { value: copy(source.value, e, 'one'), pending: false } : undefined;
  }

  protected bind(name: ts.BindingName, traced: Traced | undefined): void {
    if (!traced) return;
    if (ts.isIdentifier(name)) {
      const symbol = this.checker.getSymbolAtLocation(name);
      if (symbol) (traced.pending ? this.builders : this.values).set(symbol, traced.value);
      return;
    }
    if (!ts.isArrayBindingPattern(name) || traced.pending || traced.value.shape !== 'many') return;
    for (const element of name.elements) {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
      const symbol = this.checker.getSymbolAtLocation(element.name);
      if (symbol) this.values.set(symbol, copy(traced.value, element, element.dotDotDotToken ? 'many' : 'one'));
    }
  }

  /** `q.populate('a');` as a statement changes the builder `q` holds. */
  protected extendBuilder(expr: ts.Expression): void {
    const chain = chainOf(expr);
    const builder = chain ? this.builderAt(chain.root) : undefined;
    if (chain && builder) applyCalls(builder, chain.calls);
  }
}

export function traceQueryValues(body: ts.Node, checker: ts.TypeChecker): Map<ts.Symbol, QueryValue> {
  return new QueryTracer(checker).run(body).values;
}
