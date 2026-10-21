import type { Principal } from './principal.js';

export interface IAuthnPrincipalStorage {
  AuthnPrincipal?: Principal | null;
}
