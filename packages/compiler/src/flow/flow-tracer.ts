import ts from 'typescript';
import { builderOf, staticKind } from './authz-effects.js';
import type { BuilderKind, FunctionSummary } from './authz-effects.js';
import type { CallGraph, FunctionLike } from './call-graph.js';
import { QueryTracer, chainOf, unwrap } from './query-values.js';
import type { Chain, QueryValue, Traced } from './query-values.js';

const CHOICES: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);

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
    if (ts.isVariableDeclaration(node) && node.initializer) this.bind(node.name, this.traced(node.initializer));
    if (ts.isExpressionStatement(node)) this.extendBuilder(node.expression);
  }

  public override traced(expr: ts.Expression): Traced | undefined {
    const e = unwrap(expr);
    const operands = alternatives(e);
    if (operands !== undefined) return this.either(e, operands);
    return (ts.isCallExpression(e) ? this.fromCallee(e) : undefined) ?? super.traced(expr) ?? this.byType(e);
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
      else if (traced === undefined) untyped ||= (this.checker.getTypeAtLocation(operand).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
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
    for (const { call } of chainOf(e)?.calls ?? []) scopeBy(value, call);
    this.meta.set(value, { kind: builder.kind, origin: e });
    return { value, pending: true };
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
    const returns = this.graph.resolve(call).targets.flatMap((t) => this.summaries.get(t.fn)?.returns ?? []);
    const [first] = returns;
    if (first === undefined) return undefined;
    // A target that builds a fresh builder is not scoped by the argument another target hands back.
    const handed = returns.map((r) => {
      const argument = r.param === undefined ? undefined : this.pendingArgument(call, r.param);
      return { argument, accessible: r.scoped.accessible || argument?.scoped.accessible === true, unscoped: r.scoped.unscoped || argument?.scoped.unscoped === true };
    });
    const from = handed[0].argument;
    const value = unscopedBuilder(call, from?.model ?? first.model);
    value.scoped.accessible = handed.every((h) => h.accessible);
    value.scoped.unscoped = handed.every((h) => h.unscoped);
    const meta = from === undefined ? undefined : this.metaOf(from);
    this.meta.set(value, { kind: first.kind, origin: meta?.origin ?? call, ...(meta?.param === undefined ? {} : { param: meta.param }) });
    return value;
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
