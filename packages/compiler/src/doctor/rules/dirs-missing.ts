import type { Diagnostic } from '@spinajs/manifest';
import { configAt, diagnostic, type DoctorRule } from '../rule.js';

export const dirsMissing: DoctorRule = {
  code: 'CFG002',
  describe: 'Every system.dirs entry exists on disk',
  run(_manifest, ctx) {
    if (!ctx.config) return [];
    const dirs = configAt(ctx.config, 'system.dirs');
    if (!dirs || typeof dirs !== 'object') return [];
    const out: Diagnostic[] = [];
    for (const [key, value] of Object.entries(dirs as Record<string, unknown>)) {
      const list: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
      for (const dir of list) {
        if (typeof dir !== 'string' || ctx.fileExists(dir)) continue;
        out.push(diagnostic('CFG002', 'error', `system.dirs.${key} entry '${dir}' does not exist`));
      }
    }
    return out;
  },
};
