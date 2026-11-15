import type { Diagnostic, Manifest } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { accessRefs, entryName, ownEntries, withoutIgnored, type EntryPoint } from './authz-entries.js';

/** The literal `runAs` of the `@Job` of a `job:<Class>` entry, read from the queue messages of the same package. */
export function runAsOf(manifest: Manifest, entry: EntryPoint): unknown {
  if (!entry.id.startsWith('job:')) return undefined;
  const className = entry.id.slice('job:'.length);
  return manifest.queueMessages.find((q) => q.kind === 'job' && q.className === className && q.source.package === entry.source.package)?.options.runAs;
}

export const systemWithoutReason: DoctorRule = {
  code: 'AUTHZ009',
  describe: "Every schedule, CLI command and runAs: 'system' job of the app says why it runs as SYSTEM with @SystemTask(reason)",
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const e of ownEntries(manifest)) {
      if (e.system !== undefined) continue;
      // A system job without access is AUTHZ004, which names both fixes.
      const systemJob = e.kind === 'queue-handler' && runAsOf(manifest, e) === 'system' && accessRefs(e).length > 0;
      if (e.kind !== 'schedule' && e.kind !== 'cli' && !systemJob) continue;
      out.push(diagnostic('AUTHZ009', 'warning', `${entryName(e)} runs as SYSTEM with no @SystemTask(reason) saying why.`, e.source));
    }
    return withoutIgnored(manifest, out);
  },
};
