import ts from 'typescript';
import { EXECUTING_MEMBERS, effectKey, isSystemRunAs, literalReason, runKey } from './authz-effects.js';
import type { AuthzEffect, BuilderKind, EffectScope, FunctionSummary, PathStep, ReturnedBuilder, SystemRun } from './authz-effects.js';
import { isFunctionLike } from './call-graph.js';
import type { CallGraph, CallTarget, FunctionLike } from './call-graph.js';
import { FlowTracer, alternatives } from './flow-tracer.js';
import { chainOf, modelShape, unwrap } from './query-values.js';
import type { QueryValue } from './query-values.js';

export interface FlowSummaries {
  readonly summaries: ReadonlyMap<FunctionLike, FunctionSummary>;
  /** Calls whose callee the program does not determine, plus functions whose summary did not settle. */
  readonly opaqueCalls: number;
  /** Calls into dependency packages, which the pass does not follow. */
  readonly externalCalls: number;
}

interface Scope {
  /** The innermost function the node being visited belongs to. */
  readonly owner: FunctionLike;
  /** Set inside the callback of `runAs(SYSTEM, reason, fn)`. */
  readonly system?: { readonly reason?: string };
}

const MAX_ROUNDS = 20;
/** Each pass over a function's bindings only lowers what they hold, so this bound is a guard, not a limit. */
const MAX_BINDING_PASSES = 10;
const isAsync = (fn: FunctionLike): boolean => (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !== 0;

/** The expressions that may leave through `e`: what a literal holds, the operands of a choice, or the expression itself. */
function parts(e: ts.Expression): readonly ts.Expression[] {
  const inner = unwrap(e);
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.flatMap(parts);
  if (ts.isObjectLiteralExpression(inner)) return inner.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? parts(p.initializer) : ts.isShorthandPropertyAssignment(p) ? [p.name] : []));
  return alternatives(inner)?.flatMap(parts) ?? [e];
}

/** What runs when a function runs, apart from its body: the defaults of its parameters. */
const defaults = (fn: FunctionLike): ts.Expression[] => fn.parameters.flatMap((p) => p.initializer ?? []);

/** `x.p = q`, `x[i] = q`: a builder stored where the pass does not follow it. */
const isStore = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left));

function scopeOf(value: QueryValue, system: Scope['system']): { scoped: EffectScope; reason?: string } {
  if (value.scoped.accessible) return { scoped: 'accessible' };
  if (value.scoped.unscoped) return { scoped: 'unscoped' };
  if (system === undefined) return { scoped: 'none' };
  return { scoped: 'system', ...(system.reason === undefined ? {} : { reason: system.reason }) };
}

/** What a node runs in the package: a call or `new`, the functions it is handed by name, a getter read. */
function targetsAt(graph: CallGraph, node: ts.Node): readonly CallTarget[] {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return [...graph.resolve(node).targets, ...graph.handedTo(node).flatMap((e) => graph.referenced(e))];
  return ts.isPropertyAccessExpression(node) ? graph.getter(node) : [];
}

class FunctionAnalysis {
  private readonly tracer: FlowTracer;
  private readonly effects = new Map<string, AuthzEffect>();
  private readonly systemRuns = new Map<string, SystemRun>();
  private readonly executes = new Map<number, BuilderKind>();
  private readonly handedBack: QueryValue[] = [];

  constructor(
    private readonly graph: CallGraph,
    private readonly checker: ts.TypeChecker,
    private readonly fn: FunctionLike,
    private readonly summaries: ReadonlyMap<FunctionLike, FunctionSummary>,
    /** An entry point runs `fn`: what it returns goes to the framework, which runs it, and its parameters come from there. */
    private readonly root: boolean,
  ) {
    this.tracer = new FlowTracer(checker, graph, summaries);
    this.tracer.seedParameters(fn);
  }

  run(): FunctionSummary {
    this.settle();
    this.enter(this.fn, { owner: this.fn });
    const returns = this.handedBack.length === 0 ? undefined : this.returned(this.tracer.join(this.handedBack));
    return { effects: [...this.effects.values()], systemRuns: [...this.systemRuns.values()], ...(returns === undefined ? {} : { returns }), executes: this.executes };
  }

