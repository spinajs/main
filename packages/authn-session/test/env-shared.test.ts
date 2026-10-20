import 'mocha';
import { expect } from 'chai';
import type { Configuration } from '@spinajs/configuration-common';
import { AUTHN_PUBLIC_COOKIE_SECRET, authnAppEnv, isLenientAuthnEnv } from '@spinajs/authn/env';

import { PUBLIC_DEFAULT_COOKIE_SECRET, appEnvOf, sessionCookieOptions } from '../src/index.js';

const configOf = (appEnv: unknown, own?: string): Configuration => ({ Env: own, get: (path: string) => (path === 'process.env.APP_ENV' ? appEnv : undefined) }) as unknown as Configuration;

describe('authn-session shares the authn env helpers', () => {
  it('has one public cookie secret', () => {
    expect(PUBLIC_DEFAULT_COOKIE_SECRET).to.equal(AUTHN_PUBLIC_COOKIE_SECRET);
  });

  it('reads the app env as authn does', () => {
    for (const [env, own] of [['production', 'production'], ['development', 'development'], ['development', undefined], ['staging', 'staging'], [undefined, undefined]] as const) {
      expect(appEnvOf(configOf(env, own)), `${String(env)}/${String(own)}`).to.equal(authnAppEnv(configOf(env, own)));
    }
  });

  it('relaxes the cookie flags in exactly the envs where authn relaxes its secret checks', () => {
    for (const env of ['development', 'dev', 'test', 'production', 'prod', 'staging', 'qa', 'Development', 'TEST', '', undefined]) {
      expect(sessionCookieOptions({}, undefined, env).secure, String(env)).to.equal(!isLenientAuthnEnv(env));
    }
  });
});
