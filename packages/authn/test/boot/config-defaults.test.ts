import * as chai from 'chai';
import 'mocha';
import { createRequire } from 'node:module';
import { DI } from '@spinajs/di';
import { Configuration, InvalidConfiguration } from '@spinajs/configuration';

import shipped from '../../src/config/authn.js';
import { AUTHN_CONFIGURATION_SCHEMA, AuthnConfigBootstrapper, DEFAULT_THROTTLE_MAX_ROWS, DEFAULT_THROTTLE_PARAMS } from '../../src/index.js';
import { configuredChild, configurationOf, violationPaths } from '../behaviour/harness.js';

const expect = chai.expect;
const require = createRequire(import.meta.url);

type Json = Record<string, any>;

// The app validator's options (packages/configuration/src/configuration.ts initValidator).
function appAjv(): any {
  const Ajv = require('ajv');
  const ajv = new (Ajv.default ?? Ajv)({ logger: false, allErrors: true, removeAdditional: true, useDefaults: true, coerceTypes: true, $data: true });
  (require('ajv-merge-patch').default ?? require('ajv-merge-patch'))(ajv);
  (require('ajv-formats').default ?? require('ajv-formats'))(ajv);
  (require('ajv-keywords').default ?? require('ajv-keywords'))(ajv);
  ajv.addKeyword('$configurationModule');
  return ajv;
}

const ajv = appAjv();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function check(config: Json): { ok: boolean; paths: string[]; config: Json } {
  const c = clone(config);
  const ok = ajv.validate(AUTHN_CONFIGURATION_SCHEMA, c) as boolean;
  return { ok, paths: ok ? [] : (ajv.errors as { instancePath: string }[]).map((e) => e.instancePath), config: c };
}

const BACKOFF = { free: 5, baseDelayMs: 1000, maxDelayMs: 60000 };

describe('authn shipped config', () => {
  const authn = (shipped as Json).authn as Json;

  it('ships only the keys whose 3.0 shape authn owns', () => {
    expect(Object.keys(shipped)).to.deep.eq(['authn']);
    expect(Object.keys(authn).sort()).to.deep.eq(['audit', 'config', 'freshAuth', 'impersonation', 'linking', 'mfa', 'strategies', 'throttle']);
    expect(Object.keys(authn.mfa)).to.deep.eq(['policy']);
  });

  it('lists no strategy: config arrays concatenate, so the app lists each one itself', () => {
    expect(authn.strategies).to.deep.eq([]);
  });

  it('names no throttle service: the core picks the one besides MemoryAuthnThrottle when unset (K6)', () => {
    expect(authn.throttle).to.not.have.property('service');
  });

  it('keeps the throttle block equal to the schema defaults, maxRows aside', () => {
    const { maxRows, ...limits } = check({}).config.throttle;
    expect(maxRows).to.eq(DEFAULT_THROTTLE_MAX_ROWS);
    expect(authn.throttle).to.deep.eq(limits);
    expect(limits).to.deep.eq(clone(DEFAULT_THROTTLE_PARAMS));
  });

  it('keeps the other values equal to the code defaults', () => {
    expect(authn.freshAuth).to.deep.eq(check({}).config.freshAuth);
    expect(check({}).config.freshAuth).to.deep.eq({ maxAgeSeconds: 300 });
    expect(authn.audit).to.deep.eq({ sinks: ['LogAuthnAuditSink'], ...check({}).config.audit });
    expect(authn.impersonation).to.deep.eq({ requirePassword: true, requireMfa: true, maxMinutes: 60 });
    expect(authn.linking).to.deep.eq({ jit: false, byVerifiedEmail: false });
    expect(authn.mfa.policy).to.deep.eq({ service: 'DefaultMfaPolicy', force: false, forceForRoles: [] });
    expect(authn.config).to.deep.eq({ rejectLegacyKeys: false });
  });

  it('passes the schema unchanged', () => {
    const r = check(authn);
    expect(r.paths).to.deep.eq([]);
    expect(r.config).to.deep.eq({ ...clone(authn), mfa: { ...clone(authn.mfa), steps: [], totp: check({}).config.mfa.totp }, throttle: { ...clone(authn.throttle), maxRows: DEFAULT_THROTTLE_MAX_ROWS }, token: check({}).config.token, jwt: { issuers: [] }, keys: check({}).config.keys });
  });
});

