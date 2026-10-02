import assert from 'node:assert/strict';
import { ALICE, IP_B, NOBODY, WRONG, auth, expectMfaRequired, expectSuccess, pw, seedUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule } from './types.js';

export const A21: AuthnRule = defineRule('A21', 'every event reaches every sink and carries no secret', [
  defineCase({
    name: 'A21 every event reaches every sink',
    facet: 'A21/core',
    needs: ['service', 'seed', 'sinks'],
    async run(h, k) {
      assert.ok(h.sinks.length >= 2, 'the harness registers at least two sinks');
      await seedUser(h, ALICE);
      await auth(h, k, pw(ALICE.login, WRONG));
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
      const types = h.sinks.map((s) => s.all().map((e) => e.type));
      assert.ok(types[0].length >= 2, 'the flow published events');
      for (const t of types.slice(1)) {
        assert.deepStrictEqual(t, types[0]);
      }
    },
  }),
  defineCase({
    name: 'A21 SR-11 login and impersonation are audited by default',
    facet: 'A21/core',
    needs: ['service', 'seed', 'events'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password), { ip: IP_B }));
      const e = h.events.all().find((x) => x.type === 'login' && x.outcome === 'success');
      assert.ok(e, 'a login success event');
      assert.deepStrictEqual(e.identity, a);
      assert.strictEqual(e.ip, IP_B);
      assert.ok(
        h.events.all().some((x) => x.type === 'session.issue'),
        'a session.issue event',
      );
    },
  }),
  defineCase({
    name: 'A21 events never carry passwords, secrets or raw session ids',
    facet: 'A21/core',
    needs: ['service', 'seed', 'events', 'mfa'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await auth(h, k, pw(ALICE.login, WRONG));
      await h.mfa.enrol(a);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r);
      const code = await h.mfa.code(a);
      const s = await h.service.completeMfa(r.pending, h.mfa.step.name, code, k.ctx());
      expectSuccess(s);
      assert.ok(s.session, 'completeMfa returns the session');
      const json = JSON.stringify(h.events.all());
      for (const [what, secret] of [
        ['the password', ALICE.password],
        ['the wrong password', WRONG],
        ['the MFA code', code],
        ['the pending session id', r.pending.id],
        ['the active session id', s.session.id],
      ] as const) {
        assert.ok(!json.includes(secret), `${what} appears in the events`);
      }
    },
  }),
  defineCase({
    name: 'A21 the session field is the listed handle',
    facet: 'A21/core',
    needs: ['service', 'seed', 'events', 'sessions'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session, 'an interactive login issues a session');
      const e = h.events.all().filter((x) => x.type === 'session.issue')[0];
      assert.ok(e, 'a session.issue event');
      const listed = (await h.sessions.list(a, { current: r.session })).find((x) => x.current);
      assert.ok(listed, 'the current session is listed');
      assert.strictEqual(e.session, listed.handle);
      assert.ok(e.session !== r.session.id, 'the event holds no raw id');
    },
  }),
  defineCase({
    name: 'A21 SR-19 failed logins log no login string',
    facet: 'A21/core',
    needs: ['service', 'seed', 'logs'],
    async run(h, k) {
      await seedUser(h, ALICE);
      await auth(h, k, pw(ALICE.login, WRONG));
      await auth(h, k, pw(NOBODY, WRONG));
      const lines = h.logs.lines();
      assert.ok(lines.length > 0, 'the log sink wrote lines');
      for (const line of lines) {
        assert.ok(!line.includes(ALICE.login) && !line.includes(NOBODY), `a log line holds a login string: ${line}`);
      }
    },
  }),
]);
