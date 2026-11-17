import type { DoctorRule } from '../rule.js';
import { withoutIgnored } from './authz-entries.js';

const byCode = (code: string, describe: string): DoctorRule => ({
  code,
  describe,
  run: (manifest) => withoutIgnored(manifest, (manifest.authz?.findings ?? []).filter((d) => d.code === code && d.source?.package === manifest.app.name)),
});

export const flowUnscopedRead = byCode('AUTHZ001', 'No entry point reaches a multi-row read of an access resource without .accessible(), .unscoped(reason) or runAs(SYSTEM, reason), across helpers and injected services');
export const flowUnscopedWrite = byCode('AUTHZ002', 'No entry point reaches an update or delete builder of an access resource without .accessible(), .unscoped(reason) or runAs(SYSTEM, reason)');
export const flowSystemWithoutReason = byCode('AUTHZ006', 'Every runAs(SYSTEM, reason) an entry point reaches gives a literal reason');
