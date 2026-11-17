import ts from 'typescript';
import { builderOf, buildersOf, staticKind } from './authz-effects.js';
import type { BuilderKind, BuilderVariant, FunctionSummary, ReturnedBuilder } from './authz-effects.js';
import { parametersOf } from './call-graph.js';
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
  /** Every kind and model the builder may be, when it may be more than one; a joined value keeps where each part was made. */
  readonly variants?: readonly Named[];
}

type Named = BuilderVariant & { readonly origin?: ts.Node };

type Scoping = QueryValue['scoped'];

const unscopedBuilder = (node: ts.Node, model: string | undefined): QueryValue => ({
  node,
  model: model ?? 'unknown',
  populated: new Set(),
  scoped: { accessible: false, unscoped: false },
  shape: 'many',
});

function distinct(variants: readonly Named[]): Named[] {
  const out: Named[] = [];
  for (const v of variants) if (!out.some((o) => o.kind === v.kind && o.model === v.model && o.origin === v.origin)) out.push(v);
  return out;
}

/**
 * `QueryTracer` across calls: a builder-typed parameter is a pending builder, and a call into the package that hands
 * a builder back unexecuted is one too, scoped as the callee and the argument it was built from left it. A choice
 * between builders is one builder, and a builder-typed expression nothing else explains is read from its type, so
 * no builder is dropped for being hard to follow.
 */
export class FlowTracer extends QueryTracer {
  private readonly meta = new WeakMap<QueryValue, BuilderMeta>();
  /** Variables written after their declaration: a scoping statement on one may not reach what it holds later. */
  readonly rewritten = new Set<ts.Symbol>();

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

  variantsOf(value: QueryValue): readonly Named[] {
    const meta = this.metaOf(value);
    return meta.variants ?? [{ kind: meta.kind, model: value.model }];
  }

  /**
   * A builder that may be any of `values` (`untyped`: or something the tracer does not know): scoped only when every
   * one is. A finding names what may run unscoped, so the origin, kinds and models come from the values that are not
   * scoped, and the parameter only when every value is that parameter.
   */
  join(values: readonly QueryValue[], origin?: ts.Node, untyped = false): QueryValue {
    const scoped = { accessible: !untyped && values.every((v) => v.scoped.accessible), unscoped: !untyped && values.every((v) => v.scoped.unscoped) };
    const open = values.filter((v) => !v.scoped.accessible);
    const named = scoped.accessible || open.length === 0 ? values : open;
    const params = values.map((v) => this.metaOf(v).param);
    const param = !untyped && params.every((p) => p === params[0]) ? params[0] : undefined;
    const variants = named.flatMap((v) => this.variantsOf(v).map((n) => (origin === undefined ? { ...n, origin: n.origin ?? this.metaOf(v).origin } : { kind: n.kind, model: n.model })));
    return this.made(origin ?? this.metaOf(named[0]).origin, distinct(variants), scoped, param);
  }

  /** Every builder variable as an unscoped builder. */
  distrust(): void {
    for (const [symbol, value] of this.builders) this.builders.set(symbol, this.join([value], undefined, true));
  }

  seedParameters(fn: FunctionLike): void {
    parametersOf(fn).forEach((parameter, index) => {
      const symbol = this.checker.getSymbolAtLocation(parameter.name);
      const value = symbol === undefined ? undefined : this.typed(parameter, this.checker.getTypeAtLocation(parameter), index);
      if (symbol !== undefined && value !== undefined) this.builders.set(symbol, value);
    });
  }

  /** The per-node part of `QueryTracer.run`. */
  observe(node: ts.Node): void {
    this.observeBinding(node);
    this.observeScoping(node);
  }

