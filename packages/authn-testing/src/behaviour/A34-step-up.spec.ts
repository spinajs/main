import assert from 'node:assert/strict';
import { ALICE, factsAal1, in4xx, routes, seedUser, send, sessionJar } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A34: AuthnRule = defineRule('A34', 'step-up raises an active session to aal2 under a new id', [
  defineCase({
    name: 'A34 reissue raises an active session to aal2, keeps its data and kills the old id',
    facet: 'A34/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      await h.sessions.set(h1, 'KitKey', 'v');
      const h2 = await h.sessions.reissue(h1, { assurance: 'aal2', mfa: ['kit-step'] });
      assert.ok(h2.id !== h1.id, 'a new id');
      assert.strictEqual(h2.state, 'active');
      assert.strictEqual(await h.sessions.restore(h1.id), null, 'the old id is dead');
      const r = await h.sessions.restore(h2.id);
      assert.ok(r, 'the new id restores');
      assert.strictEqual(r.facts.assurance, 'aal2');
      assert.deepStrictEqual([...r.facts.mfa], ['kit-step']);
      assert.deepStrictEqual({ type: r.identity.type, id: r.identity.id }, { type: a.type, id: a.id });
      assert.strictEqual(r.data.get('KitKey'), 'v');
    },
  }),
  defineCase({
    name: 'A34 reissue refuses a pending session',
    facet: 'A34/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const pd = await h.sessions.issue(a, factsAal1(k), { pending: { steps: ['kit-step'] } });
      await assert.rejects(h.sessions.reissue(pd, { assurance: 'aal2', mfa: ['kit-step'] }));
      assert.strictEqual((await h.sessions.restore(pd.id))?.handle.state, 'pending', 'the session stays pending');
    },
  }),
  defineCase({
    name: 'A34 a route behind MfaSatisfied refuses aal1 and passes the same cookie jar after step-up',
    facet: 'A34/http',
    needs: ['http', 'http.routes.login', 'http.routes.mfaStepUp', 'http.routes.mfaGated', 'seed', 'mfa'],
    async run(h, k) {
      const R = routes(h);
      const a = await seedUser(h, ALICE);
      const jar = k.jar();
      assert.strictEqual((await send(h, R.login(ALICE.login, ALICE.password), jar)).status, 200, 'an aal1 login');
      const aal1 = jar.get(h.http.sessionCookie) ?? assert.fail('the login sets the session cookie');
      await h.mfa.enrol(a);

      const refused = await send(h, R.mfaGated(), jar);
      assert.strictEqual(refused.status, 403, `the gated route at aal1 answered ${refused.status}`);
      assert.strictEqual((refused.body as { error?: unknown } | undefined)?.error, 'mfa_required', JSON.stringify(refused.body));

      const stepped = await send(h, R.mfaStepUp(h.mfa.step.name, await h.mfa.code(a)), jar);
      assert.strictEqual(stepped.status, 200, `step-up answered ${stepped.status} ${JSON.stringify(stepped.body)}`);
      const aal2 = jar.get(h.http.sessionCookie);
      assert.ok(aal2 && aal2 !== aal1, 'step-up sets a new session cookie');

      const passed = await send(h, R.mfaGated(), jar);
      assert.strictEqual(passed.status, 200, `the gated route after step-up answered ${passed.status} ${JSON.stringify(passed.body)}`);
      const old = await send(h, R.mfaGated(), sessionJar(h, aal1));
      assert.ok(in4xx(old.status), `the aal1 cookie answered ${old.status}`);
    },
  }),
]);
