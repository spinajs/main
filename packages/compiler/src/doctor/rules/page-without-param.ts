import type { Diagnostic, RoutePagination } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { reportedAt, routeName } from './inherited.js';

const EXPECTED: Record<RoutePagination['kind'], string> = { offset: 'page', cursor: 'cursor or after' };

export const pageWithoutParam: DoctorRule = {
  code: 'HTTP007',
  describe: 'A route that returns Page<T> or CursorPage<T> has a page parameter',
  run(manifest) {
    const out: Diagnostic[] = [];
    for (const c of manifest.controllers) {
      for (const r of c.routes) {
        if (!r.pagination || r.pagination.param) continue;
        const message = `${routeName(c, r)} returns a page but has no page parameter (${EXPECTED[r.pagination.kind]}): the generated client gets no infinite query for it.`;
        out.push(diagnostic('HTTP007', 'warning', message, reportedAt(c, r)));
      }
    }
    return out;
  },
};
