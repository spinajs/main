import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { MemorySessionStore, SessionProvider } from '../src/index.js';
import { runSessionProviderConformance, IConformanceExpiration } from './conformance/session-provider-conformance.js';
import { TestConfiguration } from './common.test.js';

// Shared mutable expiration config the single registered Configuration reads.
let currentExpiration: IConformanceExpiration | object = {};

// Extends the common TestConfiguration (full db/logger config) so this suite
// does not strip shared-container config from sibling db suites — it only
// overrides rbac.session.expiration.
class ConformanceTestConfiguration extends TestConfiguration {
  protected onLoad() {
    const cfg = super.onLoad() as any;
    cfg.rbac.session = { service: 'MemorySessionStore', expiration: currentExpiration };
    return cfg;
  }
}

describe('MemorySessionStore', () => {
  before(() => {
    DI.register(ConformanceTestConfiguration).as(Configuration);
    DI.register(MemorySessionStore).as(SessionProvider);
  });

  runSessionProviderConformance(async (expiration: IConformanceExpiration) => {
    currentExpiration = expiration;
    DI.clearCache();
    await DI.resolve(Configuration);
    // Cast bridges the src<->lib SessionProvider class identity: the conformance
    // kit types against @spinajs/rbac (lib) while these tests run the src store.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await DI.resolve(MemorySessionStore)) as any;
  });
});
