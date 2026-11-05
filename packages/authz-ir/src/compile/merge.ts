import type { AuthorizationModel, IRCompileContext, Permission } from '@spinajs/authz';

import { stableStringify } from '../canonical.js';
import { GLOBAL_TYPE } from '../ir.js';
import type { CaveatDef, CaveatName, CombineIR, FieldRules, OpaqueRef, PolicyIR, PrincipalNarrowing, RelationDef, RelationName, Rewrite, SourceRef, TypeDef, TypeName } from '../ir.js';

/** A permission as one model grants and denies it; `merge` combines the models into one binding. */
export interface FragmentBinding {
  type: TypeName;
  /** The relation that permits; absent when the model only denies. */
  permit?: RelationName;
  /** The relation that denies, for models with deny effects. */
  deny?: RelationName;
  list?: boolean;
  fields?: FieldRules;
  source: SourceRef;
}

/** What one model (or the ORM adapter) contributes to the IR. */
export interface IRFragment {
  model: string;
  types?: Record<TypeName, TypeDef>;
  permissions?: Record<Permission, FragmentBinding>;
  caveats?: Record<CaveatName, CaveatDef>;
  roles?: PrincipalNarrowing['roles'];
  opaque?: OpaqueRef[];
}

export interface MergeOptions {
  /** Every model of the domain in combine order; a model without a fragment is listed in `opaque`. Default: the fragments' models. */
  models?: readonly string[];
  combine?: CombineIR;
  principal?: Partial<Omit<PrincipalNarrowing, 'roles'>>;
}

export interface MergeConflict {
  path: string;
  message: string;
}

/** The constant link of a root type to `$global` (G21): every object's parent is the one `$global` object. */
export const ROOT_SOURCE: RelationDef['source'] = Object.freeze({ kind: 'ancestor', via: GLOBAL_TYPE });

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The relation that holds a combined permission on its type. */
export const permissionRelation = (permission: Permission): RelationName => `perm_${permission.replace(/[^A-Za-z0-9_]/g, '_')}`;

/**
 * Unions the fragments into one `PolicyIR`: adds the `$global` root type, gives every type without a `parent`
 * relation the constant `parent -> $global` link (G21), binds each permission (one permitting model directly,
 * several through a deny-overrides combination) and lists models without a fragment as opaque. The first
 * definition of a relation, permission or caveat wins; a different later one is a conflict.
 */
export function mergeFragments(fragments: readonly IRFragment[], options: MergeOptions = {}): { ir: PolicyIR; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const ir: PolicyIR = {
    version: 1,
    types: { [GLOBAL_TYPE]: { relations: {}, permissions: {} } },
    permissions: {},
    caveats: {},
    combine: options.combine ?? { default: { algorithm: 'deny-overrides' } },
    principal: { ceiling: true, delegation: true, ancestry: 'parent', ...options.principal, roles: {} },
    opaque: [],
  };
  const keep = keeper(conflicts);
  for (const f of fragments) addFragment(ir, f, keep);
  closeAtGlobal(ir);
  bindPermissions(ir, fragments, options.models ?? fragments.map((f) => f.model), conflicts);
  const compiled = new Set(fragments.map((f) => f.model));
  for (const m of options.models ?? []) if (!compiled.has(m)) ir.opaque.push({ kind: 'model', name: m });
  return { ir, conflicts };
}

type Keep = <T>(into: Record<string, T>, key: string, value: T, path: string) => void;

function keeper(conflicts: MergeConflict[]): Keep {
  return <T>(into: Record<string, T>, key: string, value: T, path: string): void => {
    if (!own(into, key)) Object.defineProperty(into, key, { value, enumerable: true, writable: true, configurable: true });
    else if (stableStringify(into[key]) !== stableStringify(value)) conflicts.push({ path, message: `${path} is defined differently by two models; the first definition is kept` });
  };
}

