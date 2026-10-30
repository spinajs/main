import type { Diagnostic, RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

type Guardable = Pick<RouteEntry, 'policies' | 'access'>;

const guards = (x: Guardable) => x.policies.length > 0 || (x.access?.length ?? 0) > 0;

export const publicContradictsGuard: DoctorRule = {
  code: 'HTTP006',
  describe: 'A route marked @Public has no @Access or @Policy on it or on its class',
  run(manifest) {
    const out: Diagnostic[] = [];
    const warn = (name: string, source: RouteEntry['source']) =>
      out.push(diagnostic('HTTP006', 'warning', `${name} is marked @Public but also has @Access or @Policy on it or on its class: the guard still runs.`, source));
    for (const c of manifest.controllers) {
      if (c.public !== undefined && guards(c)) warn(c.className, c.source);
      for (const r of c.routes) {
        if (r.public !== undefined && (guards(r) || guards(c))) warn(`${c.className}.${r.handler}`, r.source);
      }
    }
    return out;
  },
};
