import ts from 'typescript';
import type { AuthzSection, Diagnostic, SourceRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { entryName } from '../doctor/rules/authz-entries.js';
import type { AuthzEffect, FunctionSummary, PathStep } from '../flow/authz-effects.js';
import { CallGraph, isFunctionLike } from '../flow/call-graph.js';
import type { FunctionLike } from '../flow/call-graph.js';
import { summarize } from '../flow/summaries.js';
import { compareCodeUnits } from '../sort.js';
import { classesBySource, methodOf } from './access-options.js';
import type { AuthzInputs } from './authz.js';

type Entry = AuthzSection['entryPoints'][number];
type Handlers = Pick<AuthzInputs, 'controllers' | 'socketControllers'>;

interface Located {
  readonly ctx: ExtractorContext;
  readonly graph: CallGraph;
  readonly classes: ReadonlyMap<string, ts.ClassDeclaration>;
  readonly handlers: ReadonlyMap<string, ts.MethodDeclaration | undefined>;
  readonly consumers: ReadonlyMap<string, ts.CallExpression>;
}

interface Found {
  readonly code: string;
  readonly source: SourceRef;
  readonly message: string;
  /** A site may be reached through several effects of one entry point (a union builder); the message counts entry points. */
  readonly entries: Set<Entry>;
}

const WHAT: Readonly<Record<'read-many' | 'update' | 'delete', string>> = { 'read-many': 'multi-row read', update: 'update', delete: 'delete' };
const sourceKey = (s: SourceRef): string => `${s.file}:${s.line}:${s.col}`;
const entryKey = (kind: Entry['kind'], id: string): string => `${kind} ${id}`;

/** `InvoicesController.overdue -> InvoiceService.overdue (injected)`: the root, then each hop with its edge when it is not a plain call. */
const pathText = (graph: CallGraph, root: FunctionLike, path: readonly PathStep[]): string => [graph.nameOf(root), ...path.map((s) => (s.via === 'direct' ? s.name : `${s.name} (${s.via})`))].join(' -> ');

/** The handler method of every route and socket entry, keyed as `authzSectionOf` ids them. */
function handlersOf(inputs: Handlers, classes: ReadonlyMap<string, ts.ClassDeclaration>, ctx: ExtractorContext): Map<string, ts.MethodDeclaration | undefined> {
  const out = new Map<string, ts.MethodDeclaration | undefined>();
  for (const c of inputs.controllers) {
    const cls = classes.get(sourceKey(c.source));
    for (const r of c.routes) out.set(entryKey('route', `${r.method.toUpperCase()} ${r.fullPath}`), methodOf(cls, r.handler, ctx));
  }
  for (const c of inputs.socketControllers) {
    const cls = classes.get(sourceKey(c.source));
    const id = (name: string): string => (c.prefix ? `${c.prefix}.${name}` : name);
    for (const command of c.commands) out.set(entryKey('socket-command', id(command.name)), methodOf(cls, command.handler, ctx));
    for (const event of c.events) out.set(entryKey('socket-event', id(event.name)), methodOf(cls, event.handler, ctx));
  }
  return out;
}

/** The `x.consume(...)` calls of the package by their source, where `event:` entries point. */
function consumeCalls(files: readonly ts.SourceFile[], ctx: ExtractorContext): Map<string, ts.CallExpression> {
  const out = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'consume') out.set(sourceKey(ctx.sourceRef(node)), node);
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return out;
}

/** The function an entry point runs. */
function rootOf(entry: Entry, at: Located): FunctionLike | undefined {
  if (entry.kind === 'route' || entry.kind === 'socket-command' || entry.kind === 'socket-event') return at.handlers.get(entryKey(entry.kind, entry.id));
  if (entry.kind === 'queue-handler' && entry.id.startsWith('event:')) {
    const handler = at.consumers.get(sourceKey(entry.source))?.arguments.at(1);
    if (handler === undefined) return undefined;
    return isFunctionLike(handler) ? handler : at.graph.referenced(handler).at(0)?.fn;
  }
  return methodOf(at.classes.get(sourceKey(entry.source)), 'execute', at.ctx);
}

