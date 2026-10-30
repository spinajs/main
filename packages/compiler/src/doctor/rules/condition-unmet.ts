import type { Condition, Diagnostic, SourceRef } from '@spinajs/manifest';
import { configAt, diagnostic, type DoctorRule } from '../rule.js';

interface Conditional {
  name: string;
  condition?: Condition;
  source: SourceRef;
}

export const conditionUnmet: DoctorRule = {
  code: 'CFG003',
  describe: 'Conditional registrations are decidable and met by the configuration',
  run(manifest, ctx) {
    const entries: Conditional[] = [
      ...manifest.services.map((s) => ({ name: s.className, condition: s.condition, source: s.source })),
      ...manifest.values.map((v) => ({ name: v.token, condition: v.condition, source: v.source })),
      ...manifest.controllers.map((c) => ({ name: c.className, condition: c.condition, source: c.source })),
    ];
    const out: Diagnostic[] = [];
    for (const e of entries) {
      if (!e.condition) continue;
      if (e.condition.kind === 'dynamic') {
        out.push(diagnostic('CFG003', 'warning', `${e.name} registers conditionally (${e.condition.reason}); the manifest cannot tell whether it loads`, e.source));
        continue;
      }
      if (!ctx.config) continue;
      const { path, expected } = e.condition;
      const value = configAt(ctx.config, path);
      const unmet = expected === undefined ? !value : value !== expected;
      if (!unmet) continue;
      const why = expected === undefined ? 'falsy' : `not ${JSON.stringify(expected)}`;
      out.push(diagnostic('CFG003', 'info', `${e.name} will not register: config '${path}' is ${why}`, e.source));
    }
    return out;
  },
};
