import { Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

type JsonSchema = Record<string, unknown>;

const text: JsonSchema = { type: 'string' };
const texts: JsonSchema = { type: 'array', items: text };
const instant: JsonSchema = { type: 'string', format: 'date-time' };
const nullableInstant: JsonSchema = { ...instant, nullable: true };
const ref: JsonSchema = { type: 'object', required: ['type', 'id'], properties: { type: text, id: text } };
const reauthPassword: JsonSchema = { ...text, description: 'the account password, when the session is not fresh' };
/** A named-type tag: http-swagger replaces it with a $ref to the component of that name. */
const named = (name: string): JsonSchema => ({ type: 'object', description: name });

function obj(required: readonly string[], properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return { type: 'object', ...(description ? { description } : {}), ...(required.length > 0 ? { required: [...required] } : {}), properties };
}

const authnFacts = obj(['method', 'strategy', 'assurance', 'mfa', 'authenticatedAt'], {
  method: text,
  strategy: text,
  assurance: { type: 'string', enum: ['aal1', 'aal2'] },
  mfa: texts,
  authenticatedAt: instant,
  impersonator: ref,
});

const principalProperties = {
  Identity: ref,
  Authn: { ...authnFacts, nullable: true },
  Access: { type: 'object', additionalProperties: true, description: "@spinajs/users: the principal's access summary (GET /user/access)" },
};

const tokenScope = obj([], {
  permissions: texts,
  resources: { type: 'array', items: obj(['type'], { type: text, id: text }) },
  agent: { type: 'boolean' },
});

/** Every request and answer schema of the 3.0 authn routes, by the type name their `@body`, `@returns` and `@response` tags use. */
export const AUTHN_HTTP_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  AuthnLoginBody: obj(['login', 'password'], { login: text, password: text }),
  AuthnMfaVerifyBody: obj(['code'], { code: text, step: { ...text, description: 'one of the pending steps; default the first' } }),
  AuthnMfaCodeBody: obj(['code'], { code: text }),
  AuthnActiveRoleBody: obj(['role'], { role: text, password: { ...text, description: 'when the role asks for a fresh password' } }),
  AuthnImpersonationBody: obj(['target'], { target: { oneOf: [{ ...text, description: 'a user id' }, ref] }, password: text }),
  AuthnPasswordResetRequestBody: obj(['login'], { login: text }),
  AuthnPasswordResetBody: obj(['login', 'secret', 'password'], { login: text, secret: text, password: text, confirmPassword: text }),
  AuthnPasswordChangeBody: obj(['oldPassword', 'password'], { oldPassword: text, password: text, confirmPassword: text }),
  AuthnReauthBody: obj([], { reauthPassword }),
  AuthnMfaDisableBody: obj(['code'], { code: { ...text, description: 'a TOTP code or a recovery code' }, reauthPassword }),
  AuthnTokenCreateBody: obj(['name', 'expiresAt'], {
    name: text,
    expiresAt: instant,
    roles: texts,
    profile: text,
    kind: { type: 'string', enum: ['pat', 'service', 'agent'] },
    scope: tokenScope,
    reauthPassword,
  }),
  AuthnPasswordResetAdminBody: obj([], { sendReset: { type: 'boolean', description: 'also mail the user a reset link' }, reauthPassword }),
  AuthnKeyChallengeBody: obj(['purpose'], { purpose: { type: 'string', enum: ['login', 'register'] }, kid: { ...text, description: 'the key to log in with (purpose login)' } }),
  AuthnKeyLoginBody: obj(['keyId', 'challengeId', 'signature'], { keyId: text, challengeId: text, signature: text }),
  AuthnKeyRegisterBody: obj(['jwk', 'proof'], {
    jwk: { type: 'object', additionalProperties: true, description: 'an Ed25519 (OKP) or P-256 (EC) public JWK' },
    proof: obj(['challengeId', 'signature'], { challengeId: text, signature: text }, 'the signature over a register challenge of this user'),
    kid: text,
    name: text,
    expiresAt: instant,
    scope: { type: 'object', additionalProperties: true },
    reauthPassword,
  }),

  AuthnPrincipalAnswer: { ...obj(['Identity', 'Authn'], principalProperties, 'The principal summary; AuthnResponseExtensions add fields'), additionalProperties: true },
  AuthnPendingAnswer: obj(['MfaRequired', 'MfaEnrol'], { MfaRequired: texts, MfaEnrol: { ...texts, description: 'the steps of MfaRequired to enrol (POST /user/mfa) before they can be verified' } }, 'A pending (pre-MFA) session'),
  AuthnLoginAnswer: { oneOf: [named('AuthnPrincipalAnswer'), named('AuthnPendingAnswer')] },
  AuthnRoleSwitchAnswer: { ...obj(['Identity', 'Authn', 'ActiveRole'], { ...principalProperties, ActiveRole: text }, 'The principal summary narrowed to the active role'), additionalProperties: true },
  AuthnActiveRoleState: obj(['ActiveRole', 'Roles'], {
    ActiveRole: { ...text, nullable: true, description: "null before any switch: every held role applies; '' for none" },
    Roles: { type: 'array', items: obj(['role', 'requirePassword'], { role: text, requirePassword: { type: 'boolean' } }) },
  }),
  AuthnImpersonationState: obj(['Active'], { Active: { type: 'boolean' }, Impersonator: ref, Target: ref, StartedAt: instant }),
  AuthnImpersonationAnswer: { oneOf: [named('AuthnPrincipalAnswer'), named('AuthnImpersonationState')] },
  AuthnSessionEntry: obj(['Handle', 'Created', 'LastSeen', 'Current'], { Handle: text, Created: instant, LastSeen: instant, Ip: text, UserAgent: text, Current: { type: 'boolean' } }),
  AuthnSessionsRevoked: obj(['Revoked'], { Revoked: { type: 'integer' } }),
  AuthnTokenEntry: obj(['Uuid', 'Name', 'Kind', 'Roles', 'Profile', 'Scope', 'CreatedAt', 'ExpiresAt', 'LastUsedAt', 'LastUsedIp', 'Expired'], {
    Uuid: text,
    Name: text,
    Kind: { type: 'string', enum: ['pat', 'service', 'agent'] },
    Roles: texts,
    Profile: { ...text, nullable: true },
    Scope: { ...tokenScope, nullable: true },
    CreatedAt: instant,
    ExpiresAt: instant,
    LastUsedAt: nullableInstant,
    LastUsedIp: { ...text, nullable: true },
    Expired: { type: 'boolean' },
  }),
  AuthnTokenCreated: obj(['Token', 'Plaintext'], { Token: named('AuthnTokenEntry'), Plaintext: { ...text, description: 'shown once' } }),
  AuthnMfaStatus: obj(['steps'], { steps: { type: 'array', items: obj(['name', 'enrolled'], { name: text, enrolled: { type: 'boolean' } }) } }),
  AuthnMfaProvisioning: obj(['provisioning'], { provisioning: { ...text, description: 'the otpauth:// URI, shown once' } }),
  AuthnRecoveryCodes: obj(['recoveryCodes'], { recoveryCodes: { ...texts, description: 'single use, shown once' } }),
  AuthnOk: obj(['Ok'], { Ok: { type: 'boolean', enum: [true] } }),
  AuthnPasswordResetAdminAnswer: obj(['expired', 'resetMailRequested'], { expired: { type: 'boolean' }, resetMailRequested: { type: 'boolean' } }),
  AuthnMfaResetAnswer: obj(['reset'], { reset: { type: 'boolean', description: 'an enrolment or a begun one existed' } }),
  AuthnRevokedCount: obj(['revoked'], { revoked: { type: 'integer' } }),
  AuthnPasswordPolicy: obj(['minLength', 'maxLength'], { minLength: { type: 'integer' }, maxLength: { type: 'integer' }, pattern: text, description: text }),
  AuthnKeyChallenge: obj(['id', 'nonce', 'expiresAt'], { id: text, nonce: text, expiresAt: instant }),
  AuthnKeyEntry: obj(['kid', 'name', 'alg', 'jwk', 'thumbprint', 'scope', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt', 'revoked', 'expired'], {
    kid: text,
    name: { ...text, nullable: true },
    alg: text,
    jwk: obj(['kty', 'crv', 'x'], { kty: text, crv: text, x: text, y: text }),
    thumbprint: text,
    scope: { type: 'object', additionalProperties: true, nullable: true },
    createdAt: instant,
    expiresAt: nullableInstant,
    lastUsedAt: nullableInstant,
    revokedAt: nullableInstant,
    revoked: { type: 'boolean' },
    expired: { type: 'boolean' },
  }),

  AuthnFailure: obj(['error', 'message'], { error: obj(['code', 'message'], { code: { type: 'string', enum: ['E_AUTH_FAILED'] }, message: text }), message: text }, 'The one body of a failed authentication (login, MFA, re-authentication)'),
  AuthnError: obj(['error', 'message'], { error: { ...text, description: 'a stable code: unauthenticated, session_required, fresh_auth_required, role_not_held, ...' }, message: text }, 'The body of a refused request'),
  AuthnUnauthorized: { oneOf: [named('AuthnFailure'), named('AuthnError')] },
};

/**
 * Serves AUTHN_HTTP_SCHEMAS to @spinajs/http-swagger by the type names of the controllers' JSDoc tags. Request
 * validation never asks a SchemaProvider: the routes read their bodies field by field.
 */
@Injectable(SchemaProvider)
export class AuthnHttpSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return Object.hasOwn(AUTHN_HTTP_SCHEMAS, typeName) ? AUTHN_HTTP_SCHEMAS[typeName] : undefined;
  }
}
