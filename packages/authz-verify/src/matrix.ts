import type { OpaqueRef, PolicyIR } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { RewriteAutomaton, holderKey } from './graph.js';
import type { HolderRef, StoredRead } from './graph.js';
import { explore, reachersOf } from './monotone.js';
import { matchesHolder } from './verdict.js';

/** `always`: holding it grants the permission over an unconditional path; `conditional`: only through non-monotone parts. */
export type Access = 'always' | 'conditional' | 'never';

export interface PermissionMatrix {
  /** Sorted by holder key. */
  readonly holders: HolderRef[];
  /** Sorted. */
  readonly permissions: Permission[];
  /**
   * Holder key to permission to access, over the holder's own paths and the paths that read its relation behind a
   * subject set. A holder also has what `everyone` has.
   */
  readonly cells: Record<string, Record<Permission, Access>>;
  /** Per permission, what every principal holds through an anyone term, whatever its row says; a permission no such term reaches is left out. */
  readonly everyone: Record<Permission, Access>;
  /** Per permission, the parts the analysis cannot see; permissions without any are left out. */
  readonly opaque: Record<Permission, OpaqueRef[]>;
}

const RANK: Record<Access, number> = { never: 0, conditional: 1, always: 2 };
const stronger = (a: Access, b: Access): Access => (RANK[a] >= RANK[b] ? a : b);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What `holder` gets for `permission`: the most of what everyone holds and the cells of the holders it selects, the
 * public holder of the relation it names included. For a holder key, `never` exactly where `never(holder, permission)`
 * holds on the exact engine, `always` exactly where it is violated there.
 */
export function accessOf(m: PermissionMatrix, holder: string, permission: Permission): Access {
  let access: Access = own(m.everyone, permission) ? m.everyone[permission] : 'never';
  for (const h of m.holders) {
    const cells = m.cells[holderKey(h)];
    const named: HolderRef = h.kind === 'public' ? { ...h, kind: h.role === undefined ? 'relation' : 'role' } : h;
    if ((matchesHolder(holder, h) || matchesHolder(holder, named)) && own(cells, permission)) access = stronger(access, cells[permission]);
  }
  return access;
}

/** The relations some subject set reads behind the relation that allows it, at any depth. */
function setMembers(ir: PolicyIR, a: RewriteAutomaton): StoredRead[] {
  const out = new Map<string, StoredRead>();
  for (const [type, def] of Object.entries(ir.types)) for (const relation of Object.keys(def.relations)) for (const r of a.behind(type, relation)) out.set(`${r.type}#${r.relation}`, r);
  return [...out.values()];
}

/**
 * A path that reads one of `members` behind a subject set goes to that relation's holder, or to its public holder
 * when it ends on a wildcard, as never() reads them.
 */
function reachedBehind(a: RewriteAutomaton, start: string, members: readonly StoredRead[]): Array<[HolderRef, Access]> {
  const out: Array<[HolderRef, Access]> = [];
  for (const r of members) {
    for (const x of explore(a, start, undefined, (e) => e.type === r.type && e.relation === r.relation).accepted) {
      if (x.behind === true && x.holder.kind !== 'anyone') out.push([a.holder(r, x.holder.kind === 'public'), x.conditional ? 'conditional' : 'always']);
    }
  }
  return out;
}

export function permissionMatrix(ir: PolicyIR): PermissionMatrix {
  const a = new RewriteAutomaton(ir);
  const permissions = Object.keys(ir.permissions).sort();
  const holders = new Map<string, HolderRef>();
  const reached = new Map<string, Map<Permission, Access>>();
  const opaque: Record<Permission, OpaqueRef[]> = {};
  const everyone: Record<Permission, Access> = {};
  const record = (holder: HolderRef, permission: Permission, access: Access): void => {
    const key = holderKey(holder);
    holders.set(key, holder);
    const row = reached.get(key) ?? new Map<Permission, Access>();
    reached.set(key, row);
    row.set(permission, stronger(row.get(permission) ?? 'never', access));
  };
  const members = setMembers(ir, a);
  for (const permission of permissions) {
    const start = a.start(permission)!;
    const ex = explore(a, start);
    const refs = [...ir.opaque, ...ex.opaque.map((name): OpaqueRef => ({ kind: 'rewrite', name }))];
    if (refs.length > 0) opaque[permission] = refs;
    for (const r of reachersOf(ir, permission, ex)) {
      const access: Access = r.conditional ? 'conditional' : 'always';
      record(r.holder, permission, access);
      if (r.holder.kind === 'anyone') everyone[permission] = stronger(own(everyone, permission) ? everyone[permission] : 'never', access);
    }
    for (const [holder, access] of reachedBehind(a, start, members)) record(holder, permission, access);
  }
  const keys = [...holders.keys()].sort();
  const cells: Record<string, Record<Permission, Access>> = {};
  for (const key of keys) cells[key] = Object.fromEntries(permissions.map((p) => [p, reached.get(key)!.get(p) ?? 'never']));
  return { holders: keys.map((k) => holders.get(k)!), permissions, cells, everyone, opaque };
}
