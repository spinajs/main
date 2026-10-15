import type { ResourceType } from '../contracts/principal.js';
import type { ScopeAttributeSchema } from '../contracts/adapter.js';
import type { PermissionRefDecl, RelationRefDecl, ScopeRefDecl } from '../engine/validate.js';

export interface AuthzContribution {
  readonly permissionRefs?: readonly PermissionRefDecl[];
  readonly relationRefs?: readonly RelationRefDecl[];
  readonly scopeRefs?: readonly ScopeRefDecl[];
  readonly joinTypes?: readonly ResourceType[];
  readonly listTypes?: readonly ResourceType[];
  readonly scopeAttributeSchemas?: readonly ScopeAttributeSchema[];
}

/** Feeds a domain's boot checks and scope attribute schemas; every contributor of the container chain is asked. */
export abstract class AuthzContributor {
  abstract contribute(domain: string): AuthzContribution | Promise<AuthzContribution>;
}
