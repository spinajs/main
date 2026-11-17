import ts from 'typescript';
import { EXECUTING_MEMBERS, effectKey, isSystemRunAs, literalReason, runKey } from './authz-effects.js';
import type { AuthzEffect, BuilderKind, EffectScope, FunctionSummary, PathStep, ReturnedBuilder, SystemRun } from './authz-effects.js';
import { isFunctionLike } from './call-graph.js';
import type { CallGraph, CallTarget, FunctionLike } from './call-graph.js';
import { FlowTracer, alternatives } from './flow-tracer.js';
import { modelShape, unwrap } from './query-values.js';
import type { QueryValue } from './query-values.js';

export interface FlowSummaries {
  readonly summaries: ReadonlyMap<FunctionLike, FunctionSummary>;
  readonly opaqueCalls: number;
  readonly externalCalls: number;
}

interface Scope {
  /** The innermost function the node being visited belongs to. */
  readonly owner: FunctionLike;
  /** Set inside the callback of `runAs(SYSTEM, reason, fn)`. */
  readonly system?: { readonly reason?: string };
}

const MAX_ROUNDS = 20;
const isAsync = (fn: FunctionLike): boolean => (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !== 0;

/** The expressions that may leave through `e`: what a literal holds, the operands of a choice, or the expression itself. */
function parts(e: ts.Expression): readonly ts.Expression[] {
  const inner = unwrap(e);
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.flatMap(parts);
  if (ts.isObjectLiteralExpression(inner)) return inner.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? parts(p.initializer) : ts.isShorthandPropertyAssignment(p) ? [p.name] : []));
  return alternatives(inner)?.flatMap(parts) ?? [e];
}

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
  private returns: ReturnedBuilder | undefined;

  constructor(
    private readonly graph: CallGraph,
    private readonly checker: ts.TypeChecker,
    private readonly fn: FunctionLike,
    private readonly summaries: ReadonlyMap<FunctionLike, FunctionSummary>,
    /** An entry point runs `fn`: what it returns goes to the framework, which runs it. */
    private readonly root: boolean,
  ) {
    this.tracer = new FlowTracer(checker, graph, summaries);
    this.tracer.seedParameters(fn);
  }

  run(): FunctionSummary {
    this.enter(this.fn, { owner: this.fn });
    return { effects: [...this.effects.values()], systemRuns: [...this.systemRuns.values()], ...(this.returns === undefined ? {} : { returns: this.returns }), executes: this.executes };
  }

  /** A function written inside the one being summarised is analysed where it stands, with the same builders in scope. */
  private enter(fn: FunctionLike, scope: Scope): void {
    const { body } = fn;
    if (body === undefined) return;
    const inner: Scope = { ...scope, owner: fn };
    if (!ts.isBlock(body)) this.returned(body, inner);
    this.visit(body, inner);
  }

  private visit(node: ts.Node, scope: Scope): void {
    this.tracer.observe(node);
    if (isFunctionLike(node)) this.enter(node, scope);
    else if (ts.isCallExpression(node) && isSystemRunAs(node, this.checker)) this.systemRun(node, scope);
    else {
      this.at(node, scope);
      ts.forEachChild(node, (child) => this.visit(child, scope));
    }
  }

  private at(node: ts.Node, scope: Scope): void {
    if (ts.isAwaitExpression(node)) this.awaited(node, scope);
    else if (ts.isReturnStatement(node) && node.expression !== undefined) this.returned(node.expression, scope);
    else if (ts.isCallExpression(node) || ts.isNewExpression(node)) this.call(node, scope);
    else if (ts.isPropertyAccessExpression(node)) this.callees(node, this.graph.getter(node), scope);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) this.escaped(node.right, scope);
  }

  private awaited(node: ts.AwaitExpression, scope: Scope): void {
    // `await q.first()` is counted at the call.
    if (this.memberExecution(node.expression) !== undefined) return;
    this.escaped(node.expression, scope);
  }

  private returned(expr: ts.Expression, scope: Scope): void {
    if (this.memberExecution(expr) !== undefined) return;
    const traced = this.tracer.traced(expr);
    // Only the function being summarised hands a builder to a caller the pass sees; a promise is already running, and an entry root's caller is the framework.
    if (traced?.pending === true && scope.owner === this.fn && !this.root && !isAsync(this.fn) && !this.isPromise(expr)) this.handBack(traced.value);
    else this.escaped(expr, scope);
  }

  private call(node: ts.CallExpression | ts.NewExpression, scope: Scope): void {
    const run = this.memberExecution(node);
    if (run !== undefined) this.executed(run, node, scope);
    const { targets } = this.graph.resolve(node);
    this.callees(node, targets, scope);
    for (const handed of this.graph.handedTo(node)) this.callees(handed, this.graph.referenced(handed), scope);
    const summaries = targets.flatMap((t) => this.summaries.get(t.fn) ?? []);
    (node.arguments ?? []).forEach((argument, index) => {
      const handedBack = summaries.some((s) => s.returns?.param === index);
      // A followed callee that neither runs nor returns the builder leaves it unexecuted.
      if (summaries.some((s) => s.executes.has(index)) || (targets.length === 0 && !handedBack)) this.escaped(argument, scope);
    });
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
    if (meta.param !== undefined && scoped.scoped === 'none') {
      // The caller knows how its argument was scoped, so the effect is reported at the call.
      this.executes.set(meta.param, meta.kind);
      return;
    }
    this.add({ kind: this.effectKind(meta.kind, at), model: value.model, ...scoped, site: meta.param === undefined ? meta.origin : at, path: [] });
  }

  private handBack(value: QueryValue): void {
    const meta = this.tracer.metaOf(value);
    const had = this.returns;
    // Several returns: scoped only when every one of them is.
    const scoped = { accessible: value.scoped.accessible && (had?.scoped.accessible ?? true), unscoped: value.scoped.unscoped && (had?.scoped.unscoped ?? true) };
    this.returns = { kind: meta.kind, model: value.model, scoped, ...(meta.param === undefined ? {} : { param: meta.param }) };
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
  for (const fn of found) if (fn.body !== undefined) walk(fn.body);
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
