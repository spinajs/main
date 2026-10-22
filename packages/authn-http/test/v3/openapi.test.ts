/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- the assertions read untyped JSON answers */
import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SYMBOL } from '@spinajs/validation';

import { AuthnActiveRoleBody } from '../../src/dto/active-role.js';
import { AuthnCodeLoginBody, AuthnCodeRequestBody } from '../../src/dto/code-login.js';
import { AuthnAdminPasswordResetBody } from '../../src/dto/credential-admin.js';
import { AuthnImpersonationBody } from '../../src/dto/impersonation.js';
import { AuthnKeyChallengeBody, AuthnKeyLoginBody, AuthnKeyRegisterBody } from '../../src/dto/keys.js';
import { AuthnLoginBody } from '../../src/dto/login.js';
import { AuthnMfaChallengeBody, AuthnMfaCodeBody, AuthnMfaStepUpBody, AuthnMfaVerifyBody } from '../../src/dto/mfa.js';
import { AuthnMfaDisableBody } from '../../src/dto/mfa-enrolment.js';
import { AuthnPasskeyLoginBody, AuthnPasskeyRegisterBody } from '../../src/dto/passkeys.js';
import { AuthnPasswordChangeBody, AuthnPasswordResetBody, AuthnPasswordResetRequestBody } from '../../src/dto/password.js';
import { AuthnReauthBody, AuthnReauthPasswordBody } from '../../src/dto/reauth.js';
import { AuthnRegistrationBody } from '../../src/dto/registration.js';
import { AuthnTokenCreateBody, AuthnTokenRevokeBody, AuthnTokenRotateBody, AuthnTokenUpdateBody } from '../../src/dto/tokens.js';
import { AuthnVerifyBody } from '../../src/dto/verification.js';

const SNAPSHOT = resolve(process.cwd(), 'test', '__snapshots__', 'openapi.json');

/** Every operation of the 3.0 controllers by `<METHOD> <path>`, with the operationId 3.0.1 to 3.0.4 gave it. */
const OPERATIONS: Record<string, string> = {
  'post /auth/login': 'AuthnLoginController_login',
  'post /auth/logout': 'AuthnLoginController_logout',
  'get /auth': 'AuthnLoginController_whoami',
  'post /auth/mfa/verify': 'AuthnMfaController_verify',
  'post /auth/mfa/recovery': 'AuthnMfaController_recovery',
  'get /auth/active-role': 'AuthnActiveRoleController_state',
  'post /auth/active-role': 'AuthnActiveRoleController_switch',
  'get /auth/impersonate': 'AuthnImpersonationController_state',
  'post /auth/impersonate': 'AuthnImpersonationController_start',
  'delete /auth/impersonate': 'AuthnImpersonationController_stop',
  'get /auth/password/policy': 'AuthnPasswordController_policy',
  'post /auth/password/reset-request': 'AuthnPasswordController_requestReset',
  'post /auth/password/reset': 'AuthnPasswordController_reset',
  'patch /user/password': 'AuthnPasswordController_change',
  'get /user/mfa': 'AuthnMfaEnrolmentController_status',
  'post /user/mfa': 'AuthnMfaEnrolmentController_begin',
  'post /user/mfa/confirm': 'AuthnMfaEnrolmentController_confirm',
  'post /user/mfa/disable': 'AuthnMfaEnrolmentController_disable',
  'post /user/mfa/recovery-codes': 'AuthnMfaEnrolmentController_recoveryCodes',
  'get /user/sessions': 'AuthnSessionsController_list',
  'delete /user/sessions/{handle}': 'AuthnSessionsController_revoke',
  'delete /user/sessions': 'AuthnSessionsController_revokeOthers',
  'get /user/tokens': 'AuthnTokensController_list',
  'post /user/tokens': 'AuthnTokensController_create',
  'delete /user/tokens/{uuid}': 'AuthnTokensController_revoke',
  'get /user/keys': 'AuthnKeysController_list',
  'post /user/keys': 'AuthnKeysController_register',
  'delete /user/keys/{kid}': 'AuthnKeysController_revoke',
  'post /auth/keys/challenge': 'AuthnKeysController_challenge',
  'post /auth/keys/login': 'AuthnKeysController_login',
  'post /authn/admin/users/{uuid}/password-reset': 'AuthnCredentialAdminController_passwordReset',
  'post /authn/admin/users/{uuid}/mfa-reset': 'AuthnCredentialAdminController_mfaReset',
  'delete /authn/admin/users/{uuid}/sessions': 'AuthnCredentialAdminController_sessions',
  'delete /authn/admin/users/{uuid}/tokens': 'AuthnCredentialAdminController_tokens',
  'post /auth/code/request': 'AuthnCodeLoginController_request',
  'post /auth/code/login': 'AuthnCodeLoginController_login',
  'post /auth/reauth': 'AuthnReauthController_reauth',
  'post /auth/register': 'AuthnRegistrationController_register',
  'post /auth/verify/request': 'AuthnVerificationController_request',
  'post /auth/verify': 'AuthnVerificationController_verify',
  'post /auth/mfa/step-up': 'AuthnMfaController_stepUp',
  'post /auth/mfa/challenge': 'AuthnMfaController_challenge',
  'post /user/tokens/{uuid}/rotate': 'AuthnTokensController_rotate',
  'patch /user/tokens/{uuid}': 'AuthnTokensController_update',
  'post /auth/tokens/revoke': 'AuthnTokenRevocationController_revoke',
  'post /auth/passkeys/challenge': 'AuthnPasskeyController_challenge',
  'post /auth/passkeys/login': 'AuthnPasskeyController_login',
  'post /user/passkeys/options': 'AuthnPasskeyController_options',
  'post /user/passkeys': 'AuthnPasskeyController_register',
  'get /user/passkeys': 'AuthnPasskeyController_list',
  'delete /user/passkeys/{id}': 'AuthnPasskeyController_remove',
};

