import type { Permission, PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

// The ReBAC admin commands; importing them adds them to AuthzCommand and AuthzAdminQuery.
export type { TupleWriteCommand, TupleDeleteCommand, TuplesAdminQuery } from './admin/commands.js';

/** Everyone who holds `relation` on `object`: a Zanzibar userset, a Keto subject set. */
export interface SubjectSet {
  readonly object: ResourceRef;
  readonly relation: string;
}

/** A principal, an object named as a subject (`doc:d1#parent@folder:f1`), or a subject set. */
export type TupleSubject = PrincipalRef | SubjectSet;

/** `object#relation@subject`; `object.type` is the namespace and `object.id` is required. */
export interface Tuple {
  readonly object: ResourceRef;
  readonly relation: string;
  readonly subject: TupleSubject;
}

/** Every key given narrows; `object` without an id selects its whole namespace. */
export interface TupleQuery {
  readonly object?: ResourceRef;
  readonly relation?: string;
  readonly subject?: TupleSubject;
}

export interface TuplePage {
  readonly limit: number;
  readonly offset: number;
}

export abstract class TupleStore {
  abstract readonly name: string;
  /** The tuples of `object#relation`. */
  abstract read(object: ResourceRef, relation: string): Promise<readonly Tuple[]>;
  /** The objects of `objectType` holding a tuple `#relation@subject`, the subject matched exactly. */
  abstract reverse(subject: TupleSubject, relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]>;
  /** Removes, then adds; writing a stored tuple or removing a missing one changes nothing. Returns a new opaque version. */
  abstract write(add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef): Promise<string>;
  /** Ordered by object, relation and subject key. */
  abstract find(query: TupleQuery, page?: TuplePage): Promise<{ readonly items: readonly Tuple[]; readonly total: number }>;

  /** `reverse` for several subjects at once, without duplicates. */
  async reverseMany(subjects: readonly TupleSubject[], relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]> {
    const out = new Map<string, ResourceRef>();
    for (const subject of subjects) for (const ref of await this.reverse(subject, relation, objectType)) out.set(ref.id ?? '', ref);
    return [...out.values()];
  }
}

/**
 * A permission's rewrite, Keto's OPL as JSON. A string is a computed userset (`'viewer'`: the relation or
 * permission of the same object) or, with an arrow, a tuple-to-userset (`'parent->view'`: `view` on every
 * object the `parent` tuples name).
 */
export type Rewrite =
  | string
  | { readonly computed: string }
  | { readonly tupleToUserset: { readonly tupleset: string; readonly computed: string } }
  | { readonly union: readonly Rewrite[] }
  | { readonly intersection: readonly Rewrite[] }
  | { readonly exclusion: { readonly base: Rewrite; readonly subtract: Rewrite } };

export interface NamespaceDef {
  /** Relation -> allowed subject types: `'user'` (a principal or object of that type) or `'group#member'` (a subject set). */
  readonly relations?: Readonly<Record<string, readonly string[]>>;
  /** Permission -> its rewrite; a permission holds no tuples. */
  readonly permissions?: Readonly<Record<string, Rewrite>>;
}

/** Namespace (resource type) -> its relations and permissions. */
export type NamespaceConfig = Readonly<Record<ResourceType, NamespaceDef>>;

/** SpinaJS permission -> `<namespace>#<relation or permission>`, e.g. `'doc:read': 'doc#view'`. */
export type PermissionMap = Readonly<Record<Permission, string>>;

export interface RebacLimits {
  /** Tuple hops a proof may take from the requested object (default 8). */
  readonly maxDepth?: number;
  /** Node evaluations per check (default 10000). */
  readonly maxCalls?: number;
}
