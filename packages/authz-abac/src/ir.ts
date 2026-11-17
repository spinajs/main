import { GLOBAL } from '@spinajs/authz';
import type { Condition, ConditionOp, ConditionOperand, ParsedCondition, Permission, PermissionRegistry } from '@spinajs/authz';
import { storedPolicyName } from '@spinajs/authz-ir';
import type { CaveatDef, CaveatParamType, FragmentBinding, IRFragment, OpaqueRef, Rewrite, TypeDef } from '@spinajs/authz-ir';

import { PolicyIndex } from './model/policies.js';
import type { LoadedPolicy } from './model/policies.js';

export interface AbacIROptions {
  /** Default 'abac'. */
  readonly model?: string;
  /** Stores whose policies are not compiled (IRCompileContext.stored 'opaque'): each adds a stored placeholder to every permission. */
  readonly storedStores?: readonly string[];
}

export interface AbacPolicyTerms {
  readonly permit: Map<Permission, Rewrite[]>;
  readonly deny: Map<Permission, Rewrite[]>;
  readonly caveats: Record<string, CaveatDef>;
  readonly opaque: OpaqueRef[];
}

/** Every principal: an intersection of nothing holds. */
const EVERYONE: Rewrite = { intersection: [] };

const union = (items: Rewrite[]): Rewrite => (items.length === 1 ? items[0] : { union: items });
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');

/** The relation that holds a permission's permit or deny policies on its resource type (`abac_permit_<P>`). */
export const abacRelation = (side: 'permit' | 'deny', permission: Permission): string => `abac_${side}_${safe(permission)}`;

/**
 * Policies become caveated union members of `abac_permit_<P>` (permit) or `abac_deny_<P>` (deny) on the permission's
 * resource type (G4). Principal and actor types join the policy's `when` in its caveat. A non-global `scope` and an
 * `expiresAt` cannot be read from the IR's data and are `opaque` terms, as are the condition functions a `when` calls.
 */
export function abacToIR(policies: readonly LoadedPolicy[], registry: PermissionRegistry, options: AbacIROptions = {}): IRFragment {
  const model = options.model ?? 'abac';
  const { permit, deny, caveats, opaque } = abacPolicyTerms(policies, registry);
  const placeholders = (options.storedStores ?? []).map((store) => opaqueTerm(storedPolicyName(model, store), opaque));
  const names = placeholders.length > 0 ? registry.all().map((d) => d.name).sort() : [...permit.keys()];
  const types: Record<string, TypeDef> = {};
  const permissions: Record<Permission, FragmentBinding> = {};
  for (const permission of names) {
    const type = registry.get(permission)?.types[0];
    if (type === undefined) continue;
    const permits = [...(permit.get(permission) ?? []), ...placeholders];
    const denies = [...(deny.get(permission) ?? []), ...placeholders];
    if (permits.length + denies.length === 0) continue;
    const def = (types[type] ??= { relations: {}, permissions: {} });
    const binding: FragmentBinding = { type, list: registry.get(permission)?.list === true, source: { origin: `config:authz.${model}.policies` } };
    if (permits.length > 0) def.permissions[(binding.permit = abacRelation('permit', permission))] = union(permits);
    if (denies.length > 0) def.permissions[(binding.deny = abacRelation('deny', permission))] = union(denies);
    permissions[permission] = binding;
  }
  return { model, types, permissions, caveats, opaque };
}

/** The permit and deny terms of each permission the policies apply to; `abacToIR` unions them, replay (L3) splices them into a stored placeholder. */
export function abacPolicyTerms(policies: readonly LoadedPolicy[], registry: PermissionRegistry): AbacPolicyTerms {
  const index = new PolicyIndex(policies, registry);
  const caveats: Record<string, CaveatDef> = {};
  const opaque: OpaqueRef[] = [];
  const permit = new Map<Permission, Rewrite[]>();
  const deny = new Map<Permission, Rewrite[]>();
  const term = (p: LoadedPolicy): Rewrite => policyTerm(p, caveats, opaque);
  for (const permission of [...index.permissions()].sort()) {
    const type = registry.get(permission)?.types[0];
    if (type === undefined) continue;
    const candidates = index.candidates(permission, type);
    permit.set(permission, candidates.filter((p) => p.policy.effect === 'permit').map(term));
    deny.set(permission, candidates.filter((p) => p.policy.effect === 'deny').map(term));
  }
  return { permit, deny, caveats, opaque };
}

function policyTerm(p: LoadedPolicy, caveats: Record<string, CaveatDef>, opaque: OpaqueRef[]): Rewrite {
  const term = policyCaveat(p, caveats, opaque);
  const restrictions: Rewrite[] = [];
  const scope = p.policy.scope;
  if (scope !== undefined && !(scope.type === GLOBAL.type && scope.id === undefined)) restrictions.push(opaqueTerm(`abac scope of policy ${p.policy.id}`, opaque));
  if (p.expiresAt !== undefined) restrictions.push(opaqueTerm(`abac expiry of policy ${p.policy.id}`, opaque));
  return restrictions.length === 0 ? term : { intersection: [term, ...restrictions] };
}

/** Every principal, under the policy's caveat when it has targets or a `when`. */
function policyCaveat(p: LoadedPolicy, caveats: Record<string, CaveatDef>, opaque: OpaqueRef[]): Rewrite {
  const conditions: Condition[] = [];
  const params: Record<string, CaveatParamType> = {};
  if (p.policy.principalTypes) {
    conditions.push({ attr: 'principal.type', in: [...p.policy.principalTypes] });
    params['principal.type'] = 'string';
  }
  if (p.policy.actorTypes) {
    conditions.push({ attr: 'actor.type', in: [...p.policy.actorTypes] });
    params['actor.type'] = 'string';
  }
  if (p.policy.when !== undefined && p.when !== undefined) {
    conditions.push(p.policy.when);
    inferParams(p.when, params);
    for (const fn of p.when.facts.functions) if (!opaque.some((o) => o.name === fn)) opaque.push({ kind: 'condition-function', name: fn });
  }
  if (conditions.length === 0) return EVERYONE;
  const name = `abac_${safe(p.policy.id)}`;
  caveats[name] = { params, expr: conditions.length === 1 ? conditions[0] : { all: conditions } };
  return { caveat: name, of: EVERYONE };
}

function opaqueTerm(name: string, opaque: OpaqueRef[]): Rewrite {
  if (!opaque.some((o) => o.name === name)) opaque.push({ kind: 'rewrite', name });
  return { opaque: name };
}

/** A parameter per attribute path the condition reads, typed from the operands it is compared with. */
function inferParams(c: ParsedCondition, params: Record<string, CaveatParamType>): void {
  switch (c.kind) {
    case 'all':
    case 'any':
      for (const item of c.items) inferParams(item, params);
      return;
    case 'not':
      inferParams(c.item, params);
      return;
    case 'fn':
      for (const ref of c.facts.refs) params[ref] ??= 'string';
      return;
    case 'cmp':
      params[c.attr.text] ??= literalType(c.op, c.operand);
      if (c.operand.kind === 'ref') params[c.operand.ref.text] ??= c.op === 'in' || c.op === 'nin' ? 'list<string>' : params[c.attr.text];
  }
}

function literalType(op: ConditionOp, operand: ConditionOperand): CaveatParamType {
  if (operand.kind === 'ref' || op === 'null') return 'string';
  const v = Array.isArray(operand.value) ? (operand.value as unknown[])[0] : operand.value;
  if (typeof v === 'number') return 'double';
  if (typeof v === 'boolean') return 'bool';
  return 'string';
}
