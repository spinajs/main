/** A closed path through a directed graph: `nodes` ends where it starts, and `edges[i]` leads from `nodes[i]` to `nodes[i + 1]`. */
export interface GraphCycle<N, E> {
  readonly nodes: readonly N[];
  readonly edges: readonly E[];
}

const identity = <E, N>(edge: E): N => edge as unknown as N;

/**
 * The first cycle a depth-first search meets, starting from each of `nodes` in order and following `edgesOf` in
 * order; undefined when the graph has none. Iterative, so a deep graph cannot overflow the stack. Without
 * `targetOf`, edges are the nodes they lead to.
 */
export function findCycle<N, E = N>(nodes: Iterable<N>, edgesOf: (node: N) => Iterable<E>, targetOf: (edge: E) => N = identity): GraphCycle<N, E> | undefined {
  const ON_PATH = 1;
  const DONE = 2;
  const state = new Map<N, number>();
  for (const start of nodes) {
    if (state.has(start)) continue;
    state.set(start, ON_PATH);
    // `via` is the edge that led to `node`.
    const path: { node: N; via: E | undefined; out: Iterator<E> }[] = [{ node: start, via: undefined, out: edgesOf(start)[Symbol.iterator]() }];
    while (path.length) {
      const top = path[path.length - 1];
      const step = top.out.next();
      if (step.done === true) {
        state.set(top.node, DONE);
        path.pop();
        continue;
      }
      const edge = step.value;
      const to = targetOf(edge);
      const seen = state.get(to);
      if (seen === ON_PATH) {
        const onCycle = path.slice(path.findIndex((f) => f.node === to));
        return { nodes: [...onCycle.map((f) => f.node), to], edges: [...onCycle.slice(1).map((f) => f.via as E), edge] };
      }
      if (seen === undefined) {
        state.set(to, ON_PATH);
        path.push({ node: to, via: edge, out: edgesOf(to)[Symbol.iterator]() });
      }
    }
  }
  return undefined;
}

/** `start` and every node reachable from it, in breadth-first order. Without `targetOf`, edges are the nodes they lead to. */
export function reachable<N, E = N>(start: N, edgesOf: (node: N) => Iterable<E>, targetOf: (edge: E) => N = identity): N[] {
  const closure = [start];
  const seen = new Set(closure);
  for (let i = 0; i < closure.length; i++) {
    for (const edge of edgesOf(closure[i])) {
      const to = targetOf(edge);
      if (seen.has(to)) continue;
      seen.add(to);
      closure.push(to);
    }
  }
  return closure;
}
