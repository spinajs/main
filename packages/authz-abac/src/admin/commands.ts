import type { ResourceRef } from '@spinajs/authz';

import type { Policy } from '../contracts.js';

/** Inserts or replaces a scoped policy by id; the server sets `source`. */
export interface PolicyPutCommand {
  readonly kind: 'policy.put';
  readonly policy: Omit<Policy, 'source'>;
}

export interface PolicyDeleteCommand {
  readonly kind: 'policy.delete';
  readonly id: string;
}

export interface PoliciesAdminQuery {
  readonly kind: 'policies';
  readonly scope?: ResourceRef;
  readonly page?: { limit: number; offset: number };
}

declare module '@spinajs/authz' {
  interface AuthzCommandMap {
    'policy.put': PolicyPutCommand;
    'policy.delete': PolicyDeleteCommand;
  }

  interface AuthzAdminQueryMap {
    policies: PoliciesAdminQuery;
  }
}
