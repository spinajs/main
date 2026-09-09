import { DI } from '@spinajs/di';

/**
 * Wire schema of `GET /auth/password/policy` — `IPasswordPolicy` from @spinajs/rbac.
 *
 * Registered under the interface's own name, the way @spinajs/rbac-http's
 * `dto/auth-responses.ts` registers `IGrantsMap` and friends: the controller's
 * `@returns {IPasswordPolicy}` resolves to nothing on its own (no schema provider
 * knows a TypeScript interface) and the published spec would describe the
 * response as an empty object, which a generated client then types as `object`.
 *
 * Every property is optional on purpose — a provider that cannot describe its
 * rule answers `{}` — so a client must render whatever subset is present.
 */
export const PasswordPolicySchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Password policy',
  type: 'object',
  properties: {
    minLength: { type: 'integer', minimum: 0, description: 'Fewest characters accepted' },
    maxLength: { type: 'integer', minimum: 0, description: 'Most characters accepted' },
    pattern: { type: 'string', description: 'ECMAScript regular expression source every accepted password matches' },
    description: { type: 'string', description: 'Human-readable statement of the rule, as configured by the application' },
  },
};

DI.register(PasswordPolicySchema).asMapValue('__schemas__', 'IPasswordPolicy');
