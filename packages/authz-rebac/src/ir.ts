import type { PermissionRegistry } from '@spinajs/authz';
import type { FragmentBinding, IRFragment, ObjectRef, Rewrite, TupleSource, TupleSubjectRef, TypeDef } from '@spinajs/authz-ir';

import type { TupleStore, TupleSubject } from './contracts.js';
import { isSubjectSet } from './keys.js';

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

const subjectRef = (s: TupleSubject): TupleSubjectRef => (isSubjectSet(s) ? { type: s.object.type, id: s.object.id ?? '', relation: s.relation } : { type: s.type, id: s.id });

/** The IR evaluator's view of a ReBAC tuple store; ReBAC relations have no columns. */
export function rebacTupleSource(store: TupleStore): TupleSource {
  return {
    async *read(object: ObjectRef, relation: string): AsyncIterable<TupleSubjectRef> {
      for (const t of await store.read(object, relation)) yield subjectRef(t.subject);
    },
    async *reverse(subject: TupleSubjectRef, relation: string, objectType: string): AsyncIterable<ObjectRef> {
      const s: TupleSubject = subject.relation === undefined ? { type: subject.type, id: subject.id } : { object: { type: subject.type, id: subject.id }, relation: subject.relation };
      for (const o of await store.reverse(s, relation, objectType)) yield { type: o.type, id: o.id ?? '' };
    },
    column: () => Promise.resolve(undefined),
  };
}
