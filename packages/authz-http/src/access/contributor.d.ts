import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
/**
 * Feeds the permissions every registered controller's `@Access` names to boot rule 7 of the
 * domain it checks in (design §6.5): an unregistered permission, or one checked on a type outside
 * its types, fails that domain's boot (B02). Controllers registered after a domain booted are
 * checked by the next boot only.
 */
export declare class AccessContributor extends AuthzContributor {
    contribute(domain: string): AuthzContribution;
}
//# sourceMappingURL=contributor.d.ts.map