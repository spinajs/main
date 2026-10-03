import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';
import { DI } from '@spinajs/di';
import { fakeEvaluationContext } from '@spinajs/authz-testing';

import { AuthzConfigError, BUILTIN_CONDITION_FUNCTIONS, CONDITION_UNKNOWN, ConditionCompiler, DefaultConditionCompiler, FALSE, GlobMatch, IpIn, TRUE, TimeBetween, WildcardMatch, matchGlob, matchWildcard } from '../../src/index.js';
import type { Condition, DecisionRequest, Principal } from '../../src/index.js';
import { principal } from '../engine/fakes.js';

const expect = chai.expect;

const alice: Principal = principal('user', 'alice', { attributes: { path: 'a/b/c' } });
const at = (iso: string, extra: Record<string, unknown> = {}) => ({ principal: alice, env: { now: new Date(iso), ...extra } });

describe('conditions: built-in functions', () => {
  describe('time.between', () => {
    const f = new TimeBetween();
    const between = (from: string, to: string, iso: string, tz?: string) => f.evaluateKleene({ from, to, ...(tz ? { tz } : {}) }, at(iso));

    it('holds from `from` (inclusive) to `to` (exclusive), UTC by default', () => {
      expect(between('08:00', '18:00', '2026-10-01T08:00:00.000Z')).to.equal(true);
      expect(between('08:00', '18:00', '2026-10-01T17:59:59.999Z')).to.equal(true);
      expect(between('08:00', '18:00', '2026-10-01T18:00:00.000Z')).to.equal(false);
      expect(between('08:00', '18:00', '2026-10-01T07:59:00.000Z')).to.equal(false);
    });

    it('reads the wall clock of tz, daylight saving included', () => {
      // 06:30Z is 08:30 in Warsaw in summer (UTC+2) and 07:30 in winter (UTC+1).
      expect(between('08:00', '18:00', '2026-07-01T06:30:00.000Z', 'Europe/Warsaw')).to.equal(true);
      expect(between('08:00', '18:00', '2026-01-15T06:30:00.000Z', 'Europe/Warsaw')).to.equal(false);
    });

    it('wraps past midnight when from is after to', () => {
      expect(between('22:00', '06:00', '2026-10-01T23:30:00.000Z')).to.equal(true);
      expect(between('22:00', '06:00', '2026-10-01T05:59:00.000Z')).to.equal(true);
      expect(between('22:00', '06:00', '2026-10-01T12:00:00.000Z')).to.equal(false);
    });

    it('is UNKNOWN without a valid env.now or with bad args at runtime', () => {
      expect(f.evaluateKleene({ from: '08:00', to: '18:00' }, { principal: alice, env: {} })).to.equal(undefined);
      expect(f.evaluateKleene({ from: '08:00', to: '18:00' }, { principal: alice, env: { now: new Date(NaN) } })).to.equal(undefined);
      expect(f.evaluateKleene({ from: '8', to: '18:00' }, at('2026-10-01T12:00:00.000Z'))).to.equal(undefined);
      expect(f.evaluateKleene({ from: '08:00', to: '18:00', tz: 'Mars/Base' }, at('2026-10-01T12:00:00.000Z'))).to.equal(undefined);
    });

    it('checks literal args at boot', () => {
      const check = (args: Record<string, unknown>) => () => f.checkArgs(args, 'abac policy p');
      expect(check({ from: '08:00', to: '18:00', tz: 'Europe/Warsaw' })).not.to.throw();
      expect(check({ from: { ref: 'scope.org.hours.from' }, to: '18:00' })).not.to.throw();
      expect(check({ from: '8:00', to: '18:00' })).to.throw(AuthzConfigError, /abac policy p: time.between from must be "HH:MM"/);
      expect(check({ from: '08:00', to: '24:00' })).to.throw(AuthzConfigError, /to must be/);
      expect(check({ from: '08:00', to: '08:00' })).to.throw(AuthzConfigError, /an empty range/);
      expect(check({ from: '08:00', to: '18:00', tz: 'Mars/Base' })).to.throw(AuthzConfigError, /not an IANA time zone/);
      expect(check({ from: '08:00', to: '18:00', days: [] })).to.throw(AuthzConfigError, /takes from, to, tz, not "days"/);
    });
  });

  describe('ip.in', () => {
    const f = new IpIn();
    const inRanges = (cidrs: unknown, ip: unknown) => f.evaluateKleene({ cidrs }, { principal: alice, env: { ip } });

    it('matches IPv4 and IPv6 ranges and single addresses, mapped IPv4 included', () => {
      expect(inRanges(['10.0.0.0/8'], '10.1.2.3')).to.equal(true);
      expect(inRanges(['10.0.0.0/8'], '11.1.2.3')).to.equal(false);
      expect(inRanges(['192.168.1.7'], '192.168.1.7')).to.equal(true);
      expect(inRanges(['192.168.1.7'], '192.168.1.8')).to.equal(false);
      expect(inRanges(['2001:db8::/32'], '2001:db8::1')).to.equal(true);
      expect(inRanges(['2001:db8::/32'], '2001:db9::1')).to.equal(false);
      expect(inRanges(['10.0.0.0/8'], '::ffff:10.1.2.3')).to.equal(true);
      expect(inRanges(['0.0.0.0/0'], '8.8.8.8')).to.equal(true);
    });

    it('takes the address from args.ip before env.ip', () => {
      expect(f.evaluateKleene({ cidrs: ['10.0.0.0/8'], ip: '10.0.0.1' }, { principal: alice, env: { ip: '1.1.1.1' } })).to.equal(true);
    });

    it('is UNKNOWN for a missing or malformed address or range, so a deny stays closed', () => {
      expect(inRanges(['10.0.0.0/8'], undefined)).to.equal(undefined);
      expect(inRanges(['10.0.0.0/8'], 'nope')).to.equal(undefined);
      expect(inRanges(['10.0.0.0/33'], '10.0.0.1')).to.equal(undefined);
      expect(inRanges([], '10.0.0.1')).to.equal(undefined);
      expect(inRanges('10.0.0.0/8', '10.0.0.1')).to.equal(undefined);
    });

    it('checks literal args at boot', () => {
      const check = (args: Record<string, unknown>) => () => f.checkArgs(args, 'w');
      expect(check({ cidrs: ['10.0.0.0/8', '::1'] })).not.to.throw();
      expect(check({ cidrs: { ref: 'scope.org.network.cidrs' }, ip: { ref: 'actor.attributes.ip' } })).not.to.throw();
      expect(check({ cidrs: [] })).to.throw(AuthzConfigError, /non-empty list/);
      expect(check({ cidrs: ['10.0.0.0/8', '300.0.0.0/8'] })).to.throw(AuthzConfigError, /cidrs\[1\] "300.0.0.0\/8" is not an IP range/);
      expect(check({ cidrs: ['10.0.0.0/x'] })).to.throw(AuthzConfigError, /not an IP range/);
      expect(check({ cidrs: ['10.0.0.0/8'], ip: 'x' })).to.throw(AuthzConfigError, /is not an IP address/);
    });
  });

  describe('glob and wildcard', () => {
    it('match as the cmp operators do', () => {
      const pairs = fc.tuple(fc.constantFrom('*', '**', 'a/*', 'a/**', 'release/*', '*/c', 'a*c'), fc.constantFrom('a', 'a/b', 'a/b/c', 'release/1', 'release/1/x', 'abc', ''));
      fc.assert(
        fc.property(pairs, ([pattern, value]) => {
          expect(new GlobMatch().evaluateKleene({ value, pattern })).to.equal(matchGlob(pattern, value));
          expect(new WildcardMatch().evaluateKleene({ value, pattern })).to.equal(matchWildcard(pattern, value));
        }),
        { numRuns: 200, seed: 3301 },
      );
      expect(new GlobMatch().evaluateKleene({ value: 'a/b', pattern: 'a/*' })).to.equal(true);
      expect(new GlobMatch().evaluateKleene({ value: 'a/b/c', pattern: 'a/*' })).to.equal(false);
      expect(new WildcardMatch().evaluateKleene({ value: 'a/b/c', pattern: 'a/*' })).to.equal(true);
    });

    it('are UNKNOWN for a value or pattern that is not a string', () => {
      expect(new GlobMatch().evaluateKleene({ value: 1, pattern: '*' })).to.equal(undefined);
      expect(new WildcardMatch().evaluateKleene({ value: 'a' })).to.equal(undefined);
    });

    it('check literal args at boot', () => {
      expect(() => new GlobMatch().checkArgs({ value: { ref: 'principal.attributes.path' }, pattern: 'a/*' }, 'w')).not.to.throw();
      expect(() => new GlobMatch().checkArgs({ value: 'a', pattern: 1 }, 'w')).to.throw(AuthzConfigError, /glob pattern must be a string/);
      expect(() => new WildcardMatch().checkArgs({ value: 'a', pattern: 'b', x: 1 }, 'w')).to.throw(AuthzConfigError, /wildcard takes value, pattern/);
    });
  });

  describe('through the compiler', () => {
    const compiler = new DefaultConditionCompiler();
    const ctx = () => fakeEvaluationContext({ now: new Date('2026-10-01T12:00:00.000Z') });
    const req = (env: Record<string, unknown> = {}): DecisionRequest => ({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: new Date('2026-10-01T12:00:00.000Z'), ...env } });
    const compile = (c: Condition, env?: Record<string, unknown>) => compiler.compile(c, req(env), ctx());

    it('has the four built-ins by default', () => {
      expect([...compiler.functionNames()].sort()).to.deep.equal(['glob', 'ip.in', 'time.between', 'wildcard']);
      expect(BUILTIN_CONDITION_FUNCTIONS.map((f) => f.name)).to.deep.equal(['time.between', 'ip.in', 'glob', 'wildcard']);
    });

    it('decides them now; reading env makes the result uncacheable', async () => {
      expect(await compile({ fn: 'time.between', args: { from: '08:00', to: '18:00' } })).to.deep.include({ filter: TRUE, cacheable: false });
      expect(await compile({ fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } }, { ip: '10.0.0.1' })).to.deep.include({ filter: TRUE, cacheable: false });
      expect(await compile({ fn: 'glob', args: { value: { ref: 'principal.attributes.path' }, pattern: 'a/*' } })).to.deep.include({ filter: FALSE, cacheable: true });
      expect(await compile({ fn: 'wildcard', args: { value: { ref: 'principal.attributes.path' }, pattern: 'a/*' } })).to.deep.include({ filter: TRUE, cacheable: true });
    });

    it('keep UNKNOWN as UNKNOWN: a deny on ip.in without an address stays closed', async () => {
      expect((await compile({ fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } })).filter).to.equal(CONDITION_UNKNOWN);
      expect((await compile({ not: { fn: 'ip.in', args: { cidrs: ['10.0.0.0/8'] } } })).filter).to.deep.equal({ op: 'not', arg: CONDITION_UNKNOWN });
    });

    it('reject bad literal args when the condition is parsed', () => {
      expect(() => compiler.parse({ any: [{ fn: 'time.between', args: { from: '25:00', to: '18:00' } }] }, 'abac policy hours when')).to.throw(AuthzConfigError, /^abac policy hours when: time.between from must be/);
      expect(() => compiler.parse({ not: { fn: 'ip.in', args: { cidrs: ['x'] } } })).to.throw(AuthzConfigError, /^condition: ip.in cidrs\[0\]/);
    });

    it('are registered in DI, so a resolved compiler has them, also with two copies of the package loaded', async () => {
      const c = (await DI.resolve(ConditionCompiler)) as DefaultConditionCompiler;
      expect([...c.functionNames()]).to.include.members(['glob', 'ip.in', 'time.between', 'wildcard']);
    });
  });
});