/** The DTO each route that reads a body takes; http-swagger documents its `@Schema` as the request body. */
const BODIES: Record<string, abstract new (...args: never[]) => object> = {
  AuthnLoginController_login: AuthnLoginBody,
  AuthnCodeLoginController_request: AuthnCodeRequestBody,
  AuthnCodeLoginController_login: AuthnCodeLoginBody,
  AuthnReauthController_reauth: AuthnReauthBody,
  AuthnRegistrationController_register: AuthnRegistrationBody,
  AuthnVerificationController_verify: AuthnVerifyBody,
  AuthnMfaController_verify: AuthnMfaVerifyBody,
  AuthnMfaController_recovery: AuthnMfaCodeBody,
  AuthnMfaController_stepUp: AuthnMfaStepUpBody,
  AuthnMfaController_challenge: AuthnMfaChallengeBody,
  AuthnActiveRoleController_switch: AuthnActiveRoleBody,
  AuthnImpersonationController_start: AuthnImpersonationBody,
  AuthnPasswordController_requestReset: AuthnPasswordResetRequestBody,
  AuthnPasswordController_reset: AuthnPasswordResetBody,
  AuthnPasswordController_change: AuthnPasswordChangeBody,
  AuthnMfaEnrolmentController_begin: AuthnReauthPasswordBody,
  AuthnMfaEnrolmentController_confirm: AuthnMfaCodeBody,
  AuthnMfaEnrolmentController_disable: AuthnMfaDisableBody,
  AuthnMfaEnrolmentController_recoveryCodes: AuthnReauthPasswordBody,
  AuthnTokensController_create: AuthnTokenCreateBody,
  AuthnTokensController_rotate: AuthnTokenRotateBody,
  AuthnTokensController_update: AuthnTokenUpdateBody,
  AuthnTokenRevocationController_revoke: AuthnTokenRevokeBody,
  AuthnKeysController_register: AuthnKeyRegisterBody,
  AuthnKeysController_challenge: AuthnKeyChallengeBody,
  AuthnKeysController_login: AuthnKeyLoginBody,
  AuthnPasskeyController_login: AuthnPasskeyLoginBody,
  AuthnPasskeyController_options: AuthnReauthPasswordBody,
  AuthnPasskeyController_register: AuthnPasskeyRegisterBody,
  AuthnCredentialAdminController_passwordReset: AuthnAdminPasswordResetBody,
  AuthnCredentialAdminController_mfaReset: AuthnReauthPasswordBody,
  AuthnCredentialAdminController_sessions: AuthnReauthPasswordBody,
  AuthnCredentialAdminController_tokens: AuthnReauthPasswordBody,
};

// The keywords http-swagger carries from a JSON schema into the document (its convertJsonSchema), `const` as a one-value enum.
const KEPT = ['type', 'format', 'description', 'enum', 'required', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'nullable'];

/** `schema` as http-swagger documents it. */
function documented(schema: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of KEPT) if (schema[k] !== undefined && schema[k] !== null && schema[k] !== false && schema[k] !== '') out[k] = schema[k];
  if (schema.items) out.items = documented(schema.items);
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, documented(v as Record<string, any>)]));
  if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
  else if (schema.additionalProperties) out.additionalProperties = documented(schema.additionalProperties);
  for (const k of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(schema[k])) out[k] = schema[k].map((x: Record<string, any>) => documented(x));
  if (schema.const !== undefined) {
    out.enum = [schema.const];
    out.type ??= typeof schema.const;
  }
  if (!out.type && Array.isArray(out.enum) && out.enum.length > 0) out.type = typeof out.enum[0];
  return out;
}

