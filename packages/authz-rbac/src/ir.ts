import { GLOBAL } from '@spinajs/authz';
import type { Permission, PermissionRegistry, ResourceType } from '@spinajs/authz';
import type { FragmentBinding, IRFragment, RelationDef, Rewrite, TypeDef } from '@spinajs/authz-ir';

import type { RuleDef } from './contracts.js';
import type { CompiledGrant, GrantIndex } from './model/grants.js';
import type { RoleGraph } from './model/roles.js';

export interface RbacIROptions {
  /** Default 'rbac'. */
  readonly model?: string;
  /** The assignment store the role relations read; default 'authz_assignment'. */
  readonly store?: string;
  /** Principal types an assignment may name; default `['user']`. */
  readonly principalTypes?: readonly string[];
  /** Rules (config and stored) the IR cannot express: each one that can match a permission makes it `unknown` where it would allow. */
  readonly rules?: readonly RuleDef[];
  /** A rule store outside config (DbRuleStore) is in use: its rules are unknown at compile time, so every permission gets an opaque deny term. */
  readonly storedRules?: boolean;
}

const GLOBAL_TYPE = GLOBAL.type;

/** The per-type relation a permission's plain grants reach (`can_invoice_read`). */
export const canRelation = (permission: Permission): string => `can_${permission.replace(/[^A-Za-z0-9_]/g, '_')}`;

const union = (items: Rewrite[]): Rewrite => (items.length === 0 ? { priority: [] } : items.length === 1 ? items[0] : { union: items });
const reach = (name: string): Rewrite => ({ tupleToUserset: { tupleset: 'parent', computed: name } });

/**
 * Roles become stored relations of the types they can be assigned at (`$global` without `scopeTypes`, G21), backed by
 * the assignment table. Each permission `P` gets `can_P` on every type: the roles granting it plainly at that node,
 * or the parent's `can_P` (merge's `defaults` puts `parent->can_P` on the types this model does not know). Grants
 * with `relation` become `role ∩ relation` at the resource type; deny roles the deny side. What the IR cannot express
 * (`on`, `requiresTag`, `grantedAt`, implied roles, ladder resource types, rules) is an `opaque` term, so the answer
 * there is `unknown`, never a guess.
 */
export function rbacToIR(graph: RoleGraph, grants: GrantIndex, registry: PermissionRegistry, options: RbacIROptions = {}): IRFragment {
  const model = options.model ?? 'rbac';
  const c = new Compiler(graph, grants, registry, options);
  for (const name of graph.names) c.role(name);
  const permissions: Record<Permission, FragmentBinding> = {};
  for (const p of c.permissionNames()) {
    const b = c.permission(p);
    if (b !== undefined) permissions[p] = { ...b, list: registry.get(p)?.list === true, source: { origin: `config:authz.${model}.roles` } };
  }
  return { model, types: c.types, defaults: c.defaults, permissions, roles: c.roles, opaque: c.opaque };
}

class Compiler {
  readonly types: Record<string, TypeDef> = { [GLOBAL_TYPE]: { relations: {}, permissions: {} } };
  readonly defaults: TypeDef = { relations: {}, permissions: {} };
  readonly roles: Record<string, Array<{ type: string; relation: string }>> = {};
  readonly opaque: Array<{ kind: 'rewrite'; name: string }> = [];
  private readonly source: RelationDef['source'];

  constructor(
    private readonly graph: RoleGraph,
    private readonly grants: GrantIndex,
    private readonly registry: PermissionRegistry,
    private readonly options: RbacIROptions,
  ) {
    this.source = { kind: 'tuples', store: options.store ?? 'authz_assignment' };
  }

  private type(t: ResourceType): TypeDef {
    return (this.types[t] ??= { relations: {}, permissions: {} });
  }

  /** Where a role's assignments sit. */
  private at(role: string): readonly ResourceType[] {
    const r = this.graph.get(role)!;
    return r.assignable ? (r.scopeTypes ?? [GLOBAL_TYPE]) : [];
  }

  private subjects(): string[] {
    const sets = this.graph.names.filter((n) => this.graph.get(n)!.def.subjectSet === true).flatMap((n) => this.at(n).map((t) => `${t}#${n}`));
    return [...(this.options.principalTypes ?? ['user']), ...sets];
  }

  /** The stored relation at each scope type, and the role's reach (`role` held here or above) everywhere else. */
  role(name: string): void {
    const at = this.at(name);
    if (at.length === 0) return;
    for (const t of at) {
      this.type(t).relations[name] = { allowed: this.subjects(), source: this.source };
      if (t !== GLOBAL_TYPE && at.includes(GLOBAL_TYPE)) this.type(t).permissions[name] = { union: [{ this: true }, reach(name)] };
    }
    if (!at.includes(GLOBAL_TYPE)) this.types[GLOBAL_TYPE].permissions[name] ??= { priority: [] };
    this.defaults.permissions[name] = reach(name);
    this.roles[name] = at.map((type) => ({ type, relation: name }));
  }

