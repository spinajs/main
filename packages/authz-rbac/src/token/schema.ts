import { ROLE_OR_PREFIX } from './role-pattern.js';
import { DEFAULT_TOKEN_ROLE_POLICY } from './rules.js';

/** `authz.token.*` (design §8.2, §18.3(g)): the roles a token principal loses, and the TokenRolePolicy that narrows the rest. */
export const AUTHZ_TOKEN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-token.configuration.schema.json',
  $configurationModule: 'authz.token',
  description: 'Token role rules (authz.token.*)',
  type: 'object',
  properties: {
    excludedRoles: { type: 'array', default: [], items: { type: 'string', minLength: 1, pattern: ROLE_OR_PREFIX.source } },
    rolePolicy: { type: 'object', default: {}, properties: { service: { type: 'string', minLength: 1, default: DEFAULT_TOKEN_ROLE_POLICY } } },
  },
};
