import 'mocha';
import { expect } from 'chai';
import { createHash } from 'crypto';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { AccessTokenGenerationProvider } from '../src/interfaces.js';
import { SecureRandomTokenProvider } from '../src/generator.js';

describe('SecureRandomTokenProvider', () => {
  const make = () => {
    const p = new SecureRandomTokenProvider();
    // @Config injected fields set by hand - no DI container needed
    Object.defineProperty(p, 'Prefix', { value: 'spt_', writable: true });
    Object.defineProperty(p, 'Length', { value: 32, writable: true });
    return p;
  };

  it('generates prefixed base64url token with matching sha256 hash', async () => {
    const p = make();
    const t = await p.generate();

    expect(t.Plaintext).to.match(/^spt_[A-Za-z0-9_-]{43}$/);
    expect(t.Hash).to.equal(createHash('sha256').update(t.Plaintext).digest('hex'));
  });

  it('generates unique tokens', async () => {
    const p = make();
    const a = await p.generate();
    const b = await p.generate();
    expect(a.Plaintext).to.not.equal(b.Plaintext);
  });

  it('hash() is deterministic and matches generate()', async () => {
    const p = make();
    const t = await p.generate();
    expect(p.hash(t.Plaintext)).to.equal(t.Hash);
    expect(p.hash(t.Plaintext)).to.equal(p.hash(t.Plaintext));
  });
});

/**
 * Configuration whose `rbac.token` block deliberately DIFFERS from the
 * `@Config` defaults baked into `SecureRandomTokenProvider`, so a token built
 * with the defaults cannot pass the assertion below.
 */
class TokenConfigTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      rbac: {
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'tst_',
          length: 16,
        },
      },
    };
  }
}

describe('SecureRandomTokenProvider config wiring', function () {
  this.timeout(15000);

  before(async () => {
    DI.setESMModuleSupport();

    // `ContainerRegistry.register` de-duplicates by type name and `resolve`
    // takes the LAST entry, so this registration would outlive the suite and
    // silently become THE configuration for every suite that runs after it -
    // see the note on `useTestConfiguration` in ./common.ts. It is removed
    // again in `after`.
    DI.unregister(TokenConfigTestConfiguration);
    DI.register(TokenConfigTestConfiguration).as(Configuration);

    // `@Config` reads through `DI.get(Configuration)`, which only sees an
    // ALREADY resolved instance - without this the getters fall back to their
    // defaults and the test would prove nothing.
    await DI.resolve(Configuration);
  });

  after(async () => {
    DI.unregister(TokenConfigTestConfiguration);
    DI.clearCache();
  });

  it('resolved through DI honours rbac.token.prefix / rbac.token.length', async () => {
    const provider = await DI.resolve(AccessTokenGenerationProvider);

    expect(provider).to.be.instanceOf(SecureRandomTokenProvider);

    const token = await provider.generate();

    // 16 random bytes base64url-encoded is 22 characters ( ceil(128 / 6) ),
    // against 43 for the default 32 bytes - so this fails if the configured
    // length is ignored.
    expect(token.Plaintext).to.match(/^tst_[A-Za-z0-9_-]{22}$/);
    expect(token.Hash).to.equal(createHash('sha256').update(token.Plaintext).digest('hex'));
  });
});
