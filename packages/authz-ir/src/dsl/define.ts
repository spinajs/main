/* The shapes are `authz-rebac`'s `NamespaceConfig` and `PermissionMap`, typed by their own names; authz-ir does not depend on authz-rebac. */

interface NamespaceShape {
  readonly relations?: Readonly<Record<string, readonly string[]>>;
  readonly permissions?: Readonly<Record<string, unknown>>;
}

type RelationsOf<D> = D extends { readonly relations: infer R } ? R : Record<never, never>;
type PermissionsOf<D> = D extends { readonly permissions: infer P } ? P : Record<never, never>;

/** Relation and permission names of one namespace. */
export type NamesOf<D> = (keyof RelationsOf<D> | keyof PermissionsOf<D>) & string;

/** The namespaces a tupleset relation may name. */
type Targets<N, T extends keyof N, K> = K extends keyof RelationsOf<N[T]> ? Extract<RelationsOf<N[T]>[K] extends readonly (infer S)[] ? S : never, keyof N & string> : never;

/** `'tupleset->relation'` where the relation exists on a namespace the tupleset names. */
type Arrow<N, T extends keyof N> = { [K in keyof RelationsOf<N[T]> & string]: `${K}->${NamesOf<N[Targets<N, T, K>]>}` }[keyof RelationsOf<N[T]> & string];

/** A rewrite in the ReBAC config syntax whose names are checked against the namespace `T`. */
export type SchemaRewrite<N, T extends keyof N> =
  | NamesOf<N[T]>
  | Arrow<N, T>
  | { readonly computed: NamesOf<N[T]> }
  | { readonly union: readonly SchemaRewrite<N, T>[] }
  | { readonly intersection: readonly SchemaRewrite<N, T>[] }
  | { readonly exclusion: { readonly base: SchemaRewrite<N, T>; readonly subtract: SchemaRewrite<N, T> } };

export type SchemaNamespaces<N> = { readonly [T in keyof N]: { readonly relations?: Readonly<Record<string, readonly string[]>>; readonly permissions?: Readonly<Record<string, SchemaRewrite<N, T>>> } };

/** `'<namespace>#<relation or permission>'`. */
export type SchemaTarget<N> = { [T in keyof N & string]: `${T}#${NamesOf<N[T]>}` }[keyof N & string];

/**
 * A typed `authz.rebac` schema: the value is the plain `namespaces` and `permissions` config (no new config key),
 * and a typo such as `'parent->veiw'` or `'doc#raed'` is a type error.
 */
export function defineAuthzSchema<const N extends Record<string, NamespaceShape>, const P extends Record<string, SchemaTarget<N>> = Record<never, never>>(
  namespaces: N & SchemaNamespaces<N>,
  options: { readonly permissions?: P } = {},
): { readonly namespaces: N; readonly permissions: P } {
  return { namespaces, permissions: options.permissions ?? ({} as P) };
}
