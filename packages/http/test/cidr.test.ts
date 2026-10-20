import 'mocha';
import { expect } from 'chai';

import { cidrMatcher, parseCidr } from '../src/index.js';

describe('parseCidr', () => {
  it('parses IPv4 and IPv6 networks and single addresses', () => {
    expect(parseCidr('10.0.0.0/8')).to.deep.eq({ network: '10.0.0.0', prefix: 8, type: 'ipv4' });
    expect(parseCidr('2001:db8::/32')).to.deep.eq({ network: '2001:db8::', prefix: 32, type: 'ipv6' });
    expect(parseCidr('192.168.1.7')).to.deep.eq({ network: '192.168.1.7', prefix: 32, type: 'ipv4' });
    expect(parseCidr('::1')).to.deep.eq({ network: '::1', prefix: 128, type: 'ipv6' });
    expect(parseCidr('0.0.0.0/0')).to.deep.eq({ network: '0.0.0.0', prefix: 0, type: 'ipv4' });
    expect(parseCidr('::/0')).to.deep.eq({ network: '::', prefix: 0, type: 'ipv6' });
    expect(parseCidr('::ffff:10.0.0.0/104')).to.deep.eq({ network: '::ffff:10.0.0.0', prefix: 104, type: 'ipv6' });
  });

  it('rejects host bits, so a typo cannot widen a range', () => {
    expect(parseCidr('10.0.0.1/8')).to.eq(null);
    expect(parseCidr('2001:db8::1/32')).to.eq(null);
    expect(parseCidr('::ffff:10.0.0.1/104')).to.eq(null);
  });

  it('reads the host bits of an embedded IPv4 suffix, and stays fast on long junk', () => {
    expect(parseCidr('::10.0.0.0/104')).to.deep.eq({ network: '::10.0.0.0', prefix: 104, type: 'ipv6' });
    expect(parseCidr('1:2:3:4:5:6:10.0.0.0/112')).to.deep.eq({ network: '1:2:3:4:5:6:10.0.0.0', prefix: 112, type: 'ipv6' });
    expect(parseCidr('64:ff9b::192.0.2.0/120')).to.deep.eq({ network: '64:ff9b::192.0.2.0', prefix: 120, type: 'ipv6' });
    expect(parseCidr('::10.0.0.1/104')).to.eq(null);
    expect(parseCidr('1:2:3:4:5:6:10.0.1.0/112')).to.eq(null);
    expect(parseCidr('64:ff9b::192.0.2.1/120')).to.eq(null);
    const started = performance.now();
    expect(parseCidr('1'.repeat(100_000) + '.1.1.1/8')).to.eq(null);
    expect(parseCidr('::' + '1'.repeat(100_000))).to.eq(null);
    expect(performance.now() - started).to.be.below(500);
  });

  it('rejects malformed values and zone ids', () => {
    for (const value of [undefined, null, 42, '', 'localhost', '10.0.0.0/', '10.0.0.0/33', '::/129', '10.0.0.0/8/8', '10.0.0.0/-1', '10.0.0.0/08x', '10.0.0.0/0008', 'fe80::1%eth0', 'fe80::%eth0/64', '10.0.0.256']) {
      expect(parseCidr(value), String(value)).to.eq(null);
    }
  });
});

describe('cidrMatcher', () => {
  it('matches addresses inside any of the ranges', () => {
    const inRange = cidrMatcher(['10.0.0.0/8', '2001:db8::/32', '192.168.1.7'])!;
    expect(inRange('10.200.3.4')).to.eq(true);
    expect(inRange('2001:db8:1::5')).to.eq(true);
    expect(inRange('192.168.1.7')).to.eq(true);
    expect(inRange('192.168.1.8')).to.eq(false);
    expect(inRange('11.0.0.1')).to.eq(false);
    expect(inRange('2001:db9::1')).to.eq(false);
  });

  it('matches IPv4 and IPv4-mapped IPv6 forms against each other', () => {
    expect(cidrMatcher(['10.0.0.0/8'])!('::ffff:10.1.2.3')).to.eq(true);
    expect(cidrMatcher(['::ffff:0:0/96'])!('10.1.2.3')).to.eq(true);
    expect(cidrMatcher(['::/0'])!('8.8.8.8')).to.eq(true);
  });

  it('matches nothing for a value that is no IP or carries a zone id', () => {
    const any = cidrMatcher(['0.0.0.0/0', '::/0'])!;
    for (const ip of ['', 'localhost', 'fe80::1%eth0', undefined as unknown as string]) {
      expect(any(ip), String(ip)).to.eq(false);
    }
  });

  it('is null when any entry is malformed, and matches nothing for an empty list', () => {
    expect(cidrMatcher(['10.0.0.0/8', '10.0.0.1/8'])).to.eq(null);
    expect(cidrMatcher(['10.0.0.0/8', 7])).to.eq(null);
    expect(cidrMatcher([])!('10.0.0.1')).to.eq(false);
  });
});
