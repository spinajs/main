import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SNAPSHOT = resolve(process.cwd(), 'test', '__snapshots__', 'openapi.json');

/** Every operation of the 3.0 controllers by `<METHOD> <path>`, with the operationId 3.0.1 gave it. */
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
};

/** The request body schema each route that reads one declares. */
const BODIES: Record<string, string> = {
  AuthnLoginController_login: 'AuthnLoginBody',
  AuthnMfaController_verify: 'AuthnMfaVerifyBody',
  AuthnMfaController_recovery: 'AuthnMfaCodeBody',
  AuthnActiveRoleController_switch: 'AuthnActiveRoleBody',
  AuthnImpersonationController_start: 'AuthnImpersonationBody',
  AuthnPasswordController_requestReset: 'AuthnPasswordResetRequestBody',
  AuthnPasswordController_reset: 'AuthnPasswordResetBody',
  AuthnPasswordController_change: 'AuthnPasswordChangeBody',
  AuthnMfaEnrolmentController_begin: 'AuthnReauthBody',
  AuthnMfaEnrolmentController_confirm: 'AuthnMfaCodeBody',
  AuthnMfaEnrolmentController_disable: 'AuthnMfaDisableBody',
  AuthnMfaEnrolmentController_recoveryCodes: 'AuthnReauthBody',
  AuthnTokensController_create: 'AuthnTokenCreateBody',
  AuthnKeysController_register: 'AuthnKeyRegisterBody',
  AuthnKeysController_challenge: 'AuthnKeyChallengeBody',
  AuthnKeysController_login: 'AuthnKeyLoginBody',
  AuthnCredentialAdminController_passwordReset: 'AuthnPasswordResetAdminBody',
  AuthnCredentialAdminController_mfaReset: 'AuthnReauthBody',
  AuthnCredentialAdminController_sessions: 'AuthnReauthBody',
  AuthnCredentialAdminController_tokens: 'AuthnReauthBody',
};

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

  it('documents the JSON body of every route that reads one', () => {
    for (const [key, id] of Object.entries(OPERATIONS)) {
      const body = op(key).requestBody;
      if (BODIES[id] === undefined) {
        expect(body, id).to.eq(undefined);
        continue;
      }
      expect(body?.content?.['application/json']?.schema, id).to.deep.eq(ref(BODIES[id]));
      expect(spec.components.schemas[BODIES[id]], BODIES[id]).to.be.an('object');
    }
    expect(spec.components.schemas.AuthnLoginBody).to.deep.include({ required: ['login', 'password'] });
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
