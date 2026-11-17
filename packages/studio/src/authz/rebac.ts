import type { AuthzDomains } from '@spinajs/authz';
import { BadRequest } from '@spinajs/exceptions';

import type { StudioGraph, StudioTuple, StudioTupleRef } from '../contracts/index.js';
import { GraphBuilder } from '../graph/graph.js';
import { truncate } from '../span.js';
import { bootedService } from './domains.js';

// Structural views of @spinajs/authz-rebac (ResourceRef, TupleSubject, Tuple, TupleQuery, TupleStore), so Studio's
// source needs no dependency on a package an app may not use.
interface RefLike {
  readonly type: string;
  readonly id?: string;
}
type SubjectLike = RefLike | { readonly object: RefLike; readonly relation: string };

export interface TupleLike {
  readonly object: RefLike;
  readonly relation: string;
  readonly subject: SubjectLike;
}

export interface TupleQueryLike {
  readonly object?: RefLike;
  readonly relation?: string;
  readonly subject?: SubjectLike;
}

export interface TupleStoreLike {
  read(object: RefLike, relation: string): Promise<readonly TupleLike[]>;
  reverse(subject: SubjectLike, relation: string, objectType: string): Promise<readonly RefLike[]>;
  find(query: TupleQueryLike, page?: { readonly limit: number; readonly offset: number }): Promise<{ readonly items: readonly TupleLike[]; readonly total: number }>;
}

type RewriteLike =
  | { readonly kind: 'computed'; readonly name: string }
  | { readonly kind: 'ttu'; readonly tupleset: string; readonly computed: string }
  | { readonly kind: 'union' | 'intersection'; readonly children: readonly RewriteLike[] }
  | { readonly kind: 'exclusion'; readonly base: RewriteLike; readonly subtract: RewriteLike };

export interface CompiledNamespaceLike {
  readonly relations: ReadonlyMap<string, { readonly direct: readonly string[]; readonly sets: readonly { readonly type: string; readonly relation: string }[] }>;
  readonly permissions: ReadonlyMap<string, RewriteLike>;
}
export interface SchemaLike {
  readonly namespaces: ReadonlyMap<string, CompiledNamespaceLike>;
}
export interface RebacLike {
  schema(): SchemaLike;
  store(): TupleStoreLike;
}

export function isRebacModel(model: unknown): model is RebacLike {
  return typeof model === 'object' && model !== null && 'schema' in model && typeof model.schema === 'function' && 'store' in model && typeof model.store === 'function';
}

export function rebacOf(domains: AuthzDomains, domain: string): RebacLike | undefined {
  for (const model of bootedService(domains, domain)?.models() ?? []) if (isRebacModel(model)) return model;
  return undefined;
}

export interface Focus {
  type: string;
  id: string;
  relation?: string;
}

