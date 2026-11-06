import type { Diagnostic, WorkflowEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

const MAX_VERSIONS = 3;

export const workflowTooManyVersions: DoctorRule = {
  code: 'WF003',
  describe: 'A workflow keeps at most three versions registered',
  run(manifest) {
    const byName = new Map<string, WorkflowEntry[]>();
    for (const w of manifest.workflows ?? []) byName.set(w.name, [...(byName.get(w.name) ?? []), w]);
    const out: Diagnostic[] = [];
    for (const [name, entries] of byName) {
      const versions = [...new Set(entries.map((e) => e.version))].sort((a, b) => a - b);
      if (versions.length <= MAX_VERSIONS) continue;
      const newest = entries.reduce((a, b) => (b.version > a.version ? b : a));
      out.push(diagnostic('WF003', 'info', `Workflow ${name} has ${versions.length} registered versions (${versions.join(', ')}); remove the versions no instance uses`, newest.source));
    }
    return out;
  },
};
