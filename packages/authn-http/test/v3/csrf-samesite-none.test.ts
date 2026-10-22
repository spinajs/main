import 'mocha';
import { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chai from 'chai';
import { InvalidOption } from '@spinajs/exceptions';
import { HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '@spinajs/authn-session';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA, CsrfOriginGuard, assertSameSiteNoneProtected } from '../../src/index.js';
import { boot, disposeBooted, readingFrom } from '../support/config-boot.js';

chai.use(chaiAsPromised);

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];
const PARTNER = 'https://partner.example.org';

describe('SameSite=None boot guard (X4)', () => {
  describe('assertSameSiteNoneProtected', () => {
    const check = (sameSite: 'strict' | 'lax' | 'none' | false, csrfEnabled: boolean, allowed: readonly string[], env: string | undefined) => () =>
      assertSameSiteNoneProtected({ sameSite, csrfEnabled, allowedOrigins: new Set(allowed), env });

    for (const env of ['production', 'staging', 'qa-eu-1', undefined]) {
      it(`${String(env)}: refuses SameSite=None with the guard off or without allowed origins`, () => {
        expect(check('none', false, [PARTNER], env)).to.throw(InvalidOption, 'authn.session.cookie.sameSite');
        expect(check('none', true, [], env)).to.throw(InvalidOption, 'http.csrf.allowedOrigins');
        expect(check('none', false, [], env)).to.throw(InvalidOption);
      });

      it(`${String(env)}: accepts SameSite=None with the guard on and an allowed origin, and any other SameSite`, () => {
        expect(check('none', true, [PARTNER], env)).to.not.throw();
        for (const sameSite of ['strict', 'lax', false] as const) {
          for (const enabled of [true, false]) expect(check(sameSite, enabled, [], env), `${String(sameSite)} ${String(enabled)}`).to.not.throw();
        }
      });
    }

    for (const env of ['development', 'dev', 'test']) {
      it(`${env}: lets every combination boot`, () => {
        for (const enabled of [true, false]) for (const allowed of [[], [PARTNER]]) expect(check('none', enabled, allowed, env)).to.not.throw();
      });
    }
  });

  describe('CsrfOriginGuard.resolve()', function () {
    this.timeout(20000);
    afterEach(disposeBooted);

    async function resolved(values: Record<string, unknown>, env: string) {
      const { child, configuration } = await boot(SCHEMAS, values, env);
      const guard = readingFrom(new CsrfOriginGuard(), child);
      Object.defineProperty(guard, 'Configuration', { value: configuration });
      Object.defineProperty(guard, 'Log', { value: { warn: () => undefined } });
      return guard.resolve();
    }

    const none = { authn: { session: { cookie: { sameSite: 'None' } } } };

    it('fails the production boot for SameSite=None without allowed origins, naming the keys', async () => {
      await expect(resolved(none, 'production')).to.be.rejectedWith(InvalidOption, 'http.csrf.allowedOrigins');
    });

    it('fails the production boot for SameSite=None with the guard off, through either key', async () => {
      await expect(resolved({ ...none, http: { csrf: { enabled: false, allowedOrigins: [PARTNER] } } }, 'production')).to.be.rejectedWith(InvalidOption);
      await expect(resolved({ authn: { ...none.authn, http: { csrf: { enabled: false } } }, http: { csrf: { allowedOrigins: [PARTNER] } } }, 'production')).to.be.rejectedWith(InvalidOption);
    });

    it('boots with SameSite=None and an allowed origin from http.csrf or the deprecated key', async () => {
      await resolved({ ...none, http: { csrf: { allowedOrigins: [PARTNER] } } }, 'production');
      await resolved({ authn: { ...none.authn, http: { csrf: { allowedOrigins: [PARTNER] } } } }, 'production');
    });

    it('boots with the default SameSite, and in development and test whatever the setting', async () => {
      await resolved({ http: { csrf: { enabled: false } } }, 'production');
      await resolved({ ...none, http: { csrf: { enabled: false } } }, 'test');
      await resolved(none, 'development');
    });
  });
});
