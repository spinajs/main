import 'mocha';
import { expect } from 'chai';

import { basicAuthHeader, normalizeHeaders, parseBearer, parseCookieHeader } from '../src/index.js';

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
