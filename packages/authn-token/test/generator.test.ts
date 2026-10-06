import 'mocha';
import { expect } from 'chai';
import { createHash } from 'crypto';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { AccessTokenGenerationProvider } from '../src/generation.js';
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

  // An empty prefix or a length under 32 or not whole is refused by the authn schema (test/v3/config-schema.test.ts).
  it('refuses to mint without a configured format or over 1024 characters', async () => {
    const rows: Array<[unknown, unknown]> = [
      [undefined, 32],
      ['spt_', undefined],
      ['spt_', 16],
      ['spt_', 32.5],
      // 4 + 1023 characters: TokenStrategy would never accept it
      ['spt_', 767],
    ];

    for (const [prefix, length] of rows) {
      const p = make();
      Object.defineProperty(p, 'Prefix', { value: prefix, writable: true });
      Object.defineProperty(p, 'Length', { value: length, writable: true });
      const err = await p.generate().catch((e: unknown) => e);
      expect(err, `prefix ${String(prefix)}, length ${String(length)}`).to.be.instanceOf(Error);
      if (typeof prefix === 'string') {
        expect((err as Error).constructor).to.equal(Error);
        expect((err as Error).message).to.match(/authn\.token\.length|authn\.token\.prefix and/);
      }
    }
  });
});

/**
 * Configuration whose `authn.token.prefix` and `authn.token.length` differ
 * from the defaults (`spt_`, 32), so a token built with the defaults cannot
 * pass the assertion below.
 */
class TokenConfigTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      authn: {
        token: {
          generation: { service: 'SecureRandomTokenProvider' },
          prefix: 'tst_',
          length: 48,
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

  it('resolved through DI honours authn.token.prefix / authn.token.length', async () => {
    const provider = await DI.resolve(AccessTokenGenerationProvider);

    expect(provider).to.be.instanceOf(SecureRandomTokenProvider);

    const token = await provider.generate();

    // 48 random bytes base64url-encoded is 64 characters.
    expect(token.Plaintext).to.match(/^tst_[A-Za-z0-9_-]{64}$/);
    expect(token.Hash).to.equal(createHash('sha256').update(token.Plaintext).digest('hex'));
  });
});
