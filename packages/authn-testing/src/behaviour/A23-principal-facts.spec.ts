import assert from 'node:assert/strict';
import type { ProbeBody } from '../harness/http.js';
import { ALICE, KIT_ATTRIBUTES, auth, expectMfaRequired, expectSuccess, probe, pw, routes, seedUser, send } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

/** True when `needle` occurs in a string anywhere inside the value, Maps, Sets, arrays and objects included. */
function containsDeep(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') {
    return value.includes(needle);
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  seen.add(value);
  const parts = value instanceof Map ? [...value.keys(), ...value.values()] : value instanceof Set || Array.isArray(value) ? [...value] : Object.entries(value).flat();
  return parts.some((v) => containsDeep(v, needle, seen));
}

export const A23: AuthnRule = defineRule('A23', 'a success becomes a principal with authn facts', [
  defineCase({
    name: 'A23 a login result becomes a principal with authn facts',
    facet: 'A23/core',
    needs: ['service', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session, 'an interactive login issues a session');
      const p = await h.service.principalOf(r);
      assert.strictEqual(p.id, a.id);
      assert.ok(p.authn, 'the principal carries authn facts');
      assert.strictEqual(p.authn.method, r.facts.method);
      assert.strictEqual(p.authn.strategy, r.facts.strategy);
      assert.strictEqual(p.authn.assurance, 'aal1');
      assert.deepStrictEqual([...p.authn.mfa], []);
      assert.strictEqual(p.authn.authenticatedAt.getTime(), k.clock.now().getTime());
      assert.ok(typeof p.authn.sessionHandle === 'string' && p.authn.sessionHandle !== r.session.id, 'a handle that is not the raw id');
      assert.strictEqual(p.authn.impersonator, undefined);
    },
  }),
  defineCase({
    name: 'A23 after MFA the principal is aal2 with its steps',
    facet: 'A23/core',
    needs: ['service', 'seed', 'mfa'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r);
      const s = await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx());
      expectSuccess(s);
      const p = await h.service.principalOf(s);
      assert.strictEqual(p.authn?.assurance, 'aal2');
      assert.deepStrictEqual([...(p.authn?.mfa ?? [])], [h.mfa.step.name]);
    },
  }),
  defineCase({
    name: 'A23 sessionHandle is the listed handle',
    facet: 'A23/core',
    needs: ['service', 'seed', 'sessions'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session, 'an interactive login issues a session');
      const p = await h.service.principalOf(r);
      const listed = (await h.sessions.list(a, { current: r.session })).find((x) => x.current);
      assert.ok(listed, 'the current session is listed');
      assert.strictEqual(p.authn?.sessionHandle, listed.handle);
    },
  }),
  defineCase({
    name: 'A23 the result reaches PrincipalFactory with its facts and attributes',
    facet: 'A23/core',
    needs: ['service', 'seed', 'principals'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      await h.service.principalOf(r);
      const c = h.principals.calls().at(-1);
      assert.ok(c, 'PrincipalFactory was called');
      assert.deepStrictEqual(c.id, a);
      assert.strictEqual(c.facts.method, r.facts.method);
      assert.strictEqual(c.facts.authenticatedAt.getTime(), k.clock.now().getTime());
      assert.deepStrictEqual(c.extra.attributes, r.attributes);
    },
  }),
  defineCase({
    name: 'A23 per-request attributes reach PrincipalFactory',
    facet: 'A23/core',
    needs: ['service', 'seed', 'attributed', 'principals'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, await h.attributed.credentials('per-request', a), { purpose: 'request' });
      expectSuccess(r);
      assert.deepStrictEqual(r.attributes, KIT_ATTRIBUTES);
      await h.service.principalOf(r);
      assert.strictEqual(h.principals.calls().at(-1)?.extra.attributes?.profile, 'kit-p');
    },
  }),
  defineCase({
    name: 'A23 sessions do not keep strategy attributes',
    facet: 'A23/core',
    needs: ['service', 'seed', 'attributed', 'sessions'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, await h.attributed.credentials('interactive', a));
      expectSuccess(r);
      assert.ok(r.session, 'an interactive login issues a session');
      const stored = await h.sessions.restore(r.session.id);
      assert.ok(stored, 'the session restores');
      assert.ok(!containsDeep(stored.data, 'kit-p'), 'no session data holds the attribute value');
    },
  }),
  defineCase({
    name: "A23 a request's principal carries authn facts",
    facet: 'A23/http',
    needs: ['http', 'http.routes.login', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      const jar = k.jar();
      assert.strictEqual((await send(h, routes(h).login(ALICE.login, ALICE.password), jar)).status, 200);
      const authn = ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal?.authn;
      assert.ok(authn, 'the probe principal carries authn facts');
      assert.strictEqual(typeof authn.method, 'string');
      assert.strictEqual(typeof authn.strategy, 'string');
      assert.strictEqual(authn.assurance, 'aal1');
      assert.ok(Array.isArray(authn.mfa), 'mfa is an array');
      assert.ok(!Number.isNaN(Date.parse(authn.authenticatedAt)), 'authenticatedAt parses as a date');
      assert.strictEqual(typeof authn.sessionHandle, 'string');
    },
  }),
]);
