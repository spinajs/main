import 'mocha';
import { expect } from 'chai';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';

import { AUTHN_SESSION_CONFIGURATION_SCHEMA, AuthnSessionConfigBootstrapper } from '../src/index.js';
import { boot, disposeBooted, violationsOf } from './support/config-boot.js';
import { registeredSchemasAfter } from './support/registered-schemas.js';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA];
const bad = (session: Record<string, unknown>) => violationsOf(SCHEMAS, { authn: { session } });

describe('authn.session through the schemas', function () {
  this.timeout(30000);
  afterEach(disposeBooted);

  it('AuthnSessionConfigBootstrapper registers the authn.session fragment', () => {
    expect(AUTHN_SESSION_CONFIGURATION_SCHEMA.$configurationModule).to.eq('authn.session');
    expect(registeredSchemasAfter(() => new AuthnSessionConfigBootstrapper().bootstrap())).to.include(AUTHN_SESSION_CONFIGURATION_SCHEMA);
  });

  it('with no user config, the effective authn.session equals the defaults of the former single authn schema', async () => {
    const configuration = await boot(SCHEMAS, {});
    expect(configuration.get('authn.session')).to.deep.eq({
      expiration: { ttl: 30, maxLifetime: 480 },
      pendingTtlSeconds: 300,
      touchThresholdSeconds: 60,
      allowMemoryStore: false,
      cookie: { name: 'ssid', hostPrefix: 'auto', secure: 'auto', sameSite: 'strict' },
      hashIds: true,
    });
  });

  it('keeps a configured value and fills the rest', async () => {
    const configuration = await boot(SCHEMAS, { authn: { session: { expiration: { service: 'AbsoluteExpiration', ttl: 5 } } } });
    expect(configuration.get('authn.session.expiration')).to.deep.eq({ service: 'AbsoluteExpiration', ttl: 5, maxLifetime: 480 });
  });

  it('accepts the cookie values the cookie writers accept and keeps them as given', async () => {
    for (const cookie of [{ sameSite: true }, { sameSite: false }, { sameSite: 'Lax' }, { sameSite: 'STRICT' }, { sameSite: 'none' }, { secure: 'true' }, { secure: 'false' }, { hostPrefix: 'true' }, { secure: true, hostPrefix: false }]) {
      const configuration = await boot(SCHEMAS, { authn: { session: { cookie: { ...cookie } } } });
      expect(configuration.get('authn.session.cookie'), JSON.stringify(cookie)).to.deep.include(cookie);
    }
  });

  it('names the bad key', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ cookie: { sameSite: 'sometimes' } }, 'authn.session.cookie.sameSite'],
      [{ cookie: { sameSite: null } }, 'authn.session.cookie.sameSite'],
      [{ cookie: { sameSite: 1 } }, 'authn.session.cookie.sameSite'],
      [{ cookie: { secure: 'yes' } }, 'authn.session.cookie.secure'],
      [{ cookie: { secure: null } }, 'authn.session.cookie.secure'],
      [{ cookie: { hostPrefix: 'always' } }, 'authn.session.cookie.hostPrefix'],
      // Session ids are always stored hashed (SR-18).
      [{ hashIds: false }, 'authn.session.hashIds'],
      [{ hashIds: 'false' }, 'authn.session.hashIds'],
      [{ pendingTtlSeconds: 0 }, 'authn.session.pendingTtlSeconds'],
      [{ touchThresholdSeconds: -1 }, 'authn.session.touchThresholdSeconds'],
      [{ touchThresholdSeconds: 1.5 }, 'authn.session.touchThresholdSeconds'],
      [{ expiration: { ttl: 0 } }, 'authn.session.expiration.ttl'],
      [{ expiration: { maxLifetime: 0 } }, 'authn.session.expiration.maxLifetime'],
    ];
    for (const [session, path] of cases) expect(await bad(session), JSON.stringify(session)).to.include(path);
  });
});