  /**
   * A loop or a closure can run an assignment before a use written above it, so every binding of the function, its
   * closures' included, is observed until what the variables hold settles, and only then are the uses read: a
   * variable holds any value it is given anywhere in the function. Scoping statements stay where they stand.
   */
  private settle(): void {
    const nodes: ts.Node[] = [];
    const collect = (node: ts.Node): void => {
      nodes.push(node);
      ts.forEachChild(node, collect);
    };
    this.fn.parameters.filter((p) => p.initializer !== undefined).forEach(collect);
    if (this.fn.body !== undefined) collect(this.fn.body);
    let held = this.held();
    for (let pass = 0; pass < MAX_BINDING_PASSES; pass++) {
      for (const node of nodes) this.tracer.observeBinding(node);
      const now = this.held();
      if (now === held) return;
      held = now;
    }
    this.tracer.distrust();
  }

  private held(): string {
    return [...this.tracer.builders.values()].map((v) => `${v.scoped.accessible}${v.scoped.unscoped}${this.tracer.variantsOf(v).length}${this.tracer.metaOf(v).param}`).join();
  }

  /** A function written inside the one being summarised is analysed where it stands, with the same builders in scope. */
  private enter(fn: FunctionLike, scope: Scope): void {
    const inner: Scope = { ...scope, owner: fn };
    for (const initializer of defaults(fn)) this.visit(initializer, inner);
    const { body } = fn;
    if (body === undefined) return;
    if (!ts.isBlock(body)) this.leaves(body, inner);
    this.visit(body, inner);
  }

  private visit(node: ts.Node, scope: Scope): void {
    if (this.scopesHere(node, scope)) this.tracer.observeScoping(node);
    if (isFunctionLike(node)) this.enter(node, scope);
    else if (ts.isCallExpression(node) && isSystemRunAs(node, this.checker)) this.systemRun(node, scope);
    else {
      this.at(node, scope);
      ts.forEachChild(node, (child) => this.visit(child, scope));
    }
  }

  /** A closure may run late or never, so its `q.accessible(p);` scopes only builders it declares itself. */
  private scopesHere(node: ts.Node, scope: Scope): boolean {
    if (scope.owner === this.fn || !ts.isExpressionStatement(node)) return true;
    const root = chainOf(node.expression)?.root;
    const declaration = root !== undefined && ts.isIdentifier(root) ? this.checker.getSymbolAtLocation(root)?.valueDeclaration : undefined;
    return declaration !== undefined && declaration.pos >= scope.owner.pos && declaration.end <= scope.owner.end && declaration.getSourceFile() === scope.owner.getSourceFile();
  }

  private at(node: ts.Node, scope: Scope): void {
    if (ts.isAwaitExpression(node)) this.awaited(node, scope);
    else if (ts.isReturnStatement(node) && node.expression !== undefined) this.leaves(node.expression, scope);
    else if (ts.isYieldExpression(node) && node.expression !== undefined) this.escaped(node.expression, scope);
    else if (ts.isCallExpression(node) || ts.isNewExpression(node)) this.call(node, scope);
    else if (ts.isPropertyAccessExpression(node)) this.callees(node, this.graph.getter(node), scope);
    else if (isStore(node)) this.escaped(node.right, scope);
  }

  private awaited(node: ts.AwaitExpression, scope: Scope): void {
    // `await q.first()` is counted at the call.
    if (this.memberExecution(node.expression) !== undefined) return;
    this.escaped(node.expression, scope);
  }

  /** A returned expression: handed back to the caller, or run. */
  private leaves(expr: ts.Expression, scope: Scope): void {
    if (this.memberExecution(expr) !== undefined) return;
    const traced = this.tracer.traced(expr);
    // Only the function being summarised hands a builder to a caller the pass sees; a promise is already running, and an entry root's caller is the framework.
    if (traced?.pending === true && scope.owner === this.fn && !this.root && !isAsync(this.fn) && !this.isPromise(expr)) this.handedBack.push(traced.value);
    else this.escaped(expr, scope);
  }

