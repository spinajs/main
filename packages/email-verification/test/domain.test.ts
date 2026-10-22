import { expect } from 'chai';
import { domainListed, emailDomain, normalizeDomain, suffixes } from '../src/domain.js';

describe('emailDomain', () => {
  it('lower-cases and strips one trailing dot', () => expect(emailDomain('A@Mail.Example.COM.')).to.eq('mail.example.com'));
  it('converts IDN to punycode', () => expect(emailDomain('a@bücher.de')).to.eq('xn--bcher-kva.de'));
  it('takes the part after the last @', () => expect(emailDomain('"a@b"@c.io')).to.eq('c.io'));
  it('refuses an address without a domain', () => {
    expect(emailDomain('a@')).to.eq(null);
    expect(emailDomain('plain')).to.eq(null);
  });
  it('refuses IP literals and bare IPs', () => {
    expect(emailDomain('a@[127.0.0.1]')).to.eq(null);
    expect(emailDomain('a@127.0.0.1')).to.eq(null);
  });
  it('refuses single-label hosts', () => expect(emailDomain('a@localhost')).to.eq(null));
});

describe('normalizeDomain', () => {
  it('trims whitespace', () => expect(normalizeDomain('  Foo.COM ')).to.eq('foo.com'));
  it('refuses invalid labels', () => {
    for (const d of ['-a.com', 'a-.com', 'a_b.com', 'a..com', `${'a'.repeat(64)}.com`]) {
      expect(normalizeDomain(d), d).to.eq(null);
    }
  });
});

describe('suffixes', () => {
  it('yields the domain, then each parent', () => expect([...suffixes('a.b.c')]).to.deep.eq(['a.b.c', 'b.c', 'c']));
});

describe('domainListed', () => {
  const listed = new Set(['mailinator.com']);
  it('matches exactly', () => expect(domainListed('mailinator.com', listed)).to.eq(true));
  it('matches subdomains', () => expect(domainListed('x.y.mailinator.com', listed)).to.eq(true));
  it('does not match a suffix that is not a label', () => expect(domainListed('notmailinator.com', listed)).to.eq(false));
});