describe('authn schema (task 8 edits)', () => {
  it('takes previous peppers as { secret, version } with distinct versions (D9)', () => {
    expect(check({ local: { pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 1 }] } } }).ok).to.eq(true);
    expect(check({ local: { pepper: { secret: null, version: 1, previous: [] } } }).ok).to.eq(true);
    expect(check({ local: { pepper: { secret: 'x', version: 3, previous: [{ secret: 'y', version: 1 }, { secret: 'z', version: 1 }] } } }).paths).to.include('/local/pepper/previous');
    expect(check({ local: { pepper: { secret: 'x', previous: [{ secret: '', version: 1 }] } } }).paths).to.include('/local/pepper/previous/0/secret');
    expect(check({ local: { pepper: { secret: 'x', previous: [{ secret: 'y' }] } } }).paths).to.include('/local/pepper/previous/0');
    expect(check({ local: { pepper: { secret: 'x', previous: [{ secret: 'y', version: 0 }] } } }).paths).to.include('/local/pepper/previous/0/version');
  });

  it('caps the pepper version and refuses a previous version equal to the current one, implicit 1 included', () => {
    expect(check({ local: { pepper: { secret: 'x', version: 999999999 } } }).ok).to.eq(true);
    expect(check({ local: { pepper: { secret: 'x', version: 1000000000 } } }).paths).to.include('/local/pepper/version');
    expect(check({ local: { pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 1000000000 }] } } }).paths).to.include('/local/pepper/previous/0/version');
    expect(check({ local: { pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 2 }] } } }).paths).to.include('/local/pepper/previous/0/version');
    expect(check({ local: { pepper: { secret: 'x', previous: [{ secret: 'y', version: 1 }] } } }).paths).to.include('/local/pepper/previous/0/version');
    expect(check({ local: { pepper: { secret: 'x', version: 3, previous: [{ secret: 'y', version: 2 }, { secret: 'z', version: 1 }] } } }).ok).to.eq(true);
  });

  it('gives authn.config its default', () => {
    expect(check({}).config.config).to.deep.eq({ rejectLegacyKeys: false });
  });

  it('names the pepper and MFA key paths in full on a boot', async () => {
    const paths = await violationPaths(configuredChild({ authn: { local: { pepper: { secret: 'x', version: 2, previous: [{ secret: 'y', version: 2 }] } }, mfa: { encryptionKey: { secret: {} } } } }));
    expect(paths).to.include('authn.local.pepper.previous.0.version');
    expect(paths).to.include('authn.mfa.encryptionKey.secret');
  });

  it('takes maxRows per throttle flow, 4 to 16,000,000, 1,000,000 by default', () => {
    expect(check({ throttle: { maxRows: 5000 } }).ok).to.eq(true);
    expect(check({}).config.throttle.maxRows).to.eq(1_000_000);
    for (const bad of [3, 16_000_001, 1.5]) expect(check({ throttle: { maxRows: bad } }).paths, String(bad)).to.include('/throttle/maxRows');
  });

  it('documents that the global key counts per flow', () => {
    expect(AUTHN_CONFIGURATION_SCHEMA.properties.throttle.properties.global.description).to.match(/per flow/);
  });

  it('takes the audit hash key and sink timeout, and no other audit key', () => {
    expect(check({ audit: { hashKey: { secret: 'h'.repeat(32) }, sinkTimeoutMs: 2000 } }).ok).to.eq(true);
    expect(check({ audit: { hashKey: { secret: null } } }).ok).to.eq(true);
    expect(check({ audit: { hashKey: { secret: 'h'.repeat(31) } } }).paths).to.include('/audit/hashKey/secret');
    for (const bad of [0, 60001, 1.5]) expect(check({ audit: { sinkTimeoutMs: bad } }).paths, String(bad)).to.include('/audit/sinkTimeoutMs');
    expect(check({ audit: { disabled: ['LogAuthnAuditSink'] } }).paths).to.include('/audit');
    expect(check({ audit: {} }).config.audit).to.deep.eq({ sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000 });
    expect(check({}).config.audit, 'an unset authn.audit').to.deep.eq({ sampleUse: 0.01, hashIdentifiers: true, sinkTimeoutMs: 2000 });
  });

  it('refuses a backoff key missing a field, as the throttle reader does', () => {
    expect(check({ throttle: { login: { account: { free: 2 } } } }).paths).to.include('/throttle/login/account');
    expect(check({ throttle: { login: { account: BACKOFF } } }).ok).to.eq(true);
  });

  it('accepts the session lifetime the impersonation service reads (minutes)', () => {
    expect(check({ session: { expiration: { maxLifetime: 480 } } }).ok).to.eq(true);
    expect(check({ session: { expiration: { maxLifetime: 0 } } }).paths).to.include('/session/expiration/maxLifetime');
  });

  // Decision (task 1 hand-off): JSON Schema cannot tie a name to one service across items, and F6's contract pins
  // the refusal of a repeated name. Packages ship no entries, so a repeat comes from the app's own files.
  it('refuses a repeated strategy or step name, identical entries included', () => {
    const local = { name: 'local', service: 'LocalPasswordStrategy' };
    expect(check({ strategies: [local, { ...local }] }).paths).to.include('/strategies');
    const totp = { name: 'totp', service: 'TotpMfaStep' };
    expect(check({ mfa: { steps: [totp, { ...totp }] } }).paths).to.include('/mfa/steps');
  });
});

