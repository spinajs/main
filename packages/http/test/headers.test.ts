import 'mocha';
import { expect } from 'chai';

import { basicAuthHeader, normalizeHeaders, parseBearer, parseCookieHeader, strictHeader } from '../src/index.js';

describe('strictHeader', () => {
  const once = (name: string, value: string) => ({ headers: { [name.toLowerCase()]: value }, rawHeaders: [name, value] });

  it('returns a header sent once, by a name in any case', () => {
    expect(strictHeader(once('X-Tenant', 'acme'), 'x-tenant', { maxLength: 16 })).to.eq('acme');
    expect(strictHeader(once('x-tenant', 'acme'), 'X-Tenant', { maxLength: 16 })).to.eq('acme');
    expect(strictHeader(once('X-Tenant', ''), 'x-tenant', { maxLength: 16 })).to.eq('');
  });

  it('returns undefined for an absent header and for an array', () => {
    expect(strictHeader({ headers: {}, rawHeaders: [] }, 'x-tenant', { maxLength: 16 })).to.eq(undefined);
    expect(strictHeader({ headers: { 'set-cookie': ['a=1'] }, rawHeaders: ['Set-Cookie', 'a=1'] }, 'set-cookie', { maxLength: 16 })).to.eq(undefined);
  });

  it('returns undefined for a header sent twice, whether Node joined the values or kept the first', () => {
    const joined = { headers: { 'x-tenant': 'acme, evil' }, rawHeaders: ['X-Tenant', 'acme', 'x-tenant', 'evil'] };
    const first = { headers: { authorization: 'Bearer a' }, rawHeaders: ['Authorization', 'Bearer a', 'AUTHORIZATION', 'Bearer b'] };

    expect(strictHeader(joined, 'x-tenant', { maxLength: 64 })).to.eq(undefined);
    expect(strictHeader(first, 'authorization', { maxLength: 64 })).to.eq(undefined);
  });

  it('reads a value the app set itself, and a request without rawHeaders', () => {
    expect(strictHeader({ headers: { range: 'bytes=0-' }, rawHeaders: ['Range', 'bytes=-99'] }, 'range', { maxLength: 16 })).to.eq('bytes=0-');
    expect(strictHeader({ headers: { range: 'bytes=0-' } }, 'range', { maxLength: 16 })).to.eq('bytes=0-');
  });

  it('returns undefined past maxLength', () => {
    expect(strictHeader(once('X-Tenant', 'a'.repeat(16)), 'x-tenant', { maxLength: 16 })).to.eq('a'.repeat(16));
    expect(strictHeader(once('X-Tenant', 'a'.repeat(17)), 'x-tenant', { maxLength: 16 })).to.eq(undefined);
  });

  it('returns the value only when the pattern matches all of it', () => {
    const tenant = /^[a-z]{1,16}$/;
    expect(strictHeader(once('X-Tenant', 'acme'), 'x-tenant', { maxLength: 16, pattern: tenant })).to.eq('acme');
    expect(strictHeader(once('X-Tenant', 'ac me'), 'x-tenant', { maxLength: 16, pattern: tenant })).to.eq(undefined);
    // Each side of an ungrouped alternation is anchored at one end only; `^(?:a|ab)$` is the form that works.
    expect(strictHeader(once('X-Mode', 'xb'), 'x-mode', { maxLength: 16, pattern: /^a|b$/ })).to.eq(undefined);
    expect(strictHeader(once('X-Mode', 'ab'), 'x-mode', { maxLength: 16, pattern: /^a|ab$/ })).to.eq(undefined);
  });

  it('throws for a pattern that is not anchored or keeps state, and for a bad maxLength', () => {
    for (const pattern of [/[a-z]+$/, /^[a-z]+/, /^[a-z]+\$/, /^[a-z]+$/g, /^[a-z]+$/y, /^[a-z]+$/m]) {
      expect(() => strictHeader(once('X-Tenant', 'acme'), 'x-tenant', { maxLength: 16, pattern }), String(pattern)).to.throw(TypeError);
    }
    for (const maxLength of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => strictHeader(once('X-Tenant', 'acme'), 'x-tenant', { maxLength }), String(maxLength)).to.throw(TypeError);
    }
  });
});

