import type { ResourceType } from '@spinajs/authz';

export interface ParentOptions {
  /** A NULL column means "no parent" (a root); without it `authz:ancestors-verify` reports NULLs. */
  readonly nullable?: boolean;
}

export interface OwnerOptions {
  /** A column holding the owner's principal type; without it the owner is always a `user`. */
  readonly typeColumn?: string;
}

export interface AccessResourceOptions {
  /** The `@Parent` columns of a model the package does not own. */
  readonly parents?: readonly { readonly column: string; readonly type: ResourceType }[];
  /** The `owner` column (the user whose id it holds), or the id column plus a principal type column. */
  readonly owner?: string | { readonly column: string; readonly typeColumn?: string };
  /** The `self` column: the row is the user whose id it holds. */
  readonly self?: string;
}
