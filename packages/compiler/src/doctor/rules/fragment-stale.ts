import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../index.js';

export const fragmentStale: DoctorRule = {
  code: 'BLD001',
  describe: 'Every dependency fragment is at least as new as its build output',
  run(manifest, ctx) {
    const out: Diagnostic[] = [];
    for (const p of manifest.packages) {
      const fragment = ctx.fragmentMtime(p.name);
      const lib = ctx.libMtime(p.name);
      if (fragment === undefined) {
        out.push(diagnostic('BLD001', 'error', `Fragment of ${p.name} is missing at ${p.fragment}`));
        continue;
      }
      if (lib !== undefined && fragment < lib) {
        out.push(diagnostic('BLD001', 'error', `Fragment of ${p.name} is older than its build output; run npm run build`));
      }
    }
    return out;
  },
};
