import assert from 'node:assert/strict';
import type { ThrottleFlow, ThrottleKey } from '@spinajs/authn/contracts';
import { backoffDelayMs, walkBackoff } from '../helpers/backoff.js';
import { ALICE, BOB, CAROL, IP_A, IP_B, WRONG, attackerIp, auth, expectAllowed, expectFail, expectFailure, expectMfaRequired, expectRefused, expectSuccess, expectThrottled, hasEvent, pw, pwKeys, seedUser, throttleParams } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

const FLOWS: readonly ThrottleFlow[] = ['login', 'mfa', 'reset', 'reauth'];

export const A06: AuthnRule = defineRule('A06', 'backoff per key, never a lock', [
  defineCase({
    name: 'A06 the login account key follows the backoff schedule',
    facet: 'A06/store',
    needs: ['throttle', 'fakeDate'],
    async run(h, k) {
      const acct = h.throttle.params.login.account!;
      await walkBackoff({ throttle: h.throttle.throttle, flow: 'login', params: acct, clock: k.clock, attempts: acct.free + 8, keysFor: () => pwKeys('walk@example.test', IP_A) });
    },
  }),
  defineCase({
    name: 'A06 SR-03 credential stuffing from one IP backs off',
    facet: 'A06/store',
    needs: ['throttle', 'fakeDate'],
    async run(h, k) {
      const ipP = h.throttle.params.login.ip!;
      await walkBackoff({ throttle: h.throttle.throttle, flow: 'login', params: ipP, clock: k.clock, attempts: ipP.free + 11, keysFor: (n) => pwKeys(`stuff${n}@example.test`, IP_A) });
    },
  }),
  defineCase({
    name: 'A06 SR-05 attacker cannot lock the owner out',
    facet: 'A06/store',
    needs: ['throttle', 'fakeDate'],
    timeoutMs: 300_000,
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const acct = p.login.account!;
      for (let i = 0; i < 10_000; i++) {
        k.clock.tick(1000);
        await throttle.attempt(pwKeys(ALICE.login, attackerIp(i)), 'login', k.ctx());
      }
      const r = await throttle.attempt(pwKeys(ALICE.login, IP_A), 'login', k.ctx());
      if (!r.allowed) {
        assert.ok(r.retryAfterSeconds <= Math.ceil(acct.maxDelayMs / 1000), `the owner waits ${r.retryAfterSeconds} s`);
        k.clock.tick(r.retryAfterSeconds * 1000);
        expectAllowed(await throttle.attempt(pwKeys(ALICE.login, IP_A), 'login', k.ctx()), 'the owner after the wait');
      }
    },
  }),
  defineCase({
    name: "A06 a success on an own account leaves other accounts' failures on the ip key",
    facet: 'A06/store',
    needs: ['throttle'],
    config: { authn: { throttle: { login: { ip: { free: 6, baseDelayMs: 1000, maxDelayMs: 300000 } } } } },
    async run(h, k) {
      const { throttle } = h.throttle;
      const attempt = (keys: readonly ThrottleKey[]) => throttle.attempt(keys, 'login', k.ctx());
      for (let i = 0; i < 3; i++) expectAllowed(await attempt(pwKeys(BOB.login, IP_A)), `bob ${i + 1}`);
      for (let i = 0; i < 2; i++) expectAllowed(await attempt(pwKeys(ALICE.login, IP_A)), `alice ${i + 1}`);
      await throttle.succeed(pwKeys(ALICE.login, IP_A), 'login');
      for (let i = 0; i < 3; i++) expectAllowed(await attempt(pwKeys(CAROL.login, IP_A)), `carol ${i + 1}`);
      expectRefused(await attempt(pwKeys(CAROL.login, IP_A)), 1, 'carol 4: the ip key still holds bob');
    },
  }),
  defineCase({
    name: 'A06 a success resets the account key',
    facet: 'A06/store',
    needs: ['throttle'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      for (let i = 0; i < 2; i++) await throttle.attempt(pwKeys(ALICE.login, IP_A), 'login', k.ctx());
      await throttle.succeed(pwKeys(ALICE.login, IP_A), 'login');
      for (let i = 0; i < p.login.account!.free; i++) {
        expectAllowed(await throttle.attempt(pwKeys(ALICE.login, IP_B), 'login', k.ctx()), `attempt ${i + 1}`);
      }
      expectRefused(await throttle.attempt(pwKeys(ALICE.login, IP_B), 'login', k.ctx()), 1);
    },
  }),
  defineCase({
    name: "A06 a success leaves other accounts' keys alone",
    facet: 'A06/store',
    needs: ['throttle'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      for (let i = 0; i < 3; i++) await throttle.attempt(pwKeys(BOB.login, IP_A), 'login', k.ctx());
      await throttle.succeed(pwKeys(ALICE.login, IP_A), 'login');
      for (let i = 0; i < p.login.account!.free - 3; i++) {
        expectAllowed(await throttle.attempt(pwKeys(BOB.login, IP_B), 'login', k.ctx()), `bob ${i + 4}`);
      }
      expectRefused(await throttle.attempt(pwKeys(BOB.login, IP_B), 'login', k.ctx()), 1);
    },
  }),
  defineCase({
    name: 'A06 a key idle for resetAfterSeconds starts from zero',
    facet: 'A06/store',
    needs: ['throttle', 'fakeDate'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const acct = p.login.account!;
      const keys = pwKeys('idle@example.test', IP_A);
      const last = await walkBackoff({ throttle, flow: 'login', params: acct, clock: k.clock, attempts: acct.free + 1, keysFor: () => keys });
      k.clock.set(new Date(last.getTime() + p.resetAfterSeconds * 1000 + 1000));
      for (let i = 0; i < acct.free; i++) {
        expectAllowed(await throttle.attempt(keys, 'login', k.ctx()), `attempt ${i + 1} after the idle time`);
      }
      expectRefused(await throttle.attempt(keys, 'login', k.ctx()), 1);
    },
  }),
  defineCase({
    name: 'A06 a key used within resetAfterSeconds keeps its count',
    facet: 'A06/store',
    needs: ['throttle', 'fakeDate'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const acct = p.login.account!;
      const keys = pwKeys('busy@example.test', IP_A);
      await walkBackoff({ throttle, flow: 'login', params: acct, clock: k.clock, attempts: acct.free + 2, keysFor: () => keys });
      k.clock.tick(3600 * 1000);
      expectAllowed(await throttle.attempt(keys, 'login', k.ctx()));
      expectRefused(await throttle.attempt(keys, 'login', k.ctx()), Math.ceil(backoffDelayMs(acct, acct.free + 3) / 1000));
    },
  }),
  defineCase({
    name: 'A06 account-ip gates nothing',
    facet: 'A06/store',
    needs: ['throttle'],
    async run(h, k) {
      for (let i = 0; i < 50; i++) {
        expectAllowed(await h.throttle.throttle.attempt([{ kind: 'account-ip', value: 'gate@example.test|' + IP_A }], 'login', k.ctx()), `attempt ${i + 1}`);
      }
    },
  }),
  table(FLOWS, (flow) =>
    defineCase({
      name: `A06 ${flow} follows its own parameters`,
      facet: 'A06/store',
      needs: ['throttle', 'fakeDate'],
      async run(h, k) {
        const params = h.throttle.params[flow].account!;
        await walkBackoff({ throttle: h.throttle.throttle, flow, params, clock: k.clock, attempts: params.free + 3, keysFor: () => [{ kind: 'account', value: `flow-${flow}@example.test` }] });
      },
    }),
  ),
  defineCase({
    name: 'A06 flows count apart',
    facet: 'A06/store',
    needs: ['throttle'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const K: ThrottleKey[] = [{ kind: 'account', value: 'apart@example.test' }];
      for (let i = 0; i < p.login.account!.free; i++) {
        expectAllowed(await throttle.attempt(K, 'login', k.ctx()));
      }
      expectRefused(await throttle.attempt(K, 'login', k.ctx()), 1);
      expectAllowed(await throttle.attempt(K, 'mfa', k.ctx()), 'the mfa flow');
    },
  }),
  defineCase({
    name: 'A06 a reset success clears nothing',
    facet: 'A06/store',
    needs: ['throttle'],
    async run(h, k) {
      const { throttle, params: p } = h.throttle;
      const K: ThrottleKey[] = [{ kind: 'account', value: 'reset@example.test' }];
      const wait = Math.ceil(p.reset.account!.baseDelayMs / 1000);
      expectAllowed(await throttle.attempt(K, 'reset', k.ctx()));
      expectRefused(await throttle.attempt(K, 'reset', k.ctx()), wait);
      await throttle.succeed(K, 'reset');
      expectRefused(await throttle.attempt(K, 'reset', k.ctx()), wait, 'after succeed');
    },
  }),
  defineCase({
    name: "A06 a throttled login carries the throttle's delay and is audited",
    facet: 'A06/core',
    needs: ['service', 'seed', 'events'],
    config: { authn: { throttle: { login: { account: { free: 2, baseDelayMs: 4000, maxDelayMs: 60000 } } } } },
    async run(h, k) {
      await seedUser(h, ALICE);
      for (let i = 0; i < 2; i++) {
        expectFailure(await auth(h, k, pw(ALICE.login, WRONG)), 'invalid_credentials');
      }
      expectThrottled(await auth(h, k, pw(ALICE.login, WRONG)), 4);
      assert.ok(hasEvent(h.events, 'throttle.block'), 'a throttle.block event');
    },
  }),
  defineCase({
    name: 'A06 a successful login gives the account its free attempts back',
    facet: 'A06/core',
    needs: ['service', 'seed', 'spy'],
    async run(h, k) {
      const acct = throttleParams(k.config).login.account!;
      await seedUser(h, ALICE);
      for (let i = 0; i < 3; i++) {
        await auth(h, k, pw(ALICE.login, WRONG));
      }
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
      const v = h.spy.verifyCalls();
      for (let i = 0; i < acct.free; i++) {
        expectFailure(await auth(h, k, pw(ALICE.login, WRONG)), 'invalid_credentials', `wrong login ${i + 1}`);
      }
      assert.strictEqual(h.spy.verifyCalls(), v + acct.free);
      expectThrottled(await auth(h, k, pw(ALICE.login, WRONG)), 1);
    },
  }),
  defineCase({
    name: "A06 a per-request success leaves other credentials' failures on the ip key",
    facet: 'A06/core',
    needs: ['service', 'seed', 'attributed'],
    config: { authn: { throttle: { login: { ip: { free: 3, baseDelayMs: 1000, maxDelayMs: 300000 } } } } },
    async run(h, k) {
      const request = () => k.ctx({ purpose: 'request' });
      const good = await h.attributed.credentials('per-request', await seedUser(h, ALICE));
      const ghost = (i: number) => h.attributed.credentials('per-request', { type: 'user', id: `kit-ghost-${i}` });
      for (let i = 0; i < 3; i++) {
        expectFailure(await h.service.authenticate(await ghost(i), request()), 'invalid_credentials', `ghost ${i + 1}`);
        if (i < 2) expectSuccess(await h.service.authenticate(good, request()), `owner ${i + 1}`);
      }
      expectThrottled(await h.service.authenticate(await ghost(3), request()), 1, 'the ip key holds the three failures');
      expectThrottled(await h.service.authenticate(good, request()), 1, 'a valid credential waits on the ip key too');
    },
  }),
  // K6: a per-request credential id travels in clear (a key id), so its backoff is per credential and ip.
  defineCase({
    name: "A06 per-request failures from another ip never delay the credential's owner, and still back off the attacker",
    facet: 'A06/core',
    needs: ['service', 'seed', 'attributed'],
    config: { authn: { throttle: { login: { account: { free: 1, baseDelayMs: 1000, maxDelayMs: 1000 } } } } },
    async run(h, k) {
      const at = (ip: string) => k.ctx({ purpose: 'request', ip });
      const alice = await seedUser(h, ALICE);
      const c = await h.attributed.credentials('per-request', alice);
      await h.seed.setStatus(alice, { banned: true });
      expectFailure(await h.service.authenticate(c, at(IP_B)), 'invalid_credentials', 'the attacker fails once');
      expectThrottled(await h.service.authenticate(c, at(IP_B)), 1, 'the attacker backs off');
      await h.seed.setStatus(alice, { banned: false });
      expectSuccess(await h.service.authenticate(c, at(IP_A)), 'the owner from another ip');
      expectThrottled(await h.service.authenticate(c, at(IP_B)), 1, 'the attacker still waits');
    },
  }),
  defineCase({
    name: 'A06 MFA attempts count in the mfa flow',
    facet: 'A06/core',
    needs: ['service', 'seed', 'mfa'],
    async run(h, k) {
      const p = throttleParams(k.config);
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r);
      for (let i = 0; i < p.mfa.account!.free; i++) {
        expectFail(await h.service.completeMfa(r.pending, h.mfa.step.name, '000000-wrong', k.ctx()), `wrong code ${i + 1}`);
      }
      expectThrottled(await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()), 1);
      k.clock.tick(1000);
      expectSuccess(await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()));
    },
  }),
]);