function addFragment(ir: PolicyIR, f: IRFragment, keep: Keep): void {
  for (const [type, def] of Object.entries(f.types ?? {})) {
    if (!own(ir.types, type)) keep(ir.types, type, { relations: {}, permissions: {} }, `types.${type}`);
    for (const [name, rel] of Object.entries(def.relations)) keep(ir.types[type].relations, name, rel, `types.${type}.relations.${name}`);
    for (const [name, rw] of Object.entries(def.permissions)) keep(ir.types[type].permissions, name, rw, `types.${type}.permissions.${name}`);
  }
  for (const [name, c] of Object.entries(f.caveats ?? {})) keep(ir.caveats, name, c, `caveats.${name}`);
  for (const [role, relations] of Object.entries(f.roles ?? {})) ir.principal.roles[role] = [...(ir.principal.roles[role] ?? []), ...relations];
  ir.opaque.push(...(f.opaque ?? []));
}

function closeAtGlobal(ir: PolicyIR): void {
  for (const [type, def] of Object.entries(ir.types)) {
    if (type === GLOBAL_TYPE || own(def.relations, 'parent') || own(def.permissions, 'parent')) continue;
    def.relations.parent = { allowed: [GLOBAL_TYPE], source: ROOT_SOURCE };
  }
}

function bindPermissions(ir: PolicyIR, fragments: readonly IRFragment[], order: readonly string[], conflicts: MergeConflict[]): void {
  const rank = (model: string): number => (order.includes(model) ? order.indexOf(model) : order.length);
  const sorted = [...fragments].sort((a, b) => rank(a.model) - rank(b.model));
  const byPermission = new Map<Permission, FragmentBinding[]>();
  for (const f of sorted) for (const [p, b] of Object.entries(f.permissions ?? {})) byPermission.set(p, [...(byPermission.get(p) ?? []), b]);
  for (const [permission, bindings] of byPermission) {
    const [first] = bindings;
    const same = bindings.filter((b) => b.type === first.type);
    if (same.length < bindings.length) conflicts.push({ path: `permissions.${permission}`, message: `${permission} is bound to several types; only ${first.type} is kept` });
    const list = same.some((b) => b.list === true);
    const fields = same.find((b) => b.fields !== undefined)?.fields;
    const base = { type: first.type, list, source: first.source, ...(fields === undefined ? {} : { fields }) };
    if (same.length === 1 && first.permit !== undefined && first.deny === undefined) {
      ir.permissions[permission] = { ...base, relation: first.permit };
      continue;
    }
    const relation = permissionRelation(permission);
    if (own(ir.types[first.type].relations, relation) || own(ir.types[first.type].permissions, relation)) conflicts.push({ path: `types.${first.type}.permissions.${relation}`, message: `${relation} is already defined; ${permission} overwrites it` });
    ir.types[first.type].permissions[relation] = denyOverrides(same);
    ir.permissions[permission] = { ...base, relation };
  }
}

/** `exclusion(∪ permit, ∪ deny)` (G5); with no permitting model, an empty priority chain, which never permits. */
function denyOverrides(bindings: readonly FragmentBinding[]): Rewrite {
  const permits: Rewrite[] = bindings.flatMap((b) => (b.permit === undefined ? [] : [{ computed: b.permit }]));
  const denies: Rewrite[] = bindings.flatMap((b) => (b.deny === undefined ? [] : [{ computed: b.deny }]));
  if (permits.length === 0) return { priority: [] };
  const permit: Rewrite = permits.length === 1 ? permits[0] : { union: permits };
  if (denies.length === 0) return permit;
  return { exclusion: { base: permit, subtract: denies.length === 1 ? denies[0] : { union: denies } } };
}

/**
 * The fragments of `models` (their optional `toIR`), merged. `context(model)` gives each model its compile context.
 * A model without `toIR` is opaque.
 */
export async function compileModels(models: readonly AuthorizationModel[], context: (model: AuthorizationModel) => IRCompileContext, extra: readonly IRFragment[] = [], options: Omit<MergeOptions, 'models'> = {}): Promise<{ ir: PolicyIR; conflicts: MergeConflict[] }> {
  const fragments: IRFragment[] = [];
  for (const m of models) if (typeof m.toIR === 'function') fragments.push((await m.toIR(context(m))) as IRFragment);
  return mergeFragments([...fragments, ...extra], { ...options, models: models.map((m) => m.name) });
}
