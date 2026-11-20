import 'mocha';
import { expect } from 'chai';

import { REDACTED, redactFields, redactUrl, sensitiveKeyMatcher, urlPath } from '../src/index.js';

const DEFAULT_KEYS = ['password', 'token', 'secret', 'authorization', 'cookie', 'card'];

describe('redaction helpers of the package root', () => {
  it('exports the url helpers and the key matcher', () => {
    expect(redactUrl('/a/b?token=x&page=2')).to.eq('/a/b?token=[redacted]&page=[redacted]');
    expect(urlPath('/a/b?token=x')).to.eq('/a/b');
    expect(sensitiveKeyMatcher(['token'])('refresh_token')).to.eq(true);
  });
});

describe('redactFields', () => {
  it('replaces the value of every key that contains a sensitive word, case-insensitively, at any depth', () => {
    const out = redactFields(
      {
        name: 'jo',
        Password: 'p',
        nested: { accessToken: 't', refresh_token: 'r', keep: 1, deeper: [{ clientSecret: 's', ok: true }] },
        creditCard: { number: '4111', expiry: '12/30' },
        'X-Authorization': 'Bearer x',
        list: [1, 'two', null],
      },
      DEFAULT_KEYS,
    );

    expect(out).to.deep.eq({
      name: 'jo',
      Password: REDACTED,
      nested: { accessToken: REDACTED, refresh_token: REDACTED, keep: 1, deeper: [{ clientSecret: REDACTED, ok: true }] },
      creditCard: REDACTED,
      'X-Authorization': REDACTED,
      list: [1, 'two', null],
    });
  });

  it('never changes its input', () => {
    const input = { password: 'p', inner: { token: 't' } };
    redactFields(input, DEFAULT_KEYS);
    expect(input).to.deep.eq({ password: 'p', inner: { token: 't' } });
  });

  it('marks a circular reference, keeps a shared one and stops at a depth limit', () => {
    const shared = { a: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic.self = cyclic;
    expect(redactFields(cyclic, DEFAULT_KEYS)).to.deep.eq({ shared: { a: 1 }, again: { a: 1 }, self: '[circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(JSON.stringify(redactFields(deep, DEFAULT_KEYS))).to.contain('[too deep]');
  });

  it('keeps a __proto__ key as an own property instead of setting the prototype', () => {
    const out = redactFields(JSON.parse('{"__proto__":{"token":"t","x":1}}'), DEFAULT_KEYS) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).to.eq(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).to.deep.eq({ token: REDACTED, x: 1 });
  });

  it('writes binary data as a marker', () => {
    expect(redactFields({ file: Buffer.from('abc') }, DEFAULT_KEYS)).to.deep.eq({ file: '[binary]' });
  });
});
