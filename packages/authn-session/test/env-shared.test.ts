import 'mocha';
import { expect } from 'chai';
import { isDevOrTestEnv } from '@spinajs/configuration-common';
import { AUTHN_PUBLIC_COOKIE_SECRET } from '@spinajs/authn/env';

import { PUBLIC_DEFAULT_COOKIE_SECRET, sessionCookieOptions } from '../src/index.js';

describe('authn-session shares the authn env helpers', () => {
  it('has one public cookie secret', () => {
    expect(PUBLIC_DEFAULT_COOKIE_SECRET).to.equal(AUTHN_PUBLIC_COOKIE_SECRET);
  });

  it('relaxes the cookie flags in exactly the envs where authn relaxes its secret checks', () => {
    for (const env of ['development', 'dev', 'test', 'production', 'prod', 'staging', 'qa', 'Development', 'TEST', '', undefined]) {
      expect(sessionCookieOptions({}, undefined, env).secure, String(env)).to.equal(!isDevOrTestEnv(env));
    }
  });
});
