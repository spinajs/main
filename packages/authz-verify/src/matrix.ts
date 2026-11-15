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
  /** Holder key to permission to access. */
  readonly cells: Record<string, Record<Permission, Access>>;
  /** Per permission, the parts the analysis cannot see; permissions without any are left out. */
  readonly opaque: Record<Permission, OpaqueRef[]>;
}

export function permissionMatrix(ir: PolicyIR): PermissionMatrix {
  const a = new RewriteAutomaton(ir);
  const permissions = Object.keys(ir.permissions).sort();
  const holders = new Map<string, HolderRef>();
  const reached = new Map<string, Map<Permission, Access>>();
  const opaque: Record<Permission, OpaqueRef[]> = {};
  for (const permission of permissions) {
    const ex = explore(a, a.start(permission)!);
    const refs = [...ir.opaque, ...ex.opaque.map((name): OpaqueRef => ({ kind: 'rewrite', name }))];
    if (refs.length > 0) opaque[permission] = refs;
    for (const r of reachersOf(ir, permission, ex)) {
      const key = holderKey(r.holder);
      holders.set(key, r.holder);
      if (!reached.has(key)) reached.set(key, new Map());
      reached.get(key)!.set(permission, r.conditional ? 'conditional' : 'always');
    }
  }
  const keys = [...holders.keys()].sort();
  const cells: Record<string, Record<Permission, Access>> = {};
  for (const key of keys) cells[key] = Object.fromEntries(permissions.map((p) => [p, reached.get(key)!.get(p) ?? 'never']));
  return { holders: keys.map((k) => holders.get(k)!), permissions, cells, opaque };
}