describe('parseBearer', () => {
  it('returns the b64token after the scheme, in any case and with any spacing', () => {
    expect(parseBearer('Bearer abc.DEF-_~+/123==')).to.eq('abc.DEF-_~+/123==');
    expect(parseBearer('bearer abc')).to.eq('abc');
    expect(parseBearer('BEARER    abc')).to.eq('abc');
    expect(parseBearer('  Bearer abc  ')).to.eq('abc');
  });

  it('returns null for anything else', () => {
    for (const header of [undefined, null, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearerabc', 'Bearer a b', 'Bearer a=b', 'Bearer abé', 'Bearer\tabc']) {
      expect(parseBearer(header), String(header)).to.eq(null);
    }
  });

  it('never matches a repeated header', () => {
    expect(parseBearer('Bearer a, Bearer b')).to.eq(null);
    expect(parseBearer(['Bearer a'])).to.eq(null);
  });
});

describe('parseCookieHeader', () => {
  it('reads name=value pairs', () => {
    expect({ ...parseCookieHeader('a=1; b=two;c = 3 ') }).to.deep.eq({ a: '1', b: 'two', c: '3' });
  });

  it('returns an empty map without a header', () => {
    expect({ ...parseCookieHeader(undefined) }).to.deep.eq({});
    expect({ ...parseCookieHeader('') }).to.deep.eq({});
  });

  it('skips pairs without = or without a name, and keeps the first of a repeated name', () => {
    expect({ ...parseCookieHeader('ssid; =x; a=1; a=2') }).to.deep.eq({ a: '1' });
  });

  it('drops quotes and URI-decodes, keeping a malformed escape raw', () => {
    expect({ ...parseCookieHeader('a="q v"; b=%20x; c=%E0%A4%A') }).to.deep.eq({ a: 'q v', b: ' x', c: '%E0%A4%A' });
  });

  it('keeps everything after the first =', () => {
    expect(parseCookieHeader('s=a=b')['s']).to.eq('a=b');
  });

  it('is safe against prototype keys', () => {
    const cookies = parseCookieHeader('__proto__=x; constructor=y');
    expect(cookies['__proto__']).to.eq('x');
    expect(cookies['constructor']).to.eq('y');
    expect(Object.getPrototypeOf(cookies)).to.eq(null);
  });
});

describe('normalizeHeaders', () => {
  it('lower-cases names and joins a repeated header with ", "', () => {
    const headers = normalizeHeaders({ rawHeaders: ['Authorization', 'Bearer a', 'Host', 'x', 'authorization', 'Bearer b'] });
    expect({ ...headers }).to.deep.eq({ authorization: 'Bearer a, Bearer b', host: 'x' });
  });

  it('ignores a dangling name and an absent rawHeaders', () => {
    expect({ ...normalizeHeaders({ rawHeaders: ['A', '1', 'B'] }) }).to.deep.eq({ a: '1' });
    expect({ ...normalizeHeaders({}) }).to.deep.eq({});
  });

  it('has no prototype', () => {
    expect(Object.getPrototypeOf(normalizeHeaders({ rawHeaders: [] }))).to.eq(null);
  });
});

describe('basicAuthHeader', () => {
  const decoded = (value: string) => Buffer.from(value.replace(/^Basic /, ''), 'base64').toString('utf8');

  it('encodes user:password as UTF-8 base64 (RFC 7617)', () => {
    expect(basicAuthHeader('Aladdin', 'open sesame')).to.eq('Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
    expect(decoded(basicAuthHeader('zażółć', 'p:ss'))).to.eq('zażółć:p:ss');
  });

  it('form-urlencodes both parts first with formEncode (RFC 6749 §2.3.1)', () => {
    expect(decoded(basicAuthHeader('my client', 'p:s&s/+', { formEncode: true }))).to.eq('my+client:p%3As%26s%2F%2B');
  });
});
