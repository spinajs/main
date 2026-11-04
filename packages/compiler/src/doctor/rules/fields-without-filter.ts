import type { ControllerEntry, Diagnostic, RouteEntry } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { configPermissions, withoutIgnored } from './authz-entries.js';
import { reportedAt, routeName } from './inherited.js';

const FIELDS_MIDDLEWARE = 'AuthzFieldsMiddleware';
const filters = (x: { middlewares: { type: string }[] }): boolean => x.middlewares.some((m) => m.type === FIELDS_MIDDLEWARE);

export const fieldsWithoutFilter: DoctorRule = {
  code: 'AUTHZ008',
  describe: "A route that checks a permission declared with fields: true filters its fields with @Access(…, { fields: 'filter' }) (with --config)",
  run(manifest, ctx) {
    const withFields = new Set([...configPermissions(ctx.config)].filter(([, def]) => def.fields === true).map(([name]) => name));
    if (withFields.size === 0) return [];
    const out: Diagnostic[] = [];
    const check = (c: ControllerEntry, r: RouteEntry): void => {
      const permission = [...(c.access ?? []), ...(r.access ?? [])].find((p) => withFields.has(p));
      if (permission === undefined || filters(c) || filters(r)) return;
      out.push(diagnostic('AUTHZ008', 'warning', `${routeName(c, r)} checks ${permission}, declared with fields: true, but returns every field: add { fields: 'filter' } to its @Access.`, reportedAt(c, r)));
    };
    for (const c of manifest.controllers) {
      if (c.source.package === manifest.app.name) for (const r of c.routes) check(c, r);
    }
    return withoutIgnored(manifest, out);
  },
};
