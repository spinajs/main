import type { Diagnostic, WorkflowEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

export const workflowDuplicateVersion: DoctorRule = {
  code: 'WF001',
  describe: 'No two workflow classes share a name and a version',
  run(manifest) {
    const seen = new Map<string, WorkflowEntry>();
    const out: Diagnostic[] = [];
    for (const w of manifest.workflows ?? []) {
      const key = `${w.name}@${w.version}`;
      const first = seen.get(key);
      if (first) out.push(diagnostic('WF001', 'error', `Workflow ${w.name} version ${w.version} is declared by ${first.className} and ${w.className}`, w.source));
      else seen.set(key, w);
    }
    return out;
  },
};
