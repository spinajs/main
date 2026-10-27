import type { Diagnostic, Manifest, ServiceEntry } from '@spinajs/manifest';
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
    for (const token of s.ctorInjects) for (const t of byToken.get(token) ?? []) edges.push({ to: t.id, soft: false });
    for (const p of s.propertyInjects) for (const t of byToken.get(p.token) ?? []) edges.push({ to: t.id, soft: p.optional || p.lazy === true });
    out.set(s.id, edges);
  }
  return out;
}

export const diCycle: DoctorRule = {
  code: 'DI002',
  describe: 'No dependency cycles between services',
  run(manifest) {
    const byId = new Map(manifest.services.map((s) => [s.id, s]));
    const edges = edgesOf(manifest);
    const plain = new Map([...edges].map(([k, v]) => [k, v.map((e) => e.to)]));
    const out: Diagnostic[] = [];
    for (const component of tarjan([...byId.keys()], plain)) {
      const members = new Set(component);
      const soft = component.some((id) => (edges.get(id) ?? []).some((e) => members.has(e.to) && e.soft));
      const names = component.map((id) => byId.get(id)!.className);
      const start = names.indexOf([...names].sort()[0]);
      const rotated = [...names.slice(start), ...names.slice(0, start)];
      out.push(diagnostic('DI002', soft ? 'warning' : 'error', `Dependency cycle: ${rotated.join(' -> ')} -> ${rotated[0]}`, byId.get(component[start])!.source));
    }
    return out;
  },
};
