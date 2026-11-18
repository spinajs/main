import type { OpaqueRef, PolicyIR } from '@spinajs/authz-ir';
import type { Permission } from '@spinajs/authz';

import { RewriteAutomaton, holderKey } from './graph.js';
import type { HolderRef } from './graph.js';
import { explore, reachersOf } from './monotone.js';

/** `always`: holding it grants the permission over an unconditional path; `conditional`: only through non-monotone parts. */
export type Access = 'always' | 'conditional' | 'never';

export interface PermissionMatrix {
  /** Sorted by holder key. */
  readonly holders: HolderRef[];
  /** Sorted. */
  readonly permissions: Permission[];
  /** Holder key to permission to access, over the holder's own paths. A holder also has what `everyone` has. */
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
 * What `holder` gets for `permission`: its own cell or what everyone holds, whichever is more. `never` exactly where
 * `never(holder, permission)` holds on the exact engine, `always` exactly where it is violated there.
 */
export function accessOf(m: PermissionMatrix, holder: string, permission: Permission): Access {
  const cell = own(m.cells, holder) && own(m.cells[holder], permission) ? m.cells[holder][permission] : 'never';
  return stronger(cell, own(m.everyone, permission) ? m.everyone[permission] : 'never');
}

export function permissionMatrix(ir: PolicyIR): PermissionMatrix {
  const a = new RewriteAutomaton(ir);
  const permissions = Object.keys(ir.permissions).sort();
  const holders = new Map<string, HolderRef>();
  const reached = new Map<string, Map<Permission, Access>>();
  const opaque: Record<Permission, OpaqueRef[]> = {};
  const everyone: Record<Permission, Access> = {};
  for (const permission of permissions) {
    const ex = explore(a, a.start(permission)!);
    const refs = [...ir.opaque, ...ex.opaque.map((name): OpaqueRef => ({ kind: 'rewrite', name }))];
    if (refs.length > 0) opaque[permission] = refs;
    for (const r of reachersOf(ir, permission, ex)) {
      const key = holderKey(r.holder);
      const access: Access = r.conditional ? 'conditional' : 'always';
      holders.set(key, r.holder);
      if (!reached.has(key)) reached.set(key, new Map());
      reached.get(key)!.set(permission, access);
      if (r.holder.kind === 'anyone') everyone[permission] = stronger(own(everyone, permission) ? everyone[permission] : 'never', access);
    }
  }
  const keys = [...holders.keys()].sort();
  const cells: Record<string, Record<Permission, Access>> = {};
  for (const key of keys) cells[key] = Object.fromEntries(permissions.map((p) => [p, reached.get(key)!.get(p) ?? 'never']));
  return { holders: keys.map((k) => holders.get(k)!), permissions, cells, everyone, opaque };
}
