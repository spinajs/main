import { AuthorizationModel, FALSE, GLOBAL, TRUE, and, compilePermissionGlob, or, principalKey, resourceKey } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, FilterOp, ModelCapabilities, ModelSummary, Permission, PermissionDef, Principal, PrincipalRef, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import { sameRef } from '../util.js';

/** A permission glob, optionally only where the principal holds `relation` on the row. */
export type FakeGrant = string | { readonly permission: string; readonly relation?: string };

export interface FakeAssignment {
  readonly subject: PrincipalRef;
  readonly role: string;
  /** Default GLOBAL. */
  readonly scope?: ResourceRef;
}

export interface FakeRbacOptions {
  readonly name?: string;
  readonly roles: Readonly<Record<string, readonly FakeGrant[]>>;
  readonly assignments?: readonly FakeAssignment[];
}

interface Grant {
  readonly glob: string;
  readonly matches: (p: Permission) => boolean;
  readonly relation?: string;
}

interface Hit {
  readonly scope: ResourceRef;
  readonly relation?: string;
}

const RESIDUALS: readonly FilterOp[] = Object.freeze(['true', 'false', 'and', 'or', 'relation', 'under'] as const);

/**
 * A tiny role map, not RBAC: a role assigned at GLOBAL or at an ancestor of the resource permits
 * its grants. A type-level request answers synchronously with `under` over the assignment scopes
 * (TRUE for GLOBAL), which is what `sync: 'always'` claims (a claim about type-level requests, see
 * runModelConformance); a concrete one reads ctx.ancestors.
 * The principal and its companions speak.
 */
export class FakeRbacModel extends AuthorizationModel {
  readonly name: string;
  readonly capabilities: ModelCapabilities = { effects: ['permit'], residuals: RESIDUALS, sync: 'always', fields: false, needsSubject: false };

  private readonly grants = new Map<string, readonly Grant[]>();
  private assignments: Required<FakeAssignment>[] = [];
  private revision = 0;

  constructor(opts: FakeRbacOptions) {
    super();
    this.name = opts.name ?? 'rbac';
    for (const [role, grants] of Object.entries(opts.roles)) {
      this.grants.set(
        role,
        grants.map((g) => {
          const { permission, relation } = typeof g === 'string' ? { permission: g, relation: undefined } : g;
          return { glob: permission, matches: compilePermissionGlob(permission), ...(relation ? { relation } : {}) };
        }),
      );
    }
    for (const a of opts.assignments ?? []) this.assignments.push(normalise(a));
  }

  assign(a: FakeAssignment): this {
    this.assignments.push(normalise(a));
    this.revision++;
    return this;
  }

  revoke(a: FakeAssignment): this {
    const gone = normalise(a);
    this.assignments = this.assignments.filter((x) => !(principalKey(x.subject) === principalKey(gone.subject) && x.role === gone.role && sameRef(x.scope, gone.scope)));
    this.revision++;
    return this;
  }

  version(): string {
    return String(this.revision);
  }

  init(): void {}

  applies(permission: PermissionDef, _type: ResourceType): boolean {
    return [...this.grants.values()].some((gs) => gs.some((g) => g.matches(permission.name)));
  }

  evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
    const hits = this.of(req.principal).flatMap((a) => (this.grants.get(a.role) ?? []).filter((g) => g.matches(req.permission)).map((g): Hit => ({ scope: a.scope, relation: g.relation })));

    if (req.resource.id == null) return this.vote(typeLevel(hits));

    return ctx.ancestors(req.resource).then((chain) => {
      if (chain == null) return this.vote(FALSE, 'unknown_resource');
      const applicable = hits.filter((h) => chain.some((a) => sameRef(a, h.scope)));
      return this.vote(or(...applicable.map((h) => (h.relation ? relation(h.relation) : TRUE))));
    });
  }

  async summarize(principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    const chain = (await ctx.ancestors(at)) ?? [];
    const live = this.of(principal).filter((a) => chain.some((c) => sameRef(c, a.scope)));
    const permissions = new Map<Permission, boolean>();
    for (const a of live) {
      for (const g of this.grants.get(a.role) ?? []) {
        for (const def of ctx.permissions.match(g.glob)) {
          const conditional = g.relation !== undefined;
          permissions.set(def.name, permissions.has(def.name) ? permissions.get(def.name)! && conditional : conditional);
        }
      }
    }
    return {
      model: this.name,
      roles: live.map((a) => ({ role: a.role, scope: a.scope })),
      permissions: [...permissions].map(([name, conditional]) => ({ name, conditional })),
    };
  }

  private of(p: Principal): Required<FakeAssignment>[] {
    const keys = new Set([principalKey(p), ...(p.companions ?? []).map(principalKey)]);
    return this.assignments.filter((a) => keys.has(principalKey(a.subject)));
  }

  private vote(permitWhen: ResourceFilter, code = 'no_access'): Vote {
    return { model: this.name, permitWhen, denyWhen: FALSE, ...(permitWhen === FALSE ? { reason: { code, model: this.name } } : {}), cacheable: true };
  }
}

const normalise = (a: FakeAssignment): Required<FakeAssignment> => ({ subject: { type: a.subject.type, id: a.subject.id }, role: a.role, scope: a.scope ?? GLOBAL });

const relation = (name: string): ResourceFilter => ({ op: 'relation', relation: name });

function typeLevel(hits: readonly Hit[]): ResourceFilter {
  const scopes = new Map<string, ResourceRef>();
  const parts: ResourceFilter[] = [];
  for (const h of hits) {
    const global = sameRef(h.scope, GLOBAL);
    if (h.relation) parts.push(global ? relation(h.relation) : and({ op: 'under', scopes: [h.scope] }, relation(h.relation)));
    else if (global) return TRUE;
    else scopes.set(resourceKey(h.scope), h.scope);
  }
  return or(...(scopes.size > 0 ? [{ op: 'under' as const, scopes: [...scopes.values()] }] : []), ...parts);
}
