import type { Diagnostic, RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';
import { routeMatchKey } from './route-key.js';

export const duplicateRoute: DoctorRule = {
  code: 'HTTP001',
  describe: 'No two routes share a method and a path',
  run(manifest) {
    const seen = new Map<string, { className: string; route: RouteEntry }>();
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      for (const r of c.routes) {
        const method = r.method.toUpperCase();
        const key = `${method} ${routeMatchKey(r.fullPath)}`;
        const first = seen.get(key);
        if (first) {
          const spelled = first.route.fullPath === r.fullPath ? '' : ` (as ${r.fullPath})`;
          out.push(diagnostic('HTTP001', 'error', `Duplicate route ${method} ${first.route.fullPath}: ${first.className}.${first.route.handler} and ${c.className}.${r.handler}${spelled}`, r.source));
        } else {
          seen.set(key, { className: c.className, route: r });
        }
      }
    }
    return out;
  },
};
