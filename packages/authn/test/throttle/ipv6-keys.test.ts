import assert from 'node:assert/strict';
import 'mocha';
import { FakeStrategy } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthenticationResult, AuthnContext, Credentials, StrategyOutcome, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { throttleIp } from '../../src/support/ip-key.js';
import { buildCore, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

describe('throttleIp', () => {
  it('maps addresses of one /64 to one network', () => {
    assert.strictEqual(throttleIp('2001:db8::1', 64), '2001:db8::/64');
    assert.strictEqual(throttleIp('2001:db8::ffff', 64), '2001:db8::/64');
    assert.strictEqual(throttleIp('2001:db8:0:0:ffff:ffff:ffff:ffff', 64), '2001:db8::/64');
  });

  it('keeps different /64 networks apart', () => {
    assert.notStrictEqual(throttleIp('2001:db8:0:1::1', 64), throttleIp('2001:db8:0:2::1', 64));
    assert.strictEqual(throttleIp('2001:db8:0:1::1', 64), '2001:db8:0:1::/64');
  });

  it('groups by the configured prefix length', () => {
    assert.strictEqual(throttleIp('2001:db8:0:ff::1', 56), throttleIp('2001:db8::1', 56));
    assert.notStrictEqual(throttleIp('2001:db8:0:ff::1', 64), throttleIp('2001:db8::1', 64));
    assert.strictEqual(throttleIp('2001:db8:0:ff::1', 56), '2001:db8::/56');
    assert.strictEqual(throttleIp('2001:db8:0:100::1', 56), '2001:db8:0:100::/56');
  });

  it('masks inside a hextet', () => {
    assert.strictEqual(throttleIp('2001:db8:abcd:ffff::1', 52), '2001:db8:abcd:f000::/52');
    assert.strictEqual(throttleIp('2001:db8:abcd:ffff::1', 128), '2001:db8:abcd:ffff::1/128');
  });

  it('writes one form for every spelling of an address', () => {
    const forms = ['2001:DB8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0:0:0:0:1'];
    for (const f of forms) assert.strictEqual(throttleIp(f, 64), '2001:db8::/64', f);
  });

  it('compresses only a run of two or more zero hextets, the first longest run', () => {
    assert.strictEqual(throttleIp('2001:db8:0:1:0:0:0:1', 128), '2001:db8:0:1::1/128');
    assert.strictEqual(throttleIp('2001:0:0:1:0:0:1:1', 128), '2001::1:0:0:1:1/128');
    assert.strictEqual(throttleIp('1:0:2:0:3:0:4:0', 128), '1:0:2:0:3:0:4:0/128');
    assert.strictEqual(throttleIp('::', 64), '::/64');
  });

  it('reads an embedded IPv4 tail and ignores a zone id', () => {
    assert.strictEqual(throttleIp('64:ff9b::192.0.2.33', 64), '64:ff9b::/64');
    assert.strictEqual(throttleIp('fe80::1%eth0', 64), 'fe80::/64');
  });

  it('returns IPv4 unchanged', () => {
    assert.strictEqual(throttleIp('192.0.2.10', 64), '192.0.2.10');
    assert.strictEqual(throttleIp('192.0.2.10', 16), '192.0.2.10');
  });

  it('returns an IPv4-mapped address unchanged', () => {
    assert.strictEqual(throttleIp('::ffff:192.0.2.10', 64), '::ffff:192.0.2.10');
    assert.strictEqual(throttleIp('::ffff:c000:20a', 64), '::ffff:c000:20a');
  });

  it('returns a value that is not an address unchanged', () => {
    assert.strictEqual(throttleIp('unknown', 64), 'unknown');
    assert.strictEqual(throttleIp('2001:db8::g', 64), '2001:db8::g');
  });

  it('refuses a prefix outside 16..128', () => {
    for (const bad of [0, 15, 129, 64.5, Number.NaN]) assert.throws(() => throttleIp('2001:db8::1', bad), /prefix/i, String(bad));
  });
});

const IP6_A = '2001:db8::1';
const IP6_B = '2001:db8::ffff';
const IP6_OTHER_56 = '2001:db8:0:ff::1';

class RecordingThrottle extends MemoryAuthnThrottle {
  readonly attempts: { keys: ThrottleKey[]; flow: ThrottleFlow }[] = [];

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.attempts.push({ keys: [...keys], flow });
    return super.attempt(keys, flow, ctx);
  }
}

const ctxAt = (ip: string | undefined, purpose: AuthnContext['purpose'] = 'login'): AuthnContext => ({ now: new Date(), ip, purpose });
const keyId = (k: ThrottleKey): string => `${k.kind}=${k.value}`;
const bearer = (token: string): Credentials => ({ kind: 'bearer', token });
const refuse = (): StrategyOutcome => ({ ok: false, reason: 'invalid_credentials' });

