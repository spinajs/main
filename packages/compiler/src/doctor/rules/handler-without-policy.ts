import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { accessRefs, ownEntries, withoutIgnored } from './authz-entries.js';
import { runAsOf } from './system-without-reason.js';

export const handlerWithoutPolicy: DoctorRule = {
  code: 'AUTHZ004',
  describe: "Every queue handler of the app declares @Job({ access }) or says why it needs none with @SystemTask(reason); runAs: 'system' alone does not count",
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const e of ownEntries(manifest)) {
      if (e.kind !== 'queue-handler' || accessRefs(e).length > 0 || e.system !== undefined) continue;
      // @Event({ access }) does not exist yet, so an event handler can only say why it needs none.
      const message = e.id.startsWith('job:')
        ? `${e.id} is a queue handler with no @Job({ access }) and no @SystemTask(reason).${runAsOf(manifest, e) === 'system' ? " It runs as SYSTEM: runAs: 'system' needs @SystemTask(reason) as well." : ''}`
        : `${e.id} is a queue handler with no @SystemTask(reason) on its event class.`;
      out.push(diagnostic('AUTHZ004', 'warning', message, e.source));
    }
    return withoutIgnored(manifest, out);
  },
};
