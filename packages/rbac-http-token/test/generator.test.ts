import 'mocha';
import { expect } from 'chai';
import { createHash } from 'crypto';

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
