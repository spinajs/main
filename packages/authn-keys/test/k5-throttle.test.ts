import 'mocha';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { AuthenticationStrategy, AuthnEventSink, AuthnService, AuthnThrottle, IdentityStore, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthnContext, Credentials, KeyOwner } from '@spinajs/authn/contracts';
import { MemoryAuthnThrottle } from '@spinajs/authn';
import { FakeClock, FakeIdentityStore, RecordingEventSink, RecordingPrincipalFactory, generateKeyPair, signCompactJws, signHttpRequest, throttleParams } from '@spinajs/authn-testing';
import type { ConfigOverrides, KitKeyPair } from '@spinajs/authn-testing';
import { assertionIssuer } from '../src/strategies/index.js';
import { KIT_AUDIENCE, keysParts } from './harness.js';

// K5: the real DefaultAuthnService over the real per-request key strategies and MemoryAuthnThrottle.

const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'runner-k5' };
const ADMIN = { type: 'user', id: 'admin' };
const IP = '192.0.2.10';

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class K5KeysConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = 'test';
    }
    protected loadSources(): void {
      this.Sources = [];
    }
    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

async function world(config: ConfigOverrides = {}) {
  const clock = new FakeClock();
  const p = await keysParts({}, 'memory');
  const throttle = new MemoryAuthnThrottle(throttleParams(config) as ConstructorParameters<typeof MemoryAuthnThrottle>[0]);
  const listed = [
    { name: p.strategies[0].name, service: 'K5Assertion', instance: p.strategies[0] },
    { name: p.strategies[1].name, service: 'K5HttpSig', instance: p.strategies[1] },
  ];
  const child = DI.RootContainer.child();
  child.register(configurationOf({ authn: { strategies: listed.map(({ name, service }) => ({ name, service })), throttle: { service: 'MemoryAuthnThrottle' }, audit: { sinks: ['K5Events'] } } })).as(Configuration);
  bind(child, AuthnThrottle, 'MemoryAuthnThrottle', throttle);
  bind(child, IdentityStore, 'K5IdentityStore', new FakeIdentityStore());
  bind(child, PrincipalFactory, 'K5PrincipalFactory', new RecordingPrincipalFactory());
  bind(child, AuthnEventSink, 'K5Events', new RecordingEventSink());
  for (const s of listed) bind(child, AuthenticationStrategy, s.service, s.instance);
  const service = (await child.resolve(AuthnService)) as AuthnService;

  const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => clock.ctx({ purpose: 'request', ip: IP, ...over });
  const add = async (kp: KitKeyPair = generateKeyPair('EdDSA')) => {
    const r = await p.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk }, ctx());
    assert.ok(r.ok, JSON.stringify(r));
    return { kp, kid: r.key.kid };
  };
  const nowS = () => Math.floor(clock.now().getTime() / 1000);
  const assertion = (kp: KitKeyPair, kid: string): Credentials => ({
    kind: 'jws-assertion',
    jws: signCompactJws({ alg: kp.alg, kid, typ: 'spinajs-client+jwt' }, { iss: assertionIssuer(SVC), aud: KIT_AUDIENCE, iat: nowS(), exp: nowS() + 60, jti: randomUUID() }, kp),
  });
  const signed = (kp: KitKeyPair, kid: string): Credentials => ({
    kind: 'http-signature',
    request: signHttpRequest({ method: 'GET', targetUri: 'https://api.kit.test/v1/items' }, kp, kid, { created: nowS(), expires: nowS() + 300, nonce: randomUUID() }),
  });
  const auth = (c: Credentials, over: Partial<AuthnContext> = {}) => service.authenticate(c, ctx(over));
  return { clock, throttle, service, add, assertion, signed, auth, dispose: () => child.dispose() };
}

const statuses = (rs: readonly AuthenticationResult[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rs) {
    const k = r.status === 'failure' ? `failure:${r.reason}` : r.status;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

describe('authn-keys per-request throttling (K5, DefaultAuthnService)', function () {
  this.timeout(30_000);

  let w: Awaited<ReturnType<typeof world>> | undefined;

  afterEach(async () => {
    await w?.dispose();
    w = undefined;
  });

  it('lets 30 parallel valid assertions and 30 parallel valid signed requests of one key through', async () => {
    w = await world();
    const { kp, kid } = await w.add();
    const assertions = await Promise.all(Array.from({ length: 30 }, () => w!.auth(w!.assertion(kp, kid))));
    assert.deepStrictEqual(statuses(assertions), { success: 30 });
    const requests = await Promise.all(Array.from({ length: 30 }, () => w!.auth(w!.signed(kp, kid))));
    assert.deepStrictEqual(statuses(requests), { success: 30 });
  });

  it('throttles repeated bad signatures on a kid with backoff, the owner included, until the delay ends', async () => {
    w = await world();
    const { kp, kid } = await w.add();
    const forged = generateKeyPair('EdDSA');
    const free = throttleParams().login.account!.free;
    for (let i = 0; i < free; i++) assert.deepStrictEqual(await w.auth(w.assertion(forged, kid)), { status: 'failure', reason: 'invalid_credentials' }, `bad ${i + 1}`);
    assert.deepStrictEqual(await w.auth(w.assertion(forged, kid)), { status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
    assert.deepStrictEqual(await w.auth(w.signed(kp, kid)), { status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
    w.clock.tick(1000);
    assert.strictEqual((await w.auth(w.signed(kp, kid))).status, 'success', 'the owner after the delay');
    assert.strictEqual((await w.auth(w.assertion(forged, kid))).status, 'failure');
  });

  it('keeps the failures of unknown kids on the ip key while valid requests from that ip succeed', async () => {
    w = await world({ authn: { throttle: { login: { ip: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } } } } });
    const { kp, kid } = await w.add();
    const stranger = generateKeyPair('EdDSA');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await w.auth(w.assertion(stranger, `kit-unknown-${i}`))).status, 'failure', `unknown kid ${i + 1}`);
      if (i < 2) assert.strictEqual((await w.auth(w.assertion(kp, kid))).status, 'success', `own key ${i + 1}`);
    }
    assert.deepStrictEqual(await w.auth(w.assertion(stranger, 'kit-unknown-3')), { status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
    assert.deepStrictEqual(await w.auth(w.assertion(kp, kid)), { status: 'failure', reason: 'throttled', retryAfterSeconds: 1 });
  });
});
