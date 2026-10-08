import assert from 'node:assert/strict';
import { DEFAULT_THROTTLE } from '../harness/config.js';
import type { ProbeBody } from '../harness/http.js';
import { burst } from '../helpers/concurrency.js';
import { ALICE, IP_A, IP_B, NOBODY, SPOOF_IP, WRONG, auth, expectAllowed, expectFailure, expectRefused, expectThrottled, isFailure, isThrottled, probe, pw, pwKeys, seedUser, send } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

const LOGIN_ACCOUNT_1S = { authn: { throttle: { login: { account: { free: 1, baseDelayMs: 1000, maxDelayMs: 1000 } } } } };

/** More parallel requests than the default ip and account keys let through. */
const PARALLEL = DEFAULT_THROTTLE.login.ip!.free + 10;

/** Verifies, then fails the status check: the identity does not exist. */
const ghost = { type: 'user', id: 'kit-ghost' } as const;

const request = (k: CaseKit) => k.ctx({ purpose: 'request' });

export const A05: AuthnRule = defineRule('A05', 'attempts are counted atomically per key: before verification, or after a failure for per-request strategies', [
  defineCase({
    name: 'A05 SR-05 parallel burst verifies only free attempts',
    facet: 'A05/store',
    needs: ['throttle'],
    async run(h, k) {
      const p = h.throttle.params;
      const r = await burst(50, () => h.throttle.throttle.attempt(pwKeys('burst@example.test', IP_A), 'login', k.ctx()));
      const results = r.fulfilled();
      assert.strictEqual(results.length, 50, 'no attempt rejects');
      assert.strictEqual(
        r.count((x) => x.allowed),
        p.login.account!.free,
      );
      for (const x of results.filter((y) => !y.allowed)) {
        expectRefused(x, 1);
      }
    },
  }),
  defineCase({
    name: 'A05 one backoff slot admits one of many parallel attempts',
    facet: 'A05/store',
    needs: ['throttle'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const keys = pwKeys('slot@example.test', IP_A);
      for (let i = 0; i < p.login.account!.free; i++) {
        expectAllowed(await throttle.attempt(keys, 'login', k.ctx()), `free attempt ${i + 1}`);
      }
      k.clock.tick(1000);
      const r = await burst(20, () => throttle.attempt(keys, 'login', k.ctx()));
      assert.strictEqual(
        r.count((x) => x.allowed),
        1,
      );
      for (const x of r.fulfilled().filter((y) => !y.allowed)) {
        expectRefused(x, 2);
      }
      assert.strictEqual(r.fulfilled().length, 20);
    },
  }),
  defineCase({
    name: 'A05 a refused attempt is neither counted nor delays later slots',
    facet: 'A05/store',
    needs: ['throttle'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const keys = pwKeys('refused@example.test', IP_A);
      const t0 = k.clock.now().getTime();
      for (let i = 0; i < p.login.account!.free; i++) {
        expectAllowed(await throttle.attempt(keys, 'login', k.ctx()));
      }
      expectRefused(await throttle.attempt(keys, 'login', k.ctx()), 1);
      k.clock.set(new Date(t0 + 500));
      for (let i = 0; i < 10; i++) {
        expectRefused(await throttle.attempt(keys, 'login', k.ctx()), 1, `refusal ${i + 1} at +500 ms`);
      }
      k.clock.set(new Date(t0 + 1000));
      expectAllowed(await throttle.attempt(keys, 'login', k.ctx()), 'the slot at +1 s');
      expectRefused(await throttle.attempt(keys, 'login', k.ctx()), 2);
      k.clock.set(new Date(t0 + 3000));
      expectAllowed(await throttle.attempt(keys, 'login', k.ctx()), 'the slot at +3 s');
    },
  }),
  defineCase({
    name: 'A05 unknown and known logins count the same way',
    facet: 'A05/store',
    needs: ['throttle'],
    config: LOGIN_ACCOUNT_1S,
    async run(h, k) {
      const { throttle } = h.throttle;
      for (const keys of [pwKeys(ALICE.login, IP_A), pwKeys(NOBODY, IP_B)]) {
        expectAllowed(await throttle.attempt(keys, 'login', k.ctx()), keys[0].value);
        expectRefused(await throttle.attempt(keys, 'login', k.ctx()), 1, keys[0].value);
      }
    },
  }),
  defineCase({
    name: 'A05 a parallel burst of logins verifies only free attempts',
    facet: 'A05/core',
    needs: ['service', 'seed', 'spy'],
    async run(h, k) {
      const free = DEFAULT_THROTTLE.login.account!.free;
      await seedUser(h, ALICE);
      const v0 = h.spy.verifyCalls();
      const r = await burst(30, () => auth(h, k, pw(ALICE.login, WRONG)));
      assert.strictEqual(r.fulfilled().length, 30, 'no login rejects');
      assert.strictEqual(h.spy.verifyCalls() - v0, free, 'verify calls');
      assert.strictEqual(
        r.count((x) => isFailure(x, 'invalid_credentials')),
        free,
      );
      assert.strictEqual(
        r.count((x) => isThrottled(x, 1)),
        30 - free,
      );
    },
  }),
  defineCase({
    name: 'A05 a throttled login verifies nothing',
    facet: 'A05/core',
    needs: ['service', 'seed', 'spy'],
    config: LOGIN_ACCOUNT_1S,
    async run(h, k) {
      await seedUser(h, ALICE);
      expectFailure(await auth(h, k, pw(ALICE.login, WRONG)), 'invalid_credentials');
      const v = h.spy.verifyCalls();
      for (let i = 0; i < 5; i++) {
        expectThrottled(await auth(h, k, pw(ALICE.login, WRONG)), 1);
      }
      assert.strictEqual(h.spy.verifyCalls(), v);
    },
  }),
  // K5: a per-request strategy (token, key) counts only its failures, so a busy client with a valid credential is not
  // throttled; login methods keep the count before verify.
  defineCase({
    name: 'A05 parallel per-request calls with a valid credential all verify',
    facet: 'A05/core',
    needs: ['service', 'seed', 'attributed', 'spy'],
    async run(h, k) {
      const c = await h.attributed.credentials('per-request', await seedUser(h, ALICE));
      const v0 = h.spy.verifyCalls();
      const r = await burst(PARALLEL, () => h.service.authenticate(c, request(k)));
      assert.strictEqual(r.count((x) => x.status === 'success'), PARALLEL, JSON.stringify(r.outcomes.find((o) => !o.ok || o.value.status !== 'success')));
      assert.strictEqual(h.spy.verifyCalls() - v0, PARALLEL, 'verify calls');
    },
  }),
  defineCase({
    name: 'A05 per-request failures are counted and back off',
    facet: 'A05/core',
    needs: ['service', 'attributed', 'spy'],
    config: LOGIN_ACCOUNT_1S,
    async run(h, k) {
      const c = await h.attributed.credentials('per-request', ghost);
      expectFailure(await h.service.authenticate(c, request(k)), 'invalid_credentials');
      const v = h.spy.verifyCalls();
      for (let i = 0; i < 5; i++) {
        expectThrottled(await h.service.authenticate(c, request(k)), 1, `refusal ${i + 1}`);
      }
      assert.strictEqual(h.spy.verifyCalls(), v, 'a throttled request verifies nothing');
      k.clock.tick(1000);
      expectFailure(await h.service.authenticate(c, request(k)), 'invalid_credentials', 'the slot at +1 s');
      expectThrottled(await h.service.authenticate(c, request(k)), 1);
    },
  }),
  defineCase({
    name: 'A05 parallel interactive logins with a valid credential still count before verify',
    facet: 'A05/core',
    needs: ['service', 'seed', 'attributed', 'spy'],
    async run(h, k) {
      const free = DEFAULT_THROTTLE.login.account!.free;
      const c = await h.attributed.credentials('interactive', await seedUser(h, ALICE));
      const v0 = h.spy.verifyCalls();
      const r = await burst(PARALLEL, () => auth(h, k, c));
      assert.strictEqual(r.fulfilled().length, PARALLEL, 'no login rejects');
      assert.strictEqual(h.spy.verifyCalls() - v0, free, 'verify calls');
      assert.strictEqual(
        r.count((x) => isThrottled(x, 1)),
        PARALLEL - free,
      );
    },
  }),
  defineCase({
    name: 'A05 SR-03 spoofed X-Forwarded-For is ignored',
    facet: 'A05/http',
    needs: ['http'],
    config: { authn: { http: { trustProxy: null } } },
    async run(h) {
      assert.ok(h.http.socketAddress !== SPOOF_IP, 'the socket address must differ from SPOOF_IP');
      const res = await send(h, { ...probe(h, 'GET'), headers: { 'x-forwarded-for': SPOOF_IP } });
      const body = res.body as ProbeBody;
      assert.strictEqual(body.clientIp, h.http.socketAddress);
      assert.ok(body.clientIp !== SPOOF_IP);
    },
  }),
  defineCase({
    name: "A05 a trusted hop's X-Forwarded-For gives the client address",
    facet: 'A05/http',
    needs: ['http'],
    config: { authn: { http: { trustProxy: 1 } } },
    async run(h) {
      const res = await send(h, { ...probe(h, 'GET'), headers: { 'x-forwarded-for': '198.51.100.1, ' + SPOOF_IP } });
      assert.strictEqual((res.body as ProbeBody).clientIp, SPOOF_IP);
    },
  }),
]);