  /** What a node binds: a declaration, an assignment, the target of a `for…of` or `for…in`, a parameter's default. */
  observeBinding(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) this.declare(node.name, node.initializer);
    else if (ts.isParameter(node) && node.initializer && ts.isIdentifier(node.name)) this.defaulted(node.name, node.initializer);
    else if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) this.assign(node);
    else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      for (const name of assignedNames(node.initializer)) this.reassign(name, undefined, node.expression);
    }
  }

  /** `q.accessible(p);`: a statement that scopes the builder a variable holds. */
  observeScoping(node: ts.Node): void {
    if (ts.isExpressionStatement(node)) this.extendBuilder(node.expression);
  }

  private assign(node: ts.BinaryExpression): void {
    if (ts.isIdentifier(node.left)) this.reassign(node.left, this.traced(node.right), node.right);
    // `[q] = [...]`, `({ q } = ...)`: what each name receives is not traced.
    else for (const name of assignedNames(node.left)) this.reassign(name, undefined, node);
  }

  private declare(name: ts.BindingName, initializer: ts.Expression): void {
    const traced = this.traced(initializer);
    const symbol = ts.isIdentifier(name) ? this.checker.getSymbolAtLocation(name) : undefined;
    const value = symbol !== undefined && traced === undefined ? this.declaredBuilder(symbol, initializer) : traced?.pending === true ? traced.value : undefined;
    if (symbol === undefined || value === undefined) {
      this.bind(name, traced);
      return;
    }
    // `var q` declared again writes `q` as an assignment does.
    if ((symbol.declarations?.length ?? 0) > 1) this.rewritten.add(symbol);
    const held = this.builders.get(symbol);
    // Observed again (a loop body, the fixed point of a summary), the variable holds any value it was given.
    this.builders.set(symbol, held === undefined ? value : this.join([held, value]));
  }

  /**
   * A parameter with a default holds what a caller passes, read from its type, or the default. A seeded parameter
   * stays the caller's argument, and the default is reported where it stands.
   */
  private defaulted(name: ts.Identifier, initializer: ts.Expression): void {
    const symbol = this.checker.getSymbolAtLocation(name);
    const held = symbol === undefined ? undefined : this.builders.get(symbol);
    if (symbol === undefined || (held !== undefined && this.metaOf(held).param !== undefined)) return;
    if (held === undefined) {
      const passed = this.declaredBuilder(symbol, name);
      if (passed !== undefined) this.builders.set(symbol, passed);
    }
    this.reassign(name, this.traced(initializer), initializer);
  }

  /** What a builder-typed variable holds when the tracer cannot explain the value it is given: an unscoped builder. */
  private declaredBuilder(symbol: ts.Symbol, origin: ts.Node): QueryValue | undefined {
    const declaration = symbol.valueDeclaration;
    return declaration === undefined ? undefined : this.typed(origin, this.checker.getTypeAtLocation(declaration));
  }

  /** An unscoped builder made at `origin` of every builder `type` may be. */
  private typed(origin: ts.Node, type: ts.Type, param?: number): QueryValue | undefined {
    const variants = buildersOf(this.checker, type).map((b) => ({ kind: b.kind, model: b.model ?? 'unknown' }));
    return variants.length === 0 ? undefined : this.made(origin, variants, { accessible: false, unscoped: false }, param);
  }

  private made(origin: ts.Node, variants: readonly Named[], scoped: Scoping, param?: number): QueryValue {
    const [first] = variants;
    const value = unscopedBuilder(origin, first.model);
    value.scoped.accessible = scoped.accessible;
    value.scoped.unscoped = scoped.unscoped;
    this.meta.set(value, { kind: first.kind, origin, ...(param === undefined ? {} : { param }), ...(variants.length > 1 ? { variants } : {}) });
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
    // The name of `{ q }` is the property; the variable it writes is the shorthand's value symbol.
    const symbol = ts.isShorthandPropertyAssignment(name.parent) ? this.checker.getShorthandAssignmentValueSymbol(name.parent) : this.checker.getSymbolAtLocation(name);
    if (symbol === undefined) return;
    this.rewritten.add(symbol);
    const held = this.builders.get(symbol);
    const next = assigned?.pending === true ? assigned.value : (this.declaredBuilder(symbol, origin) ?? (held === undefined ? undefined : this.join([held], origin, true)));
    if (next !== undefined) this.builders.set(symbol, held === undefined ? next : this.join([held, next]));
  }

  /** A variable that may hold a builder is one where it is read, whatever rows it held elsewhere. */
  protected override ofSymbol(id: ts.Identifier): Traced | undefined {
    const symbol = this.checker.getSymbolAtLocation(id);
    const builder = symbol === undefined ? undefined : this.builders.get(symbol);
    return builder === undefined ? super.ofSymbol(id) : { value: builder, pending: true };
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
    return { value: pending.length === 1 && !untyped ? first : this.join(pending, e, untyped), pending: true };
  }

  /** A builder the tracer cannot follow to a model class, read from its type and scoped by the calls chained on it. */
  private byType(e: ts.Expression): Traced | undefined {
    const value = this.typed(e, this.checker.getTypeAtLocation(e));
    if (value === undefined) return undefined;
    // `helper.accessible().builder()`: a call before the builder exists scopes nothing.
    for (const { call } of chainOf(e)?.calls ?? []) if (this.onBuilder(call)) scopeBy(value, call);
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

  /** What a call hands back: any of what its targets hand back, each read on its own. */
  private returnedBy(call: ts.CallExpression): QueryValue | undefined {
    const resolved = this.graph.resolve(call);
    const handed = resolved.targets.flatMap((t) => {
      const returns = this.summaries.get(t.fn)?.returns;
      return returns === undefined ? [] : [this.handedBack(call, returns)];
    });
    if (handed.length === 0) return undefined;
    // What the pass does not see may hand back an unscoped builder.
    if (resolved.opaque || resolved.external || resolved.targets.some((t) => this.handsBackUnsummarised(t.fn))) handed.push(this.byType(call)?.value ?? unscopedBuilder(call, handed[0].model));
    return this.join(handed);
  }

  /** A target that hands back its parameter hands back the argument, scoped further as the target scoped it; another builds its own. */
  private handedBack(call: ts.CallExpression, returns: ReturnedBuilder): QueryValue {
    const argument = returns.param === undefined ? undefined : this.pendingArgument(call, returns.param);
    if (argument === undefined) return this.made(call, returns.variants ?? [{ kind: returns.kind, model: returns.model }], returns.scoped);
    const value = unscopedBuilder(argument.node, argument.model);
    value.scoped.accessible = returns.scoped.accessible || argument.scoped.accessible;
    value.scoped.unscoped = returns.scoped.unscoped || argument.scoped.unscoped;
    this.meta.set(value, this.metaOf(argument));
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

/** The names a destructuring assignment target writes to. */
function assignedNames(target: ts.Expression): ts.Identifier[] {
  const e = unwrap(target);
  if (ts.isIdentifier(e)) return [e];
  if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap(assignedNames);
  if (ts.isSpreadElement(e)) return assignedNames(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return assignedNames(e.left);
  if (!ts.isObjectLiteralExpression(e)) return [];
  return e.properties.flatMap((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return [p.name];
    return ts.isPropertyAssignment(p) ? assignedNames(p.initializer) : ts.isSpreadAssignment(p) ? assignedNames(p.expression) : [];
  });
}

function scopeBy(value: QueryValue, call: ts.CallExpression): void {
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
  if (name === 'accessible') value.scoped.accessible = true;
  if (name === 'unscoped') value.scoped.unscoped = true;
}
