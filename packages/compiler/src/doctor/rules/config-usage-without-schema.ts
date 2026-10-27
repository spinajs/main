import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

// Filled by the Configuration itself, never by a package schema.
const BUILTIN_MODULES = new Set(['system', 'app']);

function commonSegments(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export const configUsageWithoutSchema: DoctorRule = {
  code: 'CFG001',
  describe: 'Every configuration path read in code belongs to a module with a schema',
  run(manifest) {
    const modules = manifest.configModules.map((m) => m.module);
    const reported = new Set<string>();
    const out: Diagnostic[] = [];
    for (const u of manifest.configUsages) {
      const segments = u.path.split('.');
      if (BUILTIN_MODULES.has(segments[0]) || reported.has(u.path)) continue;
      if (modules.some((m) => u.path === m || u.path.startsWith(`${m}.`))) continue;
      reported.add(u.path);
      const shared = Math.max(0, ...modules.map((m) => commonSegments(segments, m.split('.'))));
      const module = segments.slice(0, Math.max(1, shared)).join('.');
      out.push(diagnostic('CFG001', 'warning', `Config path '${u.path}' is read but no configuration schema declares module '${module}'`, u.source));
    }
    return out;
  },
};