describe('AuthnConfigBootstrapper', () => {
  const schemas = (): unknown[] => (DI.get(Array.ofType('__configurationSchema__' as never)) as unknown[] | null) ?? [];
  let saved: unknown[] = [];

  beforeEach(() => {
    saved = [...schemas()];
  });

  afterEach(() => {
    DI.uncache('__configurationSchema__' as never);
    for (const other of saved) DI.register(other as never).asValue('__configurationSchema__');
  });

  it('registers the authn schema under __configurationSchema__', () => {
    new AuthnConfigBootstrapper().bootstrap();
    expect(schemas()).to.include(AUTHN_CONFIGURATION_SCHEMA);
  });

  describe('with the package configs of the workspace', function () {
    // Loading every package config takes seconds.
    this.timeout(60000);
    const children: { dispose(): Promise<void> }[] = [];
    let setEsm = false;

    // The file sources load package configs only in ESM mode here (lib/mjs); the rest of the suite runs without it.
    before(() => {
      setEsm = !DI.get('__esmMode__' as never);
      if (setEsm) DI.setESMModuleSupport();
    });

    after(() => {
      if (setEsm) DI.uncache('__esmMode__' as never);
    });

    afterEach(async () => {
      for (const c of children.splice(0)) await c.dispose();
    });

    async function boot(values: Json): Promise<Configuration> {
      const child = DI.RootContainer.child();
      children.push(child);
      child.register(AUTHN_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
      child.register(configurationOf(values, 'production')).as(Configuration);
      return child.resolve(Configuration);
    }

    it('validates the merged 2.x interim shapes and the shipped defaults without an error', async () => {
      const c = await boot({});
      expect(c.get('authn.throttle.login.account')).to.deep.eq(BACKOFF);
      expect(c.get('authn.audit.sinks')).to.include('LogAuthnAuditSink');
      expect(c.get('authn.session.hashIds')).to.eq(true);
    });

    it('fails the boot of a config the schema refuses', async () => {
      let error: unknown;
      try {
        await boot({ authn: { session: { hashIds: false } } });
      } catch (e) {
        error = e;
      }
      expect(error, 'boot refused').to.be.instanceOf(InvalidConfiguration);
      expect(((error as InvalidConfiguration).validationExceptions ?? []).map((e) => e.instancePath)).to.include('/session/hashIds');
    });
  });
});