const FOCUS = /^([^:#\s]+):([^#\s]+)(?:#([^#\s]+))?$/;

/** `type:id` or `type:id#relation`; the refusal does not echo the value. */
export function parseFocus(raw: string, what = 'focus'): Focus {
  const m = FOCUS.exec(raw);
  if (!m) throw new BadRequest(`${what} must be type:id or type:id#relation`);
  return { type: m[1], id: m[2], ...(m[3] ? { relation: m[3] } : {}) };
}

export const focusId = (f: Focus): string => `${f.type}:${f.id}${f.relation ? `#${f.relation}` : ''}`;

function focusOf(s: SubjectLike): Focus {
  return 'object' in s ? { type: s.object.type, id: s.object.id ?? '', relation: s.relation } : { type: s.type, id: s.id ?? '' };
}

function wireRef(f: Focus): StudioTupleRef {
  return { type: truncate(f.type), id: truncate(f.id), ...(f.relation === undefined ? {} : { relation: truncate(f.relation) }) };
}

/** Object, relation and subject only: a store may hold more beside a tuple (who wrote it, when), and none of it leaves. */
export function toStudioTuple(t: TupleLike): StudioTuple {
  return { object: wireRef({ type: t.object.type, id: t.object.id ?? '' }), relation: truncate(t.relation), subject: wireRef(focusOf(t.subject)) };
}

function* rewriteEdges(r: RewriteLike): Generator<{ kind: 'computed' | 'tupleset'; target: string; label?: string }> {
  if (r.kind === 'computed') yield { kind: 'computed', target: r.name };
  else if (r.kind === 'ttu') yield { kind: 'tupleset', target: r.tupleset, label: `->${r.computed}` };
  else if (r.kind === 'exclusion') {
    yield* rewriteEdges(r.base);
    yield* rewriteEdges(r.subtract);
  } else for (const c of r.children) yield* rewriteEdges(c);
}

const relId = (type: string, name: string): string => `rel:${type}#${name}`;

export function namespacesGraph(schema: SchemaLike): StudioGraph {
  const b = new GraphBuilder();
  for (const [type, ns] of schema.namespaces) {
    b.node({ id: `ns:${type}`, label: type, kind: 'namespace', attributes: {} });
    for (const name of ns.relations.keys()) b.node({ id: relId(type, name), label: `${type}#${name}`, kind: 'relation', group: type, attributes: {} });
    for (const name of ns.permissions.keys()) b.node({ id: relId(type, name), label: `${type}#${name}`, kind: 'permission', group: type, attributes: {} });
  }
  for (const [type, ns] of schema.namespaces) {
    for (const [name, r] of ns.relations) {
      b.edge(`ns:${type}`, relId(type, name), 'has');
      for (const subject of r.direct) b.edge(relId(type, name), `ns:${subject}`, 'subject');
      for (const set of r.sets) b.edge(relId(type, name), relId(set.type, set.relation), 'subject-set');
    }
    for (const [name, rewrite] of ns.permissions) {
      b.edge(`ns:${type}`, relId(type, name), 'has');
      for (const e of rewriteEdges(rewrite)) b.edge(relId(type, name), relId(type, e.target), e.kind, e.label);
    }
  }
  return b.build('runtime');
}

/** Store calls one walk may make; past it the graph is cut like past the node limit. */
export const MAX_STORE_READS = 2000;

interface Walk {
  readonly model: RebacLike;
  readonly b: GraphBuilder;
  readonly limit: number;
  readonly seen: Set<string>;
  reads: number;
  truncated: boolean;
}

/** Counts one store call; false once the node limit was hit or the budget is spent, and the walk asks nothing more. */
function mayRead(w: Walk): boolean {
  if (w.truncated) return false;
  if (w.reads >= MAX_STORE_READS) {
    w.truncated = true;
    return false;
  }
  w.reads++;
  return true;
}

/** False when the node was already there or the limit refused it. */
function visit(w: Walk, f: Focus): boolean {
  const id = focusId(f);
  if (w.seen.has(id)) return false;
  if (w.seen.size >= w.limit) {
    w.truncated = true;
    return false;
  }
  w.seen.add(id);
  w.b.node({ id, label: id, kind: f.relation ? 'userset' : 'object', group: f.type, attributes: {} });
  return true;
}

// Adds `node` when the limit allows and the edge `from -> to`; a node seen for the first time joins the next frontier.
function link(w: Walk, node: Focus, from: Focus, to: Focus, relation: string, found: Focus[]): void {
  const fresh = visit(w, node);
  if (!w.seen.has(focusId(node))) return;
  w.b.edge(focusId(from), focusId(to), truncate(relation), relation);
  if (fresh) found.push(node);
}

async function outbound(w: Walk, f: Focus): Promise<Focus[]> {
  const relations = f.relation ? [f.relation] : [...(w.model.schema().namespaces.get(f.type)?.relations.keys() ?? [])];
  const found: Focus[] = [];
  for (const relation of relations) {
    if (!mayRead(w)) break;
    for (const t of await w.model.store().read({ type: f.type, id: f.id }, relation)) {
      const target = focusOf(t.subject);
      link(w, target, f, target, relation, found);
    }
  }
  return found;
}

// The relations, in any namespace, that admit an object of `type` as a direct subject.
function admitting(schema: SchemaLike, type: string): { type: string; relation: string }[] {
  const out: { type: string; relation: string }[] = [];
  for (const [owner, ns] of schema.namespaces) {
    for (const [relation, r] of ns.relations) {
      if (r.direct.includes(type)) out.push({ type: owner, relation });
    }
  }
  return out;
}

async function inbound(w: Walk, f: Focus): Promise<Focus[]> {
  if (f.relation) return [];
  const found: Focus[] = [];
  for (const { type, relation } of admitting(w.model.schema(), f.type)) {
    if (!mayRead(w)) break;
    for (const ref of await w.model.store().reverse({ type: f.type, id: f.id }, relation, type)) {
      const source: Focus = { type, id: ref.id ?? '' };
      link(w, source, source, f, relation, found);
    }
  }
  return found;
}

/** Breadth-first over stored tuples in both directions, at most `depth` hops, `limit` nodes and MAX_STORE_READS store calls. */
export async function relationsGraph(model: RebacLike, focus: Focus, depth: number, limit: number): Promise<StudioGraph> {
  const w: Walk = { model, b: new GraphBuilder(), limit, seen: new Set(), reads: 0, truncated: false };
  visit(w, focus);
  let frontier = [focus];
  for (let hop = 0; hop < depth && frontier.length > 0 && !w.truncated; hop++) {
    const next: Focus[] = [];
    for (const f of frontier) {
      if (w.truncated) break;
      next.push(...(await outbound(w, f)), ...(await inbound(w, f)));
    }
    frontier = next;
  }
  const graph = w.b.build('runtime');
  graph.truncated = w.truncated;
  return graph;
}