  private call(node: ts.CallExpression | ts.NewExpression, scope: Scope): void {
    const run = this.memberExecution(node);
    if (run !== undefined) this.executed(run, node, scope);
    else if (this.startsAtOnce(node)) this.escaped(node, scope);
    const resolved = this.graph.resolve(node);
    this.callees(node, resolved.targets, scope);
    for (const handed of this.graph.handedTo(node)) this.callees(handed, this.graph.referenced(handed), scope);
    const summaries = resolved.targets.flatMap((t) => this.summaries.get(t.fn) ?? []);
    // A member the pass does not follow may run what it is handed; a followed callee that neither runs nor returns it leaves it unexecuted.
    const unfollowed = resolved.targets.length === 0 || resolved.opaque || resolved.external;
    (node.arguments ?? []).forEach((argument, index) => {
      if (unfollowed || summaries.some((s) => s.executes.has(index))) this.escaped(argument, scope);
    });
  }

  /** `Model.find(pks)` returns a promise, not a builder: the query runs when it is called. */
  private startsAtOnce(node: ts.CallExpression | ts.NewExpression): node is ts.CallExpression {
    return ts.isCallExpression(node) && this.isPromise(node) && this.tracer.traced(node)?.pending === true;
  }

  /** The effects of what a call, a `new`, a getter read or a function passed by name runs, one hop further from their sites. */
  private callees(node: ts.Node, targets: readonly CallTarget[], scope: Scope): void {
    for (const target of targets) {
      const summary = this.summaries.get(target.fn);
      if (summary === undefined) continue;
      const step: PathStep = { name: this.graph.nameOf(target.fn), node, via: target.via };
      for (const e of summary.effects) this.add({ ...e, ...this.exempt(e, scope), path: [step, ...e.path] });
      for (const r of summary.systemRuns) this.addRun({ ...r, path: [step, ...r.path] });
    }
  }

  /** Inside a runAs(SYSTEM) callback an unscoped effect of a callee runs as SYSTEM too. */
  private exempt(e: AuthzEffect, scope: Scope): { scoped?: EffectScope; reason?: string } {
    if (e.scoped !== 'none' || scope.system === undefined) return {};
    return { scoped: 'system', ...(scope.system.reason === undefined ? {} : { reason: scope.system.reason }) };
  }

  private systemRun(node: ts.CallExpression, scope: Scope): void {
    const [principal, reasonArgument, callback] = node.arguments;
    const reason = literalReason(reasonArgument);
    this.addRun({ site: node, ...(reason === undefined ? {} : { reason }), path: [] });
    // The innermost runAs(SYSTEM) decides: its reason is the one the audit records.
    const inner: Scope = { owner: scope.owner, system: reason === undefined ? {} : { reason } };
    for (const outside of [node.expression, principal, reasonArgument]) this.visit(outside, scope);
    this.callees(callback, this.graph.referenced(callback), inner);
    this.visit(callback, inner);
  }

  /** Builders that leave what the pass can follow count as executed where they leave. */
  private escaped(expr: ts.Expression, scope: Scope): void {
    for (const part of parts(expr)) {
      const traced = this.tracer.traced(part);
      if (traced?.pending === true) this.executed(traced.value, part, scope);
    }
  }

  private executed(value: QueryValue, at: ts.Expression, scope: Scope): void {
    const meta = this.tracer.metaOf(value);
    const scoped = scopeOf(value, scope.system);
    if (meta.param !== undefined && scoped.scoped === 'none' && !this.root) {
      // The caller knows how its argument was scoped, so the effect is reported at the call.
      this.executes.set(meta.param, meta.kind);
      return;
    }
    const site = meta.param === undefined ? meta.origin : at;
    for (const variant of this.tracer.variantsOf(value)) this.add({ kind: this.effectKind(variant.kind, at), model: variant.model, ...scoped, site, path: [] });
  }

