import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';

export const workflowSignalWithoutAuthorizer: DoctorRule = {
  code: 'WF002',
  describe: 'A permissioned workflow signal has a SignalAuthorizer that can allow it',
  run(manifest) {
    const authorized = manifest.services.some((s) => s.registeredAs.includes('SignalAuthorizer') && s.className !== 'DenyAllSignalAuthorizer');
    if (authorized) return [];
    const out: Diagnostic[] = [];
    for (const w of manifest.workflows ?? []) {
      for (const s of w.signals) {
        if (!s.permission) continue;
        out.push(
          diagnostic(
            'WF002',
            'warning',
            `Workflow ${w.name} v${w.version} waits for signal ${s.name} with permission ${s.permission}, but no SignalAuthorizer other than DenyAllSignalAuthorizer is registered; every such signal is rejected`,
            w.source,
          ),
        );
      }
    }
    return out;
  },
};
