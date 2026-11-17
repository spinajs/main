import { AuthzConfigError, PermissionRegistryImpl, parseCondition } from '@spinajs/authz';
import type { ChangeRecord } from '@spinajs/authz';
import { StoredPolicySplicers, parseStoredPolicyName, stableStringify, storedPolicyName } from '@spinajs/authz-ir';
import type { CaveatDef, KeyState, OpaqueRef, PolicyIR, RelationName, Rewrite, StoredEdge, StoredPlaceholder, TypeName } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import { abacCaveatName, abacPolicyTerms, abacRelation } from './ir.js';
import type { AbacPolicyTerms } from './ir.js';
import { loadPolicy } from './model/policies.js';
import type { LoadedPolicy } from './model/policies.js';
import { DB_POLICY_STORE_NAME, hydrateRecords, recordToPolicy } from './model/stores/db.js';
import { PolicyRecord } from './model/stores/policy-record.js';

type Items = ReadonlyArray<{ key: string; state: KeyState }>;

interface Spliced {
  term: Rewrite;
  caveats?: Record<string, CaveatDef>;
  opaque?: OpaqueRef[];
}

/** The terms of a store's policies at T, and an opaque term for each policy whose state there is unknown. */
type Compiled = AbacPolicyTerms & { readonly unknown: readonly Rewrite[] };

const anyOf = (terms: Rewrite[]): Rewrite => (terms.length === 0 ? { priority: [] } : terms.length === 1 ? terms[0] : { union: terms });

/** The registry the IR was compiled with, as far as the IR binds it: each permission on its resource type. */
function registryOf(ir: PolicyIR): PermissionRegistryImpl {
  const registry = new PermissionRegistryImpl();
  registry.register(
    Object.entries(ir.permissions).map(([name, b]) => ({ name, types: [b.type] })),
    'replay',
  );
  registry.freeze();
  return registry;
}

/** A policy image as the store checks it on write, or undefined when it no longer loads. */
function load(image: unknown, order: number): LoadedPolicy | undefined {
  try {
    return loadPolicy(image, order, { source: DB_POLICY_STORE_NAME }, (c, where) => parseCondition(c, { functions: { has: () => true }, where }));
  } catch (e) {
    if (e instanceof AuthzConfigError) return undefined;
    throw e;
  }
}

/** The policies present at T, and the keys of those unknown there: a gap, an image that no longer loads, a caveat name another policy shares. */
function loadAt(items: Items): { loaded: Map<string, LoadedPolicy>; unknown: Set<string> } {
  const loaded = new Map<string, LoadedPolicy>();
  const unknown = new Set<string>();
  for (const { key, state } of items) {
    if (state.known && state.value === undefined) continue;
    const policy = state.known ? load(state.value, loaded.size) : undefined;
    if (policy === undefined) unknown.add(key);
    else loaded.set(key, policy);
  }
  const holders = new Map<string, string[]>();
  for (const [key, p] of loaded) holders.set(abacCaveatName(p.policy.id), [...(holders.get(abacCaveatName(p.policy.id)) ?? []), key]);
  for (const keys of holders.values()) if (keys.length > 1) keys.forEach((k) => unknown.add(k));
  return { loaded, unknown };
}

/**
 * Splices the policies of `DbPolicyStore` (kind `policy`, keyed by policy id) as they were at a decision's instant into
 * the permit and deny relations of each permission, compiled as `abacToIR` compiles config policies. A policy whose
 * state at T is a gap, or whose image no longer loads, is an opaque term on both sides of every permission. Other policy
 * stores log no changes, so their placeholders stay.
 */
@Singleton()
@Injectable(StoredPolicySplicers)
export class PolicySplicer extends StoredPolicySplicers {
  readonly kind = 'policy' as const;

  /** Per store read: the splice framework hands the same items to every placeholder of the store. */
  private readonly compiled = new WeakMap<Items, Compiled | undefined>();

  locate(opaqueName: string, type: TypeName, relation: RelationName, ir: PolicyIR): StoredPlaceholder | undefined {
    const stored = parseStoredPolicyName(opaqueName);
    const found = Object.entries(ir.permissions).flatMap(([permission, b]) => (['permit', 'deny'] as const).filter((side) => b.type === type && abacRelation(side, permission) === relation).map((side) => ({ permission, side })));
    // Two permissions whose names differ only in the characters a relation name cannot hold share the relation.
    return stored === undefined || found.length !== 1 ? undefined : { ...stored, ...found[0] };
  }

  async current(store: string): Promise<Array<{ key: string; image: unknown }>> {
    if (store !== DB_POLICY_STORE_NAME) return [];
    const rows = await hydrateRecords(PolicyRecord.query().onPrimary());
    return rows.map((r) => ({ key: r.id, image: recordToPolicy(r) }));
  }

  edge(change: ChangeRecord): StoredEdge {
    return { store: DB_POLICY_STORE_NAME, key: change.key };
  }

  splice(at: StoredPlaceholder, items: Items, ir: PolicyIR): Spliced {
    const placeholder: Spliced = { term: { opaque: storedPolicyName(at.model, at.store) } };
    if (at.store !== DB_POLICY_STORE_NAME) return placeholder;
    const compiled = this.compile(items, ir);
    if (compiled === undefined) return placeholder;
    const own = (at.side === 'permit' ? compiled.permit : compiled.deny).get(at.permission) ?? [];
    return { term: anyOf([...own, ...compiled.unknown]), caveats: compiled.caveats, opaque: compiled.opaque };
  }

  /**
   * Undefined when the policies do not compile together (a permission the IR does not bind). A policy whose caveat name
   * another policy shares, or that the stored IR holds with another meaning, is unknown: one caveat would stand for both.
   */
  private compile(items: Items, ir: PolicyIR): Compiled | undefined {
    if (this.compiled.has(items)) return this.compiled.get(items);
    const { loaded, unknown } = loadAt(items);
    let compiled: Compiled | undefined;
    try {
      let terms = this.terms(loaded, unknown, ir);
      const clashing = new Set(
        Object.entries(terms.caveats).flatMap(([name, def]) => {
          const held = Object.entries(ir.caveats).find(([n]) => n === name)?.[1];
          return held !== undefined && stableStringify(held) !== stableStringify(def) ? [name] : [];
        }),
      );
      if (clashing.size > 0) {
        for (const [key, p] of loaded) if (clashing.has(abacCaveatName(p.policy.id))) unknown.add(key);
        terms = this.terms(loaded, unknown, ir);
      }
      const names = items.filter((i) => unknown.has(i.key)).map((i) => `abac policy ${i.key}`);
      compiled = { ...terms, unknown: names.map((name) => ({ opaque: name })), opaque: [...terms.opaque, ...names.map((name): OpaqueRef => ({ kind: 'rewrite', name }))] };
    } catch (e) {
      if (!(e instanceof AuthzConfigError)) throw e;
    }
    this.compiled.set(items, compiled);
    return compiled;
  }

  private terms(loaded: ReadonlyMap<string, LoadedPolicy>, unknown: ReadonlySet<string>, ir: PolicyIR): AbacPolicyTerms {
    return abacPolicyTerms(
      [...loaded].flatMap(([key, p]) => (unknown.has(key) ? [] : [p])),
      registryOf(ir),
    );
  }
}
