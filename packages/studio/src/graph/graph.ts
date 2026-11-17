import { BadRequest } from '@spinajs/exceptions';
import { Query } from '@spinajs/http';

import type { GraphEdge, GraphNode, StudioGraph, StudioSource } from '../contracts/index.js';
import { given } from '../queries/params.js';
import { truncate } from '../span.js';

export const DEFAULT_GRAPH_LIMIT = 500;
export const MAX_GRAPH_LIMIT = 5000;
export const MAX_GRAPH_DEPTH = 10;

export const edgeId = (source: string, kind: string, target: string, label?: string): string => `${source}|${kind}|${target}${label === undefined ? '' : `|${label}`}`;

function cutAttributes(attributes: GraphNode['attributes']): GraphNode['attributes'] {
  const out: GraphNode['attributes'] = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = typeof value === 'string' ? truncate(value) : value;
  return out;
}

/**
 * Collects nodes and edges once each; a node added twice merges its attributes; an edge to a missing node is dropped at build.
 * Every id, label, group and string attribute is cut at 2 KiB, since all of them are names taken from the application.
 */
export class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  public node(node: GraphNode): void {
    const id = truncate(node.id);
    const found = this.nodes.get(id);
    const attributes = cutAttributes(node.attributes);
    if (!found) {
      this.nodes.set(id, { ...node, id, label: truncate(node.label), ...(node.group === undefined ? {} : { group: truncate(node.group) }), attributes });
      return;
    }
    Object.assign(found.attributes, attributes);
    if (found.group === undefined && node.group !== undefined) found.group = truncate(node.group);
  }

  public has(id: string): boolean {
    return this.nodes.has(truncate(id));
  }

  public edge(source: string, target: string, kind: string, label?: string): void {
    const [from, to, text] = [truncate(source), truncate(target), label === undefined ? undefined : truncate(label)];
    const id = edgeId(from, kind, to, text);
    if (!this.edges.has(id)) this.edges.set(id, { id, source: from, target: to, kind, ...(text === undefined ? {} : { label: text }) });
  }

  public build(source: StudioSource): StudioGraph {
    const edges = [...this.edges.values()].filter((e) => this.nodes.has(e.source) && this.nodes.has(e.target));
    return { source, nodes: [...this.nodes.values()], edges, truncated: false };
  }
}

export interface GraphView {
  focus?: string;
  depth?: number;
  group?: string;
  limit?: number;
}

// Breadth-first over edges in both directions, so the nearest nodes survive a limit cut.
function neighbourhood(graph: StudioGraph, focus: string, depth: number, allowed: ReadonlySet<string>): string[] {
  const adjacent = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const list = adjacent.get(a);
    if (list) list.push(b);
    else adjacent.set(a, [b]);
  };
  for (const e of graph.edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const order = [focus];
  const seen = new Set(order);
  let frontier = [focus];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacent.get(id) ?? []) {
        if (!allowed.has(n) || seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    order.push(...next);
    frontier = next;
  }
  return order;
}

/** A focus must be a node id. */
export function viewOf(graph: StudioGraph, view: GraphView): StudioGraph {
  const inGroup = graph.nodes.filter((n) => view.group === undefined || n.group === view.group).map((n) => n.id);
  const ordered = view.focus === undefined ? inGroup : neighbourhood(graph, view.focus, view.depth ?? 1, new Set(inGroup));
  const limit = view.limit ?? DEFAULT_GRAPH_LIMIT;
  const rank = new Map(ordered.slice(0, limit).map((id, i) => [id, i]));
  return {
    source: graph.source,
    nodes: graph.nodes.filter((n) => rank.has(n.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)),
    edges: graph.edges.filter((e) => rank.has(e.source) && rank.has(e.target)),
    truncated: graph.truncated || ordered.length > limit,
  };
}

/** `?depth=` hops around a focus; the handler parameter is named `depth`. */
export function DepthQuery(): ReturnType<typeof Query> {
  return Query({ type: 'integer', minimum: 0, maximum: MAX_GRAPH_DEPTH });
}

/** The validated graph arguments as a view: empty values dropped; a depth without a focus is refused. */
export function graphView(args: { focus: string | undefined; group: string | undefined; depth: number | undefined; limit: number | undefined }): GraphView {
  const focus = given(args.focus);
  const group = given(args.group);
  if (args.depth !== undefined && focus === undefined) throw new BadRequest('depth needs a focus');
  return { ...(focus ? { focus } : {}), ...(group ? { group } : {}), ...(args.depth === undefined ? {} : { depth: args.depth }), ...(args.limit === undefined ? {} : { limit: args.limit }) };
}
