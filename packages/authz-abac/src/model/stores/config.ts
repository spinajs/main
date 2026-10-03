import { createHash } from 'node:crypto';
import { AuthzConfigError } from '@spinajs/authz';
import type { Policy } from '@spinajs/authz';

import { PolicyStore } from '../../contracts.js';

/**
 * Policies from config (`authz.abac.policies`, design §8.3). They never change at run time;
 * `version()` is a hash of their content. The model checks each policy when it loads them.
 */
export class ConfigPolicyStore extends PolicyStore {
  readonly name: string = 'config';
  private readonly policies: readonly Policy[];
  private readonly hash: string;

  constructor(policies: unknown = []) {
    super();
    if (!Array.isArray(policies)) throw new AuthzConfigError('authz.abac.policies must be a list');
    this.policies = Object.freeze([...(policies as Policy[])]);
    this.hash = createHash('sha256')
      .update(JSON.stringify(this.policies, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v)) ?? '')
      .digest('hex')
      .slice(0, 16);
  }

  async load(): Promise<readonly Policy[]> {
    return this.policies;
  }

  async version(): Promise<string> {
    return this.hash;
  }
}