function note(found: Map<string, Found>, entry: Entry, code: string, source: SourceRef, message: () => string): void {
  const key = `${code} ${sourceKey(source)}`;
  const had = found.get(key);
  if (had === undefined) found.set(key, { code, source, message: message(), entries: new Set([entry]) });
  else had.entries.add(entry);
}

function findingOf(f: Found): Diagnostic {
  const more = f.entries.size - 1;
  return { code: f.code, severity: 'warning', message: more === 0 ? f.message : `${f.message}, and ${more} more entry point${more === 1 ? '' : 's'}`, source: f.source };
}

function order(a: Diagnostic, b: Diagnostic): number {
  const [x, y] = [a.source, b.source];
  if (x === undefined || y === undefined) return compareCodeUnits(a.code, b.code);
  return compareCodeUnits(x.file, y.file) || x.line - y.line || x.col - y.col || compareCodeUnits(a.code, b.code);
}

/** The effects a rule reports; a single-row read and a static that is no read of rows (`other`) are none of them. */
type Reported = AuthzEffect & { readonly kind: keyof typeof WHAT };

const isReported = (e: AuthzEffect): e is Reported => e.scoped === 'none' && e.kind !== 'read-one' && e.kind !== 'other';
const codeOf = (e: Reported): 'AUTHZ001' | 'AUTHZ002' => (e.kind === 'read-many' ? 'AUTHZ001' : 'AUTHZ002');

interface Reading {
  readonly ctx: ExtractorContext;
  readonly graph: CallGraph;
  /** Access resource type by model class name. */
  readonly resources: ReadonlyMap<string, string>;
  readonly ownModels: ReadonlySet<string>;
  readonly found: Map<string, Found>;
  readonly foreign: Set<string>;
}

function readSummary(r: Reading, entry: Entry, fn: FunctionLike, summary: FunctionSummary | undefined): void {
  for (const e of summary?.effects ?? []) {
    if (!isReported(e)) continue;
    const source = r.ctx.sourceRef(e.site);
    if (!r.ownModels.has(e.model)) r.foreign.add(sourceKey(source));
    const type = r.resources.get(e.model);
    if (type === undefined) continue;
    note(r.found, entry, codeOf(e), source, () => `${entryName(entry)} reaches an unscoped ${WHAT[e.kind]} of access resource '${type}' (${e.model}); path: ${pathText(r.graph, fn, e.path)}`);
  }
  for (const run of summary?.systemRuns ?? []) {
    if (run.reason !== undefined) continue;
    note(r.found, entry, 'AUTHZ006', r.ctx.sourceRef(run.site), () => `${entryName(entry)} runs as SYSTEM with no literal reason; path: ${pathText(r.graph, fn, run.path)}`);
  }
}

/** The flow findings of a package and what the pass covered. `ownModels`: the class names of the models the package declares. */
export function authzFlowOf(ctx: ExtractorContext, files: readonly ts.SourceFile[], section: Pick<AuthzSection, 'entryPoints' | 'resources'>, inputs: Handlers, ownModels: ReadonlySet<string>): Pick<AuthzSection, 'findings' | 'flow'> {
  const graph = new CallGraph(ctx.program, files);
  const classes = classesBySource(files, ctx, sourceKey);
  const at: Located = { ctx, graph, classes, handlers: handlersOf(inputs, classes, ctx), consumers: consumeCalls(files, ctx) };
  const roots = section.entryPoints.flatMap((entry) => {
    const fn = rootOf(entry, at);
    return fn === undefined || fn.body === undefined ? [] : [{ entry, fn }];
  });
  const { summaries, opaqueCalls, externalCalls } = summarize(graph, ctx.checker, roots.map((r) => r.fn));
  // Model ids are `<package>:<Class>`.
  const resources = new Map(section.resources.map((r) => [r.model.slice(r.model.indexOf(':') + 1), r.type]));
  const reading: Reading = { ctx, graph, resources, ownModels, found: new Map(), foreign: new Set() };
  for (const { entry, fn } of roots) readSummary(reading, entry, fn, summaries.get(fn));
  return {
    findings: [...reading.found.values()].map(findingOf).sort(order),
    flow: { entryPoints: roots.length, unresolvedRoots: section.entryPoints.length - roots.length, opaqueCalls, externalCalls, foreignModelQueries: reading.foreign.size },
  };
}
