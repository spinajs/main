import { AuthzContributor } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';

import type { AbacModel } from './model.js';

/** Feeds the ABAC model's permission and scope refs to the host's boot checks (design §6.5 rules 7, 10). */
export class AbacContributor extends AuthzContributor {
  constructor(private readonly model: AbacModel) {
    super();
  }

  contribute(): AuthzContribution {
    return this.model.contribution();
  }
}
