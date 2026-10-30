import type { Diagnostic, Manifest, ServiceEntry } from '@spinajs/manifest';
import { isUnresolvedTokenKey } from '../../token-key.js';
import { compareCodeUnits } from '../../sort.js';
import { diagnostic, type DoctorRule } from '../index.js';

export function tarjan(nodes: string[], edges: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const selfLoop = component.length === 1 && (edges.get(v) ?? []).includes(v);
      if (component.length > 1 || selfLoop) components.push(component.reverse());
    }
  };

  for (const n of nodes) if (!indices.has(n)) strongConnect(n);
  return components;
}

interface Edge {
  to: string;
  soft: boolean;
}

function edgesOf(manifest: Manifest): Map<string, Edge[]> {
  const byToken = new Map<string, ServiceEntry[]>();
  for (const s of manifest.services) for (const key of s.registeredAs) byToken.set(key, [...(byToken.get(key) ?? []), s]);
  const out = new Map<string, Edge[]>();
  for (const s of manifest.services) {
    const edges: Edge[] = [];
    for (const token of s.ctorInjects.filter((t) => !isUnresolvedTokenKey(t))) for (const t of byToken.get(token) ?? []) edges.push({ to: t.id, soft: false });
    for (const p of s.propertyInjects.filter((q) => !isUnresolvedTokenKey(q.token))) for (const t of byToken.get(p.token) ?? []) edges.push({ to: t.id, soft: p.optional || p.lazy === true });
    out.set(s.id, edges);
  }
  return out;
}

function cycleThrough(start: string, adjacency: Map<string, string[]>, members: Set<string>): string[] {
  const parent = new Map<string, string>();
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    const next = (adjacency.get(v) ?? []).filter((w) => members.has(w)).sort(compareCodeUnits);
    for (const w of next) {
      if (w === start) {
        const path = [v];
        while (path[0] !== start) path.unshift(parent.get(path[0])!);
        return path;
      }
      if (!parent.has(w)) {
        parent.set(w, v);
        queue.push(w);
      }
    }
  }
  throw new Error(`DI002: no cycle through ${start} inside its component`);
}

export const diCycle: DoctorRule = {
  code: 'DI002',
  describe: 'No dependency cycles between services',
  run(manifest) {
    const byId = new Map(manifest.services.map((s) => [s.id, s]));
    const edges = edgesOf(manifest);
    const all = new Map([...edges].map(([k, v]) => [k, v.map((e) => e.to)]));
    const hard = new Map([...edges].map(([k, v]) => [k, v.filter((e) => !e.soft).map((e) => e.to)]));
    const out: Diagnostic[] = [];
    const report = (component: string[], adjacency: Map<string, string[]>, severity: Diagnostic['severity']) => {
      const members = new Set(component);
      const start = [...members].sort(compareCodeUnits)[0];
      const names = cycleThrough(start, adjacency, members).map((id) => byId.get(id)!.className);
      out.push(diagnostic('DI002', severity, `Dependency cycle: ${names.join(' -> ')} -> ${names[0]}`, byId.get(start)!.source));
    };
    for (const component of tarjan([...byId.keys()], all)) {
      const members = new Set(component);
      const inside = new Map([...hard].filter(([k]) => members.has(k)).map(([k, v]) => [k, v.filter((w) => members.has(w))]));
      const hardComponents = tarjan(component, inside);
      if (hardComponents.length === 0) report(component, all, 'warning');
      for (const hc of hardComponents) report(hc, inside, 'error');
    }
    return out;
  },
};
