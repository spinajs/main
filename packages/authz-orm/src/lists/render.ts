import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { AccessPlan, DenyReason, PlanTerm, PlanTermSql, ResourceRef, SqlFragment, SqlRowContext } from '@spinajs/authz';

import { planTermCompilers } from './terms.js';

export type Rendered = { readonly kind: 'all' } | { readonly kind: 'none'; readonly reason: DenyReason } | { readonly kind: 'sql'; readonly sql: string; readonly bindings: readonly unknown[] };

const NOTHING: SqlFragment = Object.freeze({ sql: '1 = 0', bindings: [] });
const EVERYTHING: SqlFragment = Object.freeze({ sql: '1 = 1', bindings: [] });

const isFragment = (v: unknown): v is SqlFragment => v !== null && typeof v === 'object' && typeof (v as SqlFragment).sql === 'string' && Array.isArray((v as SqlFragment).bindings);

function join(parts: readonly SqlFragment[], op: 'OR' | 'AND', empty: SqlFragment): SqlFragment {
  if (parts.length === 0) return empty;
  if (parts.length === 1) return parts[0];
  return { sql: parts.map((p) => `(${p.sql})`).join(` ${op} `), bindings: parts.flatMap((p) => [...p.bindings]) };
}

function term(t: PlanTerm, row: SqlRowContext, compilers: ReadonlyMap<string, PlanTermSql>): SqlFragment {
  const compiler = compilers.get(t?.op);
  if (!compiler) throw new AuthzConfigError(`authz-orm: no PlanTermSql renders op ${JSON.stringify(t?.op)}; register one with @Injectable(PlanTermSql)`);
  const out: unknown = compiler.toSql(t.args, row);
  if (!isFragment(out)) throw new AuthzConfigError(`authz-orm: ${compiler.constructor.name}.toSql() for op ${JSON.stringify(t.op)} must return { sql: string, bindings: unknown[] }`);
  return out;
}

/** The row is one of `within`, or descends from one (authz_resource_ancestor). */
export function withinSql(within: readonly ResourceRef[], row: SqlRowContext): SqlFragment {
  if (within.some((r) => r.type === GLOBAL.type || (r.type === row.type && (r.id === undefined || r.id === null)))) return EVERYTHING;
  const parts: SqlFragment[] = [];
  const selfIds = [...new Set(within.filter((r) => r.type === row.type && r.id !== undefined && r.id !== null).map((r) => String(r.id)))];
  if (selfIds.length > 0) parts.push({ sql: `${row.rowId} IN (${selfIds.map(() => '?').join(', ')})`, bindings: selfIds });
  const above: SqlFragment[] = within.filter((r) => r.id !== undefined && r.id !== null).map((r) => ({ sql: 'authz_w.ancestor_type = ? AND authz_w.ancestor_id = ?', bindings: [r.type, String(r.id)] }));
  const types = [...new Set(within.filter((r) => r.id === undefined || r.id === null).map((r) => r.type))];
  if (types.length > 0) above.push({ sql: `authz_w.ancestor_type IN (${types.map(() => '?').join(', ')})`, bindings: types });
  if (above.length > 0) {
    const any = join(above, 'OR', NOTHING);
    parts.push({ sql: `EXISTS (SELECT 1 FROM ${row.ancestorTable} authz_w WHERE authz_w.resource_type = ? AND authz_w.resource_id = ${row.rowId} AND (${any.sql}))`, bindings: [row.type, ...any.bindings] });
  }
  return join(parts, 'OR', NOTHING);
}

/** Design §6.2 over opaque terms: (permit OR …) AND NOT (deny OR …) AND within. */
export function renderPlan(plan: AccessPlan, row: SqlRowContext, compilers: ReadonlyMap<string, PlanTermSql> = planTermCompilers()): Rendered {
  if (plan.kind === 'none') return { kind: 'none', reason: plan.reason };
  if (plan.kind !== 'filter') throw new AuthzConfigError(`authz-orm: unknown access plan kind ${JSON.stringify((plan as { kind?: unknown }).kind)}`);
  const parts: SqlFragment[] = [];
  const terms = (list: readonly PlanTerm[]): SqlFragment =>
    join(
      list.map((t) => term(t, row, compilers)),
      'OR',
      NOTHING,
    );
  if (plan.permit !== 'all') parts.push(terms(plan.permit));
  if (plan.deny.length > 0) {
    const deny = terms(plan.deny);
    parts.push({ sql: `NOT (${deny.sql})`, bindings: deny.bindings });
  }
  if (plan.within !== undefined) parts.push(withinSql(plan.within, row));
  if (parts.length === 0) return { kind: 'all' };
  const all = join(parts, 'AND', EVERYTHING);
  // Callers AND this into a WHERE that may hold other predicates; a bare top-level OR would escape them.
  return { kind: 'sql', sql: `(${all.sql})`, bindings: all.bindings };
}
