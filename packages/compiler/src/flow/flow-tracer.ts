import ts from 'typescript';
import { builderOf, staticKind } from './authz-effects.js';
import type { BuilderKind, FunctionSummary } from './authz-effects.js';
import type { CallGraph, FunctionLike } from './call-graph.js';
import { QueryTracer, chainOf, unwrap } from './query-values.js';
import type { Chain, QueryValue, Traced } from './query-values.js';

const CHOICES: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);
/** `q ??= x` may keep the old value or take the new one, as `q = x` does in code the tracer reads without its control flow. */
const ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);

/** The operands one of which a conditional or a `??`, `||`, `&&` expression evaluates to. */
export function alternatives(e: ts.Expression): readonly ts.Expression[] | undefined {
  if (ts.isConditionalExpression(e)) return [e.whenTrue, e.whenFalse];
  return ts.isBinaryExpression(e) && CHOICES.has(e.operatorToken.kind) ? [e.left, e.right] : undefined;
}

/** What the flow pass knows about a builder beyond its `QueryValue`. */
export interface BuilderMeta {
  readonly kind: BuilderKind;
  /** Where the builder was made in the function being analysed: the site a finding points at. */
  readonly origin: ts.Node;
  /** The index of the parameter the builder came in through. */
  readonly param?: number;
}

const unscopedBuilder = (node: ts.Node, model: string | undefined): QueryValue => ({
  node,
  model: model ?? 'unknown',
  populated: new Set(),
  scoped: { accessible: false, unscoped: false },
  shape: 'many',
});

/**
 * `QueryTracer` across calls: a builder-typed parameter is a pending builder, and a call into the package that hands
 * a builder back unexecuted is one too, scoped as the callee and the argument it was built from left it. A choice
 * between builders is one builder, and a builder-typed expression nothing else explains is read from its type, so
 * no builder is dropped for being hard to follow.
 */
export class FlowTracer extends QueryTracer {
  private readonly meta = new WeakMap<QueryValue, BuilderMeta>();

  constructor(
    checker: ts.TypeChecker,
    private readonly graph: CallGraph,
    private readonly summaries: ReadonlyMap<FunctionLike, FunctionSummary>,
  ) {
    super(checker);
  }

  metaOf(value: QueryValue): BuilderMeta {
    return this.meta.get(value) ?? { kind: 'select', origin: value.node };
  }

  seedParameters(fn: FunctionLike): void {
    fn.parameters.forEach((parameter, index) => {
      const builder = builderOf(this.checker, this.checker.getTypeAtLocation(parameter));
      const symbol = builder === undefined ? undefined : this.checker.getSymbolAtLocation(parameter.name);
      if (builder === undefined || symbol === undefined) return;
      const value = unscopedBuilder(parameter, builder.model);
      this.meta.set(value, { kind: builder.kind, origin: parameter, param: index });
      this.builders.set(symbol, value);
    });
  }

