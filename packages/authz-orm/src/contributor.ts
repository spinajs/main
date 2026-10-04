import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';

import { classesOf, entryOf, registeredTypes } from './registry.js';

/** Boot rule 6 input: the types whose residuals compile into JOIN ON. */
@Singleton()
@Injectable(AuthzContributor)
export class OrmAuthzContributor extends AuthzContributor {
  contribute(): AuthzContribution {
    return { joinTypes: registeredTypes().filter((t) => classesOf(t).some((c) => entryOf(c)?.relationScope === 'join')) };
  }
}
