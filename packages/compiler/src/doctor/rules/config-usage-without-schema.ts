import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

// Filled by the Configuration itself, never by a package schema.
const BUILTIN_MODULES = new Set(['system', 'app']);

export const configUsageWithoutSchema: DoctorRule = {
  code: 'CFG001',
  describe: 'Every configuration path read in code belongs to a module with a schema',
  run(manifest) {
    const known = new Set([...BUILTIN_MODULES, ...manifest.configModules.map((m) => m.module)]);
    const reported = new Set<string>();
    const out: Diagnostic[] = [];
    for (const u of manifest.configUsages) {
      const module = u.path.split('.')[0];
      if (known.has(module) || reported.has(u.path)) continue;
      reported.add(u.path);
      out.push(diagnostic('CFG001', 'warning', `Config path '${u.path}' is read but no configuration schema declares module '${module}'`, u.source));
    }
    return out;
  },
};
