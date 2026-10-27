import type { Principal } from './principal.js';

/**
 * Opens a share link (design §6.1.6): the principal of the link a bearer token belongs to, with
 * `companion` (the request's own principal) speaking with it. An unknown, expired or revoked
 * token must yield a link principal that denies everything (`ceiling.resources: []`, reason
 * `link_invalid`), never null. The model that keeps links registers the implementation
 * (authz-rbac's RbacModel, in its domain's container); authz-http resolves it from the root container.
 */
export abstract class LinkResolver {
  abstract principal(token: string, companion?: Principal): Promise<Principal>;
}
