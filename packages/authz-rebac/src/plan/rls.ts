import { AuthzConfigError } from '@spinajs/authz';
import type { AuthorizationModel, ModelListPlan, PermissionDef, Principal, ResourceType } from '@spinajs/authz';
import { PlanTermCompiler, RlsPlanSource, RlsSubjectKeys } from '@spinajs/authz-orm/plan';
import type { RlsSqlContext } from '@spinajs/authz-orm/plan';
import { Injectable, Singleton } from '@spinajs/di';

import { subjectKey } from '../keys.js';
import { rebacHolders, rebacListSupport } from '../model/filter.js';
import { RebacModel } from '../model/model.js';
import type { CompiledRewrite, NamespaceSchema } from '../namespace/compile.js';
import { AUTHZ_REBAC_TUPLE_TABLE } from '../stores/db.js';

/** The list-plan term of a ReBAC permission for row level security only (`authz:rls`); `.accessible()` plans use `rebac.tuples`. */
export const REBAC_RLS_PLAN_OP = 'rebac.rls';

/**
 * A relation's rewrite unrolled for any principal: `tuples` holds when the object has a tuple of the relation
 * whose subject key is one of the session's (the principal's own and the usersets it is in), `arrow` when one
 * of the object's `tupleset` tuples names an object of `type` for which `expr` holds.
 */
export type RebacRlsExpr = { readonly tuples: string } | { readonly arrow: { readonly tupleset: string; readonly type: ResourceType; readonly expr: RebacRlsExpr } } | { readonly any: readonly RebacRlsExpr[] } | { readonly all: readonly RebacRlsExpr[] };

// A policy holds one sub-query per node; past this the rewrite is something the database should not evaluate.
const MAX_NODES = 2000;

/**
 * The rewrite of `name` on `t` with at most `budget` tuple-to-userset hops, as the list plan expands it. Subject
 * sets are not unrolled: the session's subject keys carry the usersets the principal is in.
 * @throws Error for an exclusion or a rewrite of more than MAX_NODES nodes
 */
export function rebacRlsExpr(schema: NamespaceSchema, t: ResourceType, name: string, budget: number): RebacRlsExpr {
  let nodes = 0;
  const node = <E extends RebacRlsExpr>(e: E): E => {
    if (++nodes > MAX_NODES) throw new Error(`rebac: the rewrite of ${t}#${name} unrolls to more than ${MAX_NODES} sub-queries`);
    return e;
  };
  const named = (type: ResourceType, n: string, left: number): RebacRlsExpr => (schema.relation(type, n) ? node({ tuples: n }) : rewrite(type, schema.permission(type, n)!, left));
  const rewrite = (type: ResourceType, r: CompiledRewrite, left: number): RebacRlsExpr => {
    switch (r.kind) {
      case 'computed':
        return named(type, r.name, left);
      case 'ttu': {
        const targets = left < 1 ? [] : (schema.relation(type, r.tupleset)?.direct ?? []).filter((x) => schema.namespaces.has(x));
        return node({ any: targets.map((x) => node({ arrow: { tupleset: r.tupleset, type: x, expr: named(x, r.computed, left - 1) } })) });
      }
      case 'union':
        return node({ any: r.children.map((c) => rewrite(type, c, left)) });
      case 'intersection':
        return node({ all: r.children.map((c) => rewrite(type, c, left)) });
      case 'exclusion':
        throw new Error(`rebac: an exclusion on ${type} has no row level security form`);
    }
  };
  return named(t, name, budget);
}

function render(e: RebacRlsExpr, ns: string, id: string, ctx: RlsSqlContext, next: () => number): string {
  if ('tuples' in e) {
    const a = `rt${next()}`;
    return `EXISTS (SELECT 1 FROM ${AUTHZ_REBAC_TUPLE_TABLE} ${a} WHERE ${a}.namespace = ${ns} AND ${a}.object_id = ${id} AND ${a}.relation = ${ctx.literal(e.tuples)} AND ${a}.subject_key IN (${ctx.subjectKeys}))`;
  }
  if ('arrow' in e) {
    const a = `rp${next()}`;
    const { tupleset, type, expr } = e.arrow;
    return `EXISTS (SELECT 1 FROM ${AUTHZ_REBAC_TUPLE_TABLE} ${a} WHERE ${a}.namespace = ${ns} AND ${a}.object_id = ${id} AND ${a}.relation = ${ctx.literal(tupleset)} AND ${a}.subject_type = ${ctx.literal(type)} AND ${a}.subject_relation = '' AND ${render(expr, ctx.literal(type), `${a}.subject_id`, ctx, next)})`;
  }
  const [parts, glue, empty] = 'any' in e ? [e.any, ' OR ', 'FALSE'] : [e.all, ' AND ', 'TRUE'];
  return parts.length === 0 ? empty : `(${parts.map((p) => render(p, ns, id, ctx, next)).join(glue)})`;
}

/** `rebac.rls`: an RLS-only term; `.accessible()` never plans it, so the query-builder form refuses it. */
@Singleton()
@Injectable(PlanTermCompiler)
export class RebacRlsTerm extends PlanTermCompiler {
  readonly op = REBAC_RLS_PLAN_OP;

  apply(): void {
    throw new AuthzConfigError(`${REBAC_RLS_PLAN_OP} is a row level security term; list plans use rebac.tuples`);
  }

  renderSql(args: unknown, ctx: RlsSqlContext): string {
    let n = 0;
    return render(args as RebacRlsExpr, ctx.literal(ctx.type), ctx.id, ctx, () => n++);
  }
}

const rebacOf = (model: AuthorizationModel): RebacModel => {
  if (!(model instanceof RebacModel)) throw new Error(`rebac: the domain's model '${model.name}' is not a RebacModel`);
  return model;
};

@Singleton()
@Injectable(RlsPlanSource)
export class RebacRlsPlanSource extends RlsPlanSource {
  readonly model = 'rebac';

  plan(model: AuthorizationModel, permission: PermissionDef, type: ResourceType): ModelListPlan {
    const m = rebacOf(model);
    const schema = m.schema();
    const support = rebacListSupport(schema, permission.name, type);
    if (support !== true) throw new Error(support.reason);
    const target = schema.targets.get(permission.name)!;
    return { kind: 'terms', permit: [{ op: REBAC_RLS_PLAN_OP, args: rebacRlsExpr(schema, type, target.name, m.limit().maxDepth) }], deny: [] };
  }
}

/** ReBAC's session keys: the principal's own and every userset key a relation names that holds it, within maxDepth - 1 hops. */
@Singleton()
@Injectable(RlsSubjectKeys)
export class RebacRlsSubjectKeys extends RlsSubjectKeys {
  readonly model = 'rebac';

  async keys(model: AuthorizationModel, principal: Principal): Promise<readonly string[]> {
    const m = rebacOf(model);
    const schema = m.schema();
    const holders = rebacHolders(schema, m.store(), { type: principal.type, id: principal.id });
    const keys = new Set([subjectKey({ type: principal.type, id: principal.id })]);
    const sets = new Map<string, { readonly type: ResourceType; readonly relation: string }>();
    for (const ns of schema.namespaces.values()) for (const rel of ns.relations.values()) for (const s of rel.sets) sets.set(`${s.type}#${s.relation}`, s);
    for (const s of sets.values()) for (const id of await holders(s.type, s.relation, m.limit().maxDepth - 1)) keys.add(subjectKey({ object: { type: s.type, id }, relation: s.relation }));
    return [...keys];
  }
}
