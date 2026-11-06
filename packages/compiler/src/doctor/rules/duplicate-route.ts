import { overriddenControllers, type ControllerEntry, type Diagnostic, type RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { routeMatchKey } from './route-key.js';
import { reportedAt, routeName } from './inherited.js';

export const duplicateRoute: DoctorRule = {
  code: 'HTTP001',
  describe: 'No two routes share a method and a path',
  run(manifest) {
    const seen = new Map<string, { controller: ControllerEntry; route: RouteEntry }>();
    const out: Diagnostic[] = [];
    const overridden = overriddenControllers(manifest);
    for (const c of manifest.controllers.filter((entry) => !overridden.has(entry.id))) {
      for (const r of c.routes) {
        const method = r.method.toUpperCase();
        const key = `${method} ${routeMatchKey(r.fullPath)}`;
        const first = seen.get(key);
        if (first) {
          const spelled = first.route.fullPath === r.fullPath ? '' : ` (as ${r.fullPath})`;
          out.push(diagnostic('HTTP001', 'error', `Duplicate route ${method} ${first.route.fullPath}: ${routeName(first.controller, first.route)} and ${routeName(c, r)}${spelled}`, reportedAt(c, r)));
        } else {
          seen.set(key, { controller: c, route: r });
        }
      }
    }
    return out;
  },
};
