import type { IContainer } from '@spinajs/di';

import { AuthzConfigError } from '../contracts/errors.js';
import type { ResourceType } from '../contracts/principal.js';
import type { ScopeAttributeSchema } from '../contracts/adapter.js';
import type { PermissionRefDecl, RelationRefDecl, ScopeRefDecl } from '../engine/validate.js';
import { resolveChain } from './di.js';

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

const CONTRIBUTION_KEYS: readonly (keyof AuthzContribution)[] = ['permissionRefs', 'relationRefs', 'scopeRefs', 'joinTypes', 'listTypes', 'scopeAttributeSchemas'];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const q = (v: unknown): string => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};
const contributorName = (c: unknown): string => (isObject(c) ? (typeof c.constructor === 'function' && c.constructor.name) || 'AuthzContributor' : q(c));

/** What every AuthzContributor of `container` gives `domain`, in chain order; a failing or malformed one is an AuthzConfigError prefixed with `where`. */
export async function collectContributions(container: IContainer, domain: string, where: string): Promise<AuthzContribution[]> {
  const out: AuthzContribution[] = [];
  for (const contributor of await resolveChain(container, AuthzContributor)) {
    const name = q(contributorName(contributor));
    let contribution: unknown;
    try {
      contribution = await contributor.contribute(domain);
    } catch (e) {
      throw new AuthzConfigError(`${where}: contributor ${name} failed: ${e instanceof Error ? e.message : q(e)}`, { cause: e });
    }
    if (!isObject(contribution) || Array.isArray(contribution)) throw new AuthzConfigError(`${where}: contributor ${name} returned ${q(contribution)} instead of an object`);
    for (const key of CONTRIBUTION_KEYS) {
      if (contribution[key] !== undefined && !Array.isArray(contribution[key])) throw new AuthzConfigError(`${where}: the ${key} of contributor ${name} must be an array`);
    }
    out.push(contribution as AuthzContribution);
  }
  return out;
}
