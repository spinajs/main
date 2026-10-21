import { bodyOf } from '@spinajs/authz';
import { Schema } from '@spinajs/validation';

import { policyBody, ruleBody } from '../schemas/commands.js';
import type { JsonSchema } from '../schemas/primitives.js';
import { AuthzAdminInput } from './input.js';

const withOptionalId = (body: JsonSchema): Record<string, JsonSchema> => {
  const properties = body.properties as Record<string, JsonSchema>;
  return { ...properties, id: { ...properties.id, description: 'optional; must equal the path id' } };
};

export const RULE_BODY_SCHEMA = { ...bodyOf(['kind', 'scope'], withOptionalId(ruleBody), 'authz.admin.AuthzRuleBody'), description: 'PUT /authz/rules/{id}: a rule; an `id` in the body must equal the path id' };

export const POLICY_BODY_SCHEMA = { ...bodyOf(['effect', 'permissions'], withOptionalId(policyBody), 'authz.admin.AuthzPolicyBody'), description: 'PUT /authz/policies/{id}: a policy; an `id` in the body must equal the path id' };

/** The body of PUT /authz/rules/:id: a RBAC rule, its fields as rule.put takes them. */
@Schema(RULE_BODY_SCHEMA)
export class AuthzRuleBody extends AuthzAdminInput {
  public id?: string;
  [field: string]: unknown;
}

/** The body of PUT /authz/policies/:id: an ABAC policy, its fields as policy.put takes them. */
@Schema(POLICY_BODY_SCHEMA)
export class AuthzPolicyBody extends AuthzAdminInput {
  public id?: string;
  [field: string]: unknown;
}