  permissionNames(): Permission[] {
    const names = new Set<Permission>();
    for (const r of this.graph.names) for (const p of [...this.grants.permissions(r), ...this.grants.deniedPermissions(r)]) names.add(p);
    return [...names].sort();
  }

  /** The permit and deny relations of `p` on its resource type, with `can_p` laid along the scope chain. */
  permission(p: Permission): Omit<FragmentBinding, 'source' | 'list'> | undefined {
    const resourceType = this.registry.get(p)?.types[0];
    if (resourceType === undefined) return undefined;
    const can = canRelation(p);
    const { plain, local } = this.grantsOf(p);
    for (const [t, terms] of plain) this.type(t).permissions[can] = t === GLOBAL_TYPE ? union(dedupe(terms)) : { union: [...dedupe(terms), reach(can)] };
    this.types[GLOBAL_TYPE].permissions[can] ??= { priority: [] };
    this.defaults.permissions[can] = reach(can);
    const out: Omit<FragmentBinding, 'source' | 'list'> = { type: resourceType };
    if (this.grants.granted(p)) out.permit = this.permitRelation(p, resourceType, can, local);
    const deny = this.denyTerms(p);
    if (deny.length > 0) {
      const name = `rbac_deny_${can.slice(4)}`;
      this.type(resourceType).permissions[name] = union(deny);
      out.deny = name;
    }
    return out;
  }

  /** Plain grants of `p` by the scope types they sit at, and the restricted terms at the resource type. */
  private grantsOf(p: Permission): { plain: Map<ResourceType, Rewrite[]>; local: Rewrite[] } {
    const plain = new Map<ResourceType, Rewrite[]>();
    const local: Rewrite[] = [];
    for (const role of this.graph.names) {
      const def = this.graph.get(role)!.def;
      if (def.deny === true) continue;
      for (const g of this.grants.grants(role, p)) {
        const term = this.grantTerm(role, g);
        if (term === undefined) for (const t of this.at(role)) plain.set(t, [...(plain.get(t) ?? []), { computed: role }]);
        else local.push(term);
      }
      if (def.implies?.some((i) => this.grants.grants(i.role, p).length > 0)) local.push(this.opaqueTerm(`rbac implies of role ${role}`));
    }
    return { plain, local };
  }

  private permitRelation(p: Permission, resourceType: ResourceType, can: string, local: Rewrite[]): string {
    const ladders = this.graph.ladders.filter((l) => l.resourceTypes !== undefined && l.roles.some((r) => this.grants.grants(r, p).length > 0));
    const extra = [...local, ...ladders.map((l) => this.opaqueTerm(`rbac ladder ${l.name} resourceTypes`))];
    if (extra.length === 0) return can;
    const name = `rbac_${can.slice(4)}`;
    this.type(resourceType).permissions[name] = { union: [{ computed: can }, ...extra] };
    return name;
  }

  /** Undefined for a plain grant; else the restricted term at the resource. */
  private grantTerm(role: string, g: CompiledGrant): Rewrite | undefined {
    const parts: Rewrite[] = [];
    if (g.relations !== undefined) parts.push(union(g.relations.map((r) => ({ computed: r }))));
    if (g.patterns !== undefined) parts.push(this.opaqueTerm(`rbac grant on of role ${role}`));
    if (g.requiresTag !== undefined) parts.push(this.opaqueTerm(`rbac grant requiresTag of role ${role}`));
    if (g.grantedAt !== undefined) parts.push(this.opaqueTerm(`rbac grant grantedAt of role ${role}`));
    return parts.length === 0 ? undefined : { intersection: [{ computed: role }, ...parts] };
  }

  private denyTerms(p: Permission): Rewrite[] {
    const terms: Rewrite[] = this.graph.names.filter((r) => this.graph.get(r)!.def.deny === true && this.grants.denies(r, p) && this.at(r).length > 0).map((r) => ({ computed: r }));
    for (const rule of this.options.rules ?? []) if (rule.kind !== 'threshold' || rule.permissions === undefined || rule.permissions.includes(p)) terms.push(this.opaqueTerm(`rbac rule ${rule.id}`));
    if (this.options.storedRules === true) terms.push(this.opaqueTerm('rbac stored rules'));
    return terms;
  }

  private opaqueTerm(name: string): Rewrite {
    if (!this.opaque.some((o) => o.name === name)) this.opaque.push({ kind: 'rewrite', name });
    return { opaque: name };
  }
}

function dedupe(terms: Rewrite[]): Rewrite[] {
  const seen = new Set<string>();
  return terms.filter((t) => {
    const k = JSON.stringify(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