  /** The per-node part of `QueryTracer.run`. */
  observe(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) this.declare(node.name, node.initializer);
    if (ts.isExpressionStatement(node)) this.extendBuilder(node.expression);
    if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) && ts.isIdentifier(node.left)) this.reassign(node.left, this.traced(node.right), node.right);
  }

  private declare(name: ts.BindingName, initializer: ts.Expression): void {
    const traced = this.traced(initializer);
    const symbol = traced === undefined && ts.isIdentifier(name) ? this.checker.getSymbolAtLocation(name) : undefined;
    const unexplained = symbol === undefined ? undefined : this.declaredBuilder(symbol, initializer);
    if (symbol !== undefined && unexplained !== undefined) this.builders.set(symbol, unexplained);
    else this.bind(name, traced);
  }

  /** What a builder-typed variable holds when the tracer cannot explain the value it is given: an unscoped builder. */
  private declaredBuilder(symbol: ts.Symbol, origin: ts.Node): QueryValue | undefined {
    const declaration = symbol.valueDeclaration;
    const builder = declaration === undefined ? undefined : builderOf(this.checker, this.checker.getTypeAtLocation(declaration));
    if (builder === undefined) return undefined;
    const value = unscopedBuilder(origin, builder.model);
    this.meta.set(value, { kind: builder.kind, origin });
    return value;
  }

  /** Calls after a `clone()` change the copy, not the builder the statement starts from. */
  protected override extendBuilder(expr: ts.Expression): void {
    const clone = chainOf(expr)?.calls.find((c) => c.name === 'clone')?.call.expression;
    super.extendBuilder(clone !== undefined && ts.isPropertyAccessExpression(clone) ? clone.expression : expr);
  }

  /**
   * The tracer does not follow control flow, so a reassigned builder variable holds any of its values at a later
   * read: it is scoped only when every one of them is.
   */
  private reassign(name: ts.Identifier, assigned: Traced | undefined, origin: ts.Node): void {
    const symbol = this.checker.getSymbolAtLocation(name);
    if (symbol === undefined) return;
    const held = this.builders.get(symbol);
    const next = assigned?.pending === true ? assigned.value : (this.declaredBuilder(symbol, origin) ?? (held === undefined ? undefined : unscopedBuilder(origin, held.model)));
    if (next === undefined) return;
    if (held === undefined) {
      this.builders.set(symbol, next);
      return;
    }
    const joined = unscopedBuilder(next.node, next.model);
    joined.scoped.accessible = held.scoped.accessible && next.scoped.accessible;
    joined.scoped.unscoped = held.scoped.unscoped && next.scoped.unscoped;
    // The finding points at the value that left the variable unscoped.
    this.meta.set(joined, held.scoped.accessible ? this.metaOf(next) : this.metaOf(held));
    this.builders.set(symbol, joined);
  }

  public override traced(expr: ts.Expression): Traced | undefined {
    const e = unwrap(expr);
    const operands = alternatives(e);
    if (operands !== undefined) return this.either(e, operands);
    // `x as Q` with `x: any`: the cast, not the operand, has the builder type.
    return (ts.isCallExpression(e) ? this.fromCallee(e) : undefined) ?? super.traced(expr) ?? this.byType(e) ?? (e === expr ? undefined : this.byType(expr));
  }

  protected override query(chain: Chain, e: ts.Expression): Traced | undefined {
    const out = super.query(chain, e);
    if (out === undefined) return undefined;
    const base = this.builderAt(chain.root);
    this.meta.set(out.value, base === undefined ? { kind: staticKind(this.checker, chain.calls[0].call), origin: e } : this.metaOf(base));
    return out;
  }

  /**
   * One of `operands` is what the expression evaluates to: a builder when any of them is, scoped only when every one
   * is. An operand of type `any` or `unknown` may be an unscoped builder.
   */
  private either(e: ts.Expression, operands: readonly ts.Expression[]): Traced | undefined {
    const pending: QueryValue[] = [];
    let untyped = false;
    for (const operand of operands) {
      const traced = this.traced(operand);
      if (traced?.pending === true) pending.push(traced.value);
      else if (traced === undefined) untyped ||= (this.checker.getTypeAtLocation(unwrap(operand)).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    }
    const [first] = pending;
    if (first === undefined) return undefined;
    if (pending.length === 1 && !untyped) return { value: first, pending: true };
    const value = unscopedBuilder(e, first.model);
    value.scoped.accessible = !untyped && pending.every((v) => v.scoped.accessible);
    value.scoped.unscoped = !untyped && pending.every((v) => v.scoped.unscoped);
    this.meta.set(value, { kind: this.metaOf(first).kind, origin: e });
    return { value, pending: true };
  }

  /** A builder the tracer cannot follow to a model class, read from its type and scoped by the calls chained on it. */
  private byType(e: ts.Expression): Traced | undefined {
    const builder = builderOf(this.checker, this.checker.getTypeAtLocation(e));
    if (builder === undefined) return undefined;
    const value = unscopedBuilder(e, builder.model);
    // `helper.accessible().builder()`: a call before the builder exists scopes nothing.
    for (const { call } of chainOf(e)?.calls ?? []) if (this.onBuilder(call)) scopeBy(value, call);
    this.meta.set(value, { kind: builder.kind, origin: e });
    return { value, pending: true };
  }

  private onBuilder(call: ts.CallExpression): boolean {
    return ts.isPropertyAccessExpression(call.expression) && builderOf(this.checker, this.checker.getTypeAtLocation(call.expression.expression)) !== undefined;
  }

  /** `helper(q).accessible(p)`: the builder the outermost followed call of the chain hands back, then the calls chained on it. */
  private fromCallee(e: ts.CallExpression): Traced | undefined {
    const chain: ts.CallExpression[] = [];
    for (let current: ts.Expression = e; ts.isCallExpression(current); current = ts.isPropertyAccessExpression(current.expression) ? unwrap(current.expression.expression) : current.expression) chain.push(current);
    for (const [index, call] of chain.entries()) {
      const value = this.returnedBy(call);
      if (value === undefined) continue;
      for (const outer of chain.slice(0, index)) scopeBy(value, outer);
      return { value, pending: true };
    }
    return undefined;
  }

  private returnedBy(call: ts.CallExpression): QueryValue | undefined {
    const resolved = this.graph.resolve(call);
    const returns = resolved.targets.flatMap((t) => this.summaries.get(t.fn)?.returns ?? []);
    const [first] = returns;
    if (first === undefined) return undefined;
    // A target that builds a fresh builder is not scoped by the argument another target hands back.
    const handed = returns.map((r) => {
      const argument = r.param === undefined ? undefined : this.pendingArgument(call, r.param);
      return { argument, accessible: r.scoped.accessible || argument?.scoped.accessible === true, unscoped: r.scoped.unscoped || argument?.scoped.unscoped === true };
    });
    // What the pass does not see may hand back an unscoped builder.
    if (resolved.opaque || resolved.external || resolved.targets.some((t) => this.handsBackUnsummarised(t.fn))) handed.push({ argument: undefined, accessible: false, unscoped: false });
    const from = handed[0].argument;
    const value = unscopedBuilder(call, from?.model ?? first.model);
    value.scoped.accessible = handed.every((h) => h.accessible);
    value.scoped.unscoped = handed.every((h) => h.unscoped);
    const meta = from === undefined ? undefined : this.metaOf(from);
    this.meta.set(value, { kind: first.kind, origin: meta?.origin ?? call, ...(meta?.param === undefined ? {} : { param: meta.param }) });
    return value;
  }

  /** A summarised target that records no returned builder although its declared return type is one. */
  private handsBackUnsummarised(fn: FunctionLike): boolean {
    const summary = this.summaries.get(fn);
    if (summary === undefined || summary.returns !== undefined) return false;
    const signature = this.checker.getSignatureFromDeclaration(fn);
    return signature !== undefined && builderOf(this.checker, signature.getReturnType()) !== undefined;
  }

  private pendingArgument(call: ts.CallExpression, index: number): QueryValue | undefined {
    const argument = call.arguments.at(index);
    const traced = argument === undefined ? undefined : this.traced(argument);
    return traced?.pending === true ? traced.value : undefined;
  }
}

function scopeBy(value: QueryValue, call: ts.CallExpression): void {
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
  if (name === 'accessible') value.scoped.accessible = true;
  if (name === 'unscoped') value.scoped.unscoped = true;
}
