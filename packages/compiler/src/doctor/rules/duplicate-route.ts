import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

export const duplicateRoute: DoctorRule = {
  code: 'HTTP001',
  describe: 'No two routes share a method and a path',
  run(manifest) {
    const seen = new Map<string, { className: string; handler: string }>();
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      for (const r of c.routes) {
        const key = `${r.method.toUpperCase()} ${r.fullPath}`;
        const first = seen.get(key);
        if (first) {
          out.push(diagnostic('HTTP001', 'error', `Duplicate route ${key}: ${first.className}.${first.handler} and ${c.className}.${r.handler}`, r.source));
        } else {
          seen.set(key, { className: c.className, handler: r.handler });
        }
      }
    }
    return out;
  },
};