const dtoSchemaOf = (dto: abstract new (...args: never[]) => object): Record<string, any> => Reflect.getMetadata(SCHEMA_SYMBOL, dto.prototype) as Record<string, any>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

interface Operation {
  operationId?: string;
  requestBody?: { content?: Record<string, { schema?: unknown } | undefined> };
  responses: Record<string, { content: Record<string, { schema: unknown }> }>;
}

interface Schema {
  required: unknown;
  oneOf: unknown;
  properties: Record<string, unknown>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}

/**
 * The OpenAPI document @spinajs/http-swagger builds for the 3.0 controllers, from test/openapi-probe.ts in a
 * process of its own. Rewrite the snapshot with `UPDATE_SNAPSHOTS=1`.
 */
describe('OpenAPI document of the 3.0 authn routes', function () {
  this.timeout(180000);

  let spec: OpenApiDocument;
  const op = (key: string) => {
    const [method, path] = key.split(' ');
    return spec.paths[path]?.[method];
  };

  before(() => {
    const probe = resolve(process.cwd(), 'test', 'openapi-probe.ts');
    const run = spawnSync(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json') },
    });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${run.status}):\n${run.stdout.slice(-4000)}\n${run.stderr.slice(-4000)}`);
    spec = JSON.parse(match[1]);
  });

  it('keeps the operationId <Controller>_<method> of every route', () => {
    for (const [key, id] of Object.entries(OPERATIONS)) expect(op(key)?.operationId, key).to.eq(id);
  });

  it('documents the body of every route that reads one as its DTO schema, and no body elsewhere', () => {
    for (const [key, id] of Object.entries(OPERATIONS)) {
      const body = op(key).requestBody;
      if (BODIES[id] === undefined) {
        expect(body, id).to.eq(undefined);
        continue;
      }
      expect(body?.content?.['application/json']?.schema, id).to.deep.eq(documented(dtoSchemaOf(BODIES[id])));
    }
    expect(op('post /auth/login').requestBody?.content?.['application/json']?.schema).to.deep.include({ required: ['login', 'password'], additionalProperties: false });
  });

  it('keeps answer and error schemas only: no request body schema is a component any more', () => {
    const bodies = Object.keys(spec.components.schemas as object).filter((name) => /^Authn\w*Body$/.test(name));
    expect(bodies).to.deep.eq([]);
  });

  it('no handler of authn-http names its body in a @body tag', () => {
    const dir = resolve(process.cwd(), 'src', 'v3', 'controllers');
    for (const file of readdirSync(dir)) expect(readFileSync(resolve(dir, file), 'utf8'), file).to.not.match(/@body\b/);
  });

  it('types the login answer as the principal summary or the pending answer', () => {
    expect(op('post /auth/login').responses['200'].content['application/json'].schema).to.deep.eq(ref('AuthnLoginAnswer'));
    expect(spec.components.schemas.AuthnLoginAnswer.oneOf).to.deep.eq([ref('AuthnPrincipalAnswer'), ref('AuthnPendingAnswer')]);
    expect(spec.components.schemas.AuthnPendingAnswer.required).to.deep.eq(['MfaRequired', 'MfaEnrol']);
    expect(spec.components.schemas.AuthnPrincipalAnswer).to.deep.include({ additionalProperties: true });
    expect(op('get /auth/active-role').responses['200'].content['application/json'].schema).to.deep.eq(ref('AuthnActiveRoleState'));
    expect(op('get /user/sessions').responses['200'].content['application/json'].schema).to.deep.eq({ type: 'array', items: ref('AuthnSessionEntry') });
    expect(spec.components.schemas.AuthnTokenCreated.properties.Token).to.deep.eq(ref('AuthnTokenEntry'));
  });

  it('types the error bodies', () => {
    expect(op('post /auth/login').responses['401'].content['application/json'].schema).to.deep.eq(ref('AuthnFailure'));
    expect(op('post /auth/active-role').responses['403'].content['application/json'].schema).to.deep.eq(ref('AuthnError'));
    expect(spec.components.schemas.AuthnUnauthorized.oneOf).to.deep.eq([ref('AuthnFailure'), ref('AuthnError')]);
  });

  it('matches the committed snapshot', () => {
    const ids = new Set(Object.values(OPERATIONS));
    const paths: Record<string, Record<string, unknown>> = {};
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (ids.has(operation.operationId ?? '')) (paths[path] ??= {})[method] = operation;
      }
    }
    const schemas = Object.fromEntries(Object.entries(spec.components.schemas).filter(([name]) => name.startsWith('Authn')));
    const actual = { paths, schemas };
    if (process.env.UPDATE_SNAPSHOTS) {
      mkdirSync(dirname(SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(SNAPSHOT), 'snapshot file is missing; run with UPDATE_SNAPSHOTS=1').to.eq(true);
    expect(actual).to.deep.eq(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  });
});