describe('DefaultAuthnService throttle keys on IPv6', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let throttle: RecordingThrottle | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
    throttle = undefined;
  });

  async function boot(interactive: boolean, config = {}, account = 'acct-1'): Promise<CoreParts> {
    const s = new FakeStrategy({ name: 'probe', kinds: ['bearer'], interactive, keys: () => [{ kind: 'account', value: account }], verify: refuse });
    const opts: CoreOptions = {
      throttle: (_c: Configuration, k: IContainer) => (throttle = pinConfiguration(new RecordingThrottle(), k)),
      strategies: [{ name: s.name, service: 'Svc_probe', instance: s, listed: true }],
    };
    parts = await buildCore(config, opts);
    return parts;
  }

  const sent = (i: number): string[] => throttle!.attempts[i].keys.map(keyId);

  it('gives two addresses of one /64 the same ip and account-ip keys', async () => {
    const p = await boot(true);
    await p.service.authenticate(bearer('x'), ctxAt(IP6_A));
    await p.service.authenticate(bearer('x'), ctxAt(IP6_B));
    assert.deepStrictEqual(sent(0), ['account=login:acct-1', 'account-ip=login:acct-1|2001:db8::/64', 'ip=2001:db8::/64']);
    assert.deepStrictEqual(sent(1), sent(0));
  });

  it("gives a per-request strategy's account key the prefix too", async () => {
    const p = await boot(false);
    await p.service.authenticate(bearer('x'), ctxAt(IP6_A, 'request'));
    await p.service.authenticate(bearer('x'), ctxAt(IP6_B, 'request'));
    assert.deepStrictEqual(sent(0), ['account=request:acct-1|2001:db8::/64', 'account-ip=request:acct-1|2001:db8::/64', 'ip=2001:db8::/64']);
    assert.deepStrictEqual(sent(1), sent(0));
  });

  it('keeps another /64 on other keys', async () => {
    const p = await boot(true);
    await p.service.authenticate(bearer('x'), ctxAt(IP6_A));
    await p.service.authenticate(bearer('x'), ctxAt('2001:db8:0:1::1'));
    assert.notDeepStrictEqual(sent(1), sent(0));
    assert.ok(sent(1).includes('ip=2001:db8:0:1::/64'));
  });

  it('follows authn.throttle.ipv6Prefix', async () => {
    const p = await boot(true, { authn: { throttle: { ipv6Prefix: 56 } } });
    await p.service.authenticate(bearer('x'), ctxAt(IP6_A));
    await p.service.authenticate(bearer('x'), ctxAt(IP6_OTHER_56));
    assert.deepStrictEqual(sent(0), ['account=login:acct-1', 'account-ip=login:acct-1|2001:db8::/56', 'ip=2001:db8::/56']);
    assert.deepStrictEqual(sent(1), sent(0));
  });

  it('leaves IPv4 and IPv4-mapped addresses whole', async () => {
    const p = await boot(true);
    await p.service.authenticate(bearer('x'), ctxAt('192.0.2.10'));
    await p.service.authenticate(bearer('x'), ctxAt('::ffff:192.0.2.10'));
    assert.deepStrictEqual(sent(0), ['account=login:acct-1', 'account-ip=login:acct-1|192.0.2.10', 'ip=192.0.2.10']);
    assert.deepStrictEqual(sent(1), ['account=login:acct-1', 'account-ip=login:acct-1|::ffff:192.0.2.10', 'ip=::ffff:192.0.2.10']);
  });

  it('keeps the request without an address as before', async () => {
    const p = await boot(false);
    await p.service.authenticate(bearer('x'), ctxAt(undefined, 'request'));
    assert.deepStrictEqual(sent(0), ['account=request:acct-1|']);
  });

  it('backs off a /64 as one client on the ip key', async () => {
    const config = { authn: { throttle: { login: { ip: { free: 2, baseDelayMs: 1000, maxDelayMs: 1000 } } } } };
    const p = await boot(true, config);
    const results: AuthenticationResult[] = [];
    for (const ip of [IP6_A, IP6_B, '2001:db8::5']) results.push(await p.service.authenticate(bearer('x'), ctxAt(ip)));
    assert.strictEqual(results[1].status, 'failure');
    assert.deepStrictEqual({ ...results[2] }, { status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
  });

  it('keeps the full address in the audit events', async () => {
    const p = await boot(true);
    await p.service.authenticate(bearer('x'), ctxAt(IP6_A));
    const ips = p.events.all().map((e) => e.ip);
    assert.ok(ips.length > 0, 'an event is published');
    for (const ip of ips) assert.strictEqual(ip, IP6_A);
  });
});
