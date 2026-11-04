import type { Condition, FieldSet, Permission } from '@spinajs/authz';

export type TypeName = string;
export type RelationName = string;
export type CaveatName = string;

/** The singleton root type (G21): roles without scope types are stored relations of its one object. */
export const GLOBAL_TYPE: TypeName = '$global';
export const GLOBAL_OBJECT: ObjectRef = Object.freeze({ type: GLOBAL_TYPE, id: GLOBAL_TYPE });

export interface PolicyIR {
  version: 1;
  types: Record<TypeName, TypeDef>;
  /** 'invoice:read' to the relation that grants it */
  permissions: Record<Permission, PermissionBinding>;
  caveats: Record<CaveatName, CaveatDef>;
  /** From authz.combine (G5). */
  combine: CombineIR;
  /** Ceiling and delegation (G6). */
  principal: PrincipalNarrowing;
  /** Models, combinators and condition functions the IR cannot see. */
  opaque: OpaqueRef[];
}

export interface TypeDef {
  /** Stored or column-derived. */
  relations: Record<RelationName, RelationDef>;
  /** Computed. A name in both maps keeps its stored tuples, which the rewrite reads through `{ this: true }`. */
  permissions: Record<RelationName, Rewrite>;
}

/** `'user'`, `'group#member'` (a subject set), `'user:*'` (public wildcard), or one of them admitted only under a caveat. */
export type SubjectTypeRef = string | { type: string; caveat: CaveatName };

export interface RelationDef {
  allowed: SubjectTypeRef[];
  source:
    | { kind: 'tuples'; store: string } // authz_rebac_tuple, assignment table, membership closure
    | { kind: 'column'; model: string; column: string; typeColumn?: string } // G3
    | { kind: 'ancestor'; via: string } // RBAC scope chain from ResourceAdapter
    | { kind: 'self' };
}

export type Rewrite =
  | { this: true }
  | { computed: RelationName }
  | { tupleToUserset: { tupleset: RelationName; computed: RelationName } }
  | { union: Rewrite[] }
  | { intersection: Rewrite[] }
  | { exclusion: { base: Rewrite; subtract: Rewrite } }
  | { caveat: CaveatName; of: Rewrite } // ABAC `when` (G4)
  | { priority: Array<{ when: Rewrite; then: 'permit' | 'deny' }> } // first-applicable (G5)
  | { opaque: string };

export type CaveatParamType = 'string' | 'int' | 'double' | 'bool' | 'timestamp' | 'ipaddress' | 'list<string>';

/** `params` are keyed by the attribute path the condition reads (`'resource.status'`), so `expr` stays a core `Condition`. */
export interface CaveatDef {
  params: Record<string, CaveatParamType>;
  expr: Condition;
}

export type FieldRules = FieldSet;

/** Where a part of the IR came from: `config:authz.rbac.roles.clerk`, `model:rbac`, `decorator:Invoice.project_id`. */
export interface SourceRef {
  origin: string;
  file?: string;
  line?: number;
}

export interface PermissionBinding {
  type: TypeName;
  relation: RelationName;
  fields?: FieldRules;
  list: boolean;
  source: SourceRef;
}

export type CombineAlgorithmIR = 'deny-overrides' | 'permit-overrides' | 'first-applicable' | { opaque: string };

export interface CombineEntryIR {
  algorithm: CombineAlgorithmIR;
  /** Voting models in order; the order matters for first-applicable. */
  models?: string[];
}

/** Mirrors `CombineConfig` (`authz/src/engine/routes.ts`). */
export interface CombineIR {
  default: CombineEntryIR;
  types?: Record<TypeName, CombineEntryIR>;
}

/** `allowed(p, perm, r) = perm(p, r) ∧ ceiling(p, perm, r) ∧ delegation(p, perm, r)` (G6). */
export interface PrincipalNarrowing {
  ceiling: boolean;
  delegation: boolean;
  /** The tupleset a ceiling's `resources` walk up (`parent`). */
  ancestry: RelationName;
  /** Role name to the stored relations that hold it, so `ceiling.roles` can drop the others. */
  roles: Record<string, Array<{ type: TypeName; relation: RelationName }>>;
}

export interface OpaqueRef {
  kind: 'model' | 'combinator' | 'condition-function' | 'native-filter' | 'rewrite';
  name: string;
  source?: SourceRef;
}

export interface ObjectRef {
  readonly type: TypeName;
  readonly id: string;
}

/** A principal or object; a subject set with `relation`; the public wildcard with `id: '*'`; a conditional tuple with `caveat`. */
export interface TupleSubjectRef {
  readonly type: TypeName;
  readonly id: string;
  readonly relation?: RelationName;
  readonly caveat?: { readonly name: CaveatName; readonly context?: Readonly<Record<string, unknown>> };
}

/** The serialisable part of a `Principal` the IR reads. */
export interface PrincipalFacts {
  readonly type: string;
  readonly id: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly ceiling?: {
    readonly roles?: readonly string[];
    readonly permissions?: readonly string[];
    readonly resources?: readonly { readonly type: string; readonly id?: string }[];
    /** ISO instant. */
    readonly expiresAt?: string;
  };
  readonly onBehalfOf?: PrincipalFacts;
  /** With onBehalfOf; default 'intersect'. */
  readonly delegation?: 'intersect' | 'inherit';
}

export type IRCode = 'IR001' | 'IR002' | 'IR003' | 'IR004' | 'IR005';

export interface IRDiagnostic {
  code: IRCode;
  /** Dotted location: `types.doc.permissions.view`. */
  path: string;
  message: string;
}

export interface ParsedSubjectType {
  type: TypeName;
  relation?: RelationName;
  wildcard: boolean;
  caveat?: CaveatName;
}

export function parseSubjectTypeRef(ref: SubjectTypeRef): ParsedSubjectType {
  const text = typeof ref === 'string' ? ref : ref.type;
  const caveat = typeof ref === 'string' ? undefined : ref.caveat;
  const base = caveat === undefined ? {} : { caveat };
  if (text.endsWith(':*')) return { type: text.slice(0, -2), wildcard: true, ...base };
  const hash = text.indexOf('#');
  if (hash < 0) return { type: text, wildcard: false, ...base };
  return { type: text.slice(0, hash), relation: text.slice(hash + 1), wildcard: false, ...base };
}
