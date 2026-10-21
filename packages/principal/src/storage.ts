import type { Principal } from './principal.js';

/** req.storage keys written by AuthnMiddleware (D26). */
export interface IAuthnPrincipalStorage {
  /** null: no or pending credentials. authz-http's AuthnPrincipalSource reads it. */
  AuthnPrincipal?: Principal | null;
}
