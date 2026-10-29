import type { Diagnostic, RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

type Guardable = Pick<RouteEntry, 'policies' | 'access' | 'allowAnonymous'>;

const guarded = (x: Guardable) => x.policies.length > 0 || (x.access?.length ?? 0) > 0 || x.allowAnonymous === true;

export const routeWithoutPolicy: DoctorRule = {
  code: 'HTTP002',
  describe: 'Every route has @Access, @Policy or @AllowAnonymous on it or on its class',
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      if (guarded(c)) continue;
      for (const r of c.routes) {
        if (guarded(r)) continue;
        out.push(diagnostic('HTTP002', 'error', `${c.className}.${r.handler} is a route with no @Access, @Policy or @AllowAnonymous on it or on its class.`, r.source));
      }
    }
    return out;
  },
};
