import type { PermissionRegistry } from '@spinajs/authz';
import type { FragmentBinding, IRFragment, Rewrite, TypeDef } from '@spinajs/authz-ir';

import type { CompiledRewrite, NamespaceSchema } from './namespace/compile.js';

export interface RebacIROptions {
  /** The model name; default 'rebac'. */
  readonly model?: string;
  /** The tuple store the relations read; default 'authz_rebac_tuple'. */
  readonly store?: string;
  /** Marks list permissions. */
  readonly permissions?: PermissionRegistry;
}

/** Namespaces map onto IR types almost one to one: relations are stored tuples, permissions keep their rewrite. */
export function rebacToIR(schema: NamespaceSchema, options: RebacIROptions = {}): IRFragment {
  const model = options.model ?? 'rebac';
  const source = { kind: 'tuples', store: options.store ?? 'authz_rebac_tuple' } as const;
  const types: Record<string, TypeDef> = {};
  for (const [name, ns] of schema.namespaces) {
    const def: TypeDef = { relations: {}, permissions: {} };
    for (const [r, rel] of ns.relations) def.relations[r] = { allowed: [...rel.direct, ...rel.sets.map((s) => `${s.type}#${s.relation}`)], source };
    for (const [p, rw] of ns.permissions) def.permissions[p] = toRewrite(rw);
    types[name] = def;
  }
  const permissions: Record<string, FragmentBinding> = {};
  for (const [permission, target] of schema.targets) {
    permissions[permission] = { type: target.type, permit: target.name, list: options.permissions?.get(permission)?.list === true, source: { origin: `config:authz.${model}.permissions` } };
  }
  return { model, types, permissions };
}

function toRewrite(r: CompiledRewrite): Rewrite {
  switch (r.kind) {
    case 'computed':
      return { computed: r.name };
    case 'ttu':
      return { tupleToUserset: { tupleset: r.tupleset, computed: r.computed } };
    case 'union':
      return { union: r.children.map(toRewrite) };
    case 'intersection':
      return { intersection: r.children.map(toRewrite) };
    case 'exclusion':
      return { exclusion: { base: toRewrite(r.base), subtract: toRewrite(r.subtract) } };
  }
}
