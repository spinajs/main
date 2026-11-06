import type { PrincipalNarrowing, RelationName } from '../ir.js';

export interface PrincipalOptions {
  /** Apply `Principal.ceiling` (default true). */
  ceiling?: boolean;
  /** Apply `onBehalfOf` delegation (default true). */
  delegation?: boolean;
  /** The tupleset a ceiling's resources walk up (default 'parent'). */
  ancestry?: RelationName;
}

/** The root narrowing (G6) every permission's check goes through; the roles come from the models. */
export function principalNarrowing(options: PrincipalOptions = {}): Omit<PrincipalNarrowing, 'roles'> {
  return { ceiling: options.ceiling ?? true, delegation: options.delegation ?? true, ancestry: options.ancestry ?? 'parent' };
}