  private returned(value: QueryValue): ReturnedBuilder {
    const { kind, param, variants } = this.tracer.metaOf(value);
    return { kind, model: value.model, scoped: { ...value.scoped }, ...(param === undefined ? {} : { param }), ...(variants === undefined ? {} : { variants }) };
  }

  /** The pending builder `expr` runs by calling one of its executing members (`q.first()`). */
  private memberExecution(expr: ts.Expression): QueryValue | undefined {
    const e = unwrap(expr);
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || !EXECUTING_MEMBERS.has(e.expression.name.text)) return undefined;
    const receiver = this.tracer.traced(e.expression.expression);
    return receiver?.pending === true ? receiver.value : undefined;
  }

  private isPromise(expr: ts.Expression): boolean {
    return this.checker.getTypeAtLocation(expr).getSymbol()?.name === 'Promise';
  }

  private effectKind(kind: BuilderKind, at: ts.Expression): AuthzEffect['kind'] {
    if (kind !== 'select') return kind;
    const awaited = this.checker.getAwaitedType(this.checker.getTypeAtLocation(at));
    return awaited !== undefined && modelShape(this.checker, awaited)?.shape === 'one' ? 'read-one' : 'read-many';
  }

  private add(e: AuthzEffect): void {
    const key = effectKey(e);
    const had = this.effects.get(key);
    if (had === undefined || e.path.length < had.path.length) this.effects.set(key, e);
  }

  private addRun(r: SystemRun): void {
    const key = runKey(r);
    const had = this.systemRuns.get(key);
    if (had === undefined || r.path.length < had.path.length) this.systemRuns.set(key, r);
  }
}

interface Reach {
  readonly order: FunctionLike[];
  readonly opaque: number;
  readonly external: number;
}

/** Every function reachable from the roots, and the calls among them the pass cannot follow, each counted once. */
function reach(graph: CallGraph, roots: readonly FunctionLike[]): Reach {
  const found = new Set<FunctionLike>(roots);
  const counted = new Set<ts.Node>();
  let opaque = 0;
  let external = 0;
  const walk = (node: ts.Node): void => {
    for (const target of targetsAt(graph, node)) found.add(target.fn);
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !counted.has(node)) {
      counted.add(node);
      // The call itself, then every function value it is handed: an unknown one runs unknown code just the same.
      for (const resolved of [graph.resolve(node), ...graph.handedTo(node).map((e) => graph.handed(e))]) {
        if (resolved.opaque) opaque++;
        if (resolved.external) external++;
      }
    }
    ts.forEachChild(node, walk);
  };
  // A Set iterates the entries added while it is iterated, so it is the worklist; no recursion over the call graph.
  for (const fn of found) [...defaults(fn), ...(fn.body === undefined ? [] : [fn.body])].forEach(walk);
  // Found callers first; reversed, most callees are summarised before their callers.
  return { order: [...found].reverse(), opaque, external };
}

const fingerprint = (s: FunctionSummary): string => JSON.stringify([s.effects.map(effectKey).sort(), s.systemRuns.map(runKey).sort(), s.returns ?? null, [...s.executes].sort()]);

/** Per-function authz effects reachable from `roots`, computed to a fixed point over the call graph. */
export function summarize(graph: CallGraph, checker: ts.TypeChecker, roots: readonly FunctionLike[]): FlowSummaries {
  const { order, opaque, external } = reach(graph, roots);
  const entered = new Set(roots);
  const summaries = new Map<FunctionLike, FunctionSummary>();
  let unsettled = order.length;
  for (let round = 0; round < MAX_ROUNDS && unsettled > 0; round++) {
    unsettled = 0;
    for (const fn of order) {
      const next = new FunctionAnalysis(graph, checker, fn, summaries, entered.has(fn)).run();
      const had = summaries.get(fn);
      if (had === undefined || fingerprint(next) !== fingerprint(had)) unsettled++;
      summaries.set(fn, next);
    }
  }
  return { summaries, opaqueCalls: opaque + unsettled, externalCalls: external };
}
