import { expect } from 'chai';
import { DI } from '@spinajs/di';

import { AUTHN_FAILURE_BODY } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, V3AppResponseExtension, config, loggedIn, loggedInAal2, resetRecorders, seedUser, step, throttle } from '../app.js';
import type { KitUser } from '../app.js';

const probe = async (c: Client) => (await c.get(`/${AUTHN_PROBE_PATH}`)).body;

async function pending(u: KitUser): Promise<Client> {
  step.enrol(u.ref);
  const c = new Client();
  const res = await c.post('/auth/login', { login: u.login, password: u.password }, { 'User-Agent': 'v3-app-mfa' });
  expect(res.status).to.eq(200);
  expect(res.body).to.deep.eq({ MfaRequired: ['totp'] });
  return c;
}

/** DefaultMfaPolicy reads authn.mfa.policy.force when built, and DefaultAuthnService keeps the policy it resolved. */
async function setForce(on: boolean): Promise<void> {
  config().set('authn.mfa.policy.force', on);
  const { DefaultAuthnService, DefaultMfaPolicy } = await import('@spinajs/authn');
  DI.uncache(DefaultMfaPolicy);
  DI.uncache(DefaultAuthnService);
}

export function mfaSuite(): void {
  beforeEach(resetRecorders);

  it('release gate (N8a-D8): an MFA-enrolled user never logs in with the password alone', async () => {
    const u = await seedUser();
    const c = await pending(u);
    expect(c.cookie, 'the pending session cookie').to.not.eq(null);
    expect((await probe(c)).principal, 'a pending session yields no principal').to.eq(null);
    expect((await c.get('/user/sessions')).status).to.eq(401);
    const other = await seedUser();
    const imp = await c.post('/auth/impersonate', { target: other.ref.id, password: u.password });
    expect(imp.status, 'SR-07 pending session cannot impersonate').to.be.oneOf([401, 403]);
    expect((await c.post('/auth/active-role', { role: 'editor' })).status, 'a pending session cannot switch role').to.be.oneOf([401, 403]);
    expect((await probe(c)).principal).to.eq(null);
  });

  it('A09 verify: elevates to aal2, rotates the id, keeps the stored client data, answers the mfa extensions', async () => {
    const u = await seedUser();
    const c = await pending(u);
    const before = c.cookie;
    resetRecorders();
    const res = await c.post('/auth/mfa/verify', { code: step.nextCode(u.ref) });
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(c.cookie).to.not.eq(before);
    expect(res.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
    expect(res.body.Authn).to.include({ assurance: 'aal2' });
    expect(res.body.Access).to.include({ kind: 'mfa' });
    expect(V3AppResponseExtension.calls.map((x) => x.kind)).to.deep.eq(['mfa']);

    const p = (await probe(c)).principal;
    expect(p.id).to.eq(u.ref.id);
    expect(p.authn).to.include({ assurance: 'aal2' });
    expect(p.authn.mfa).to.deep.eq(['totp']);
    expect((await new Client(before!).get('/auth')).status, 'the pending id is dead').to.eq(401);
    const [row] = (await c.get('/user/sessions')).body;
    expect(row).to.include({ UserAgent: 'v3-app-mfa', Current: true });
    expect(row.Ip).to.be.a('string');
  });

  it('passes ctx purpose login with the pending session to completeMfa (counted in the mfa flow)', async () => {
    const u = await seedUser();
    const c = await pending(u);
    resetRecorders();
    await c.post('/auth/mfa/verify', { code: step.nextCode(u.ref) });
    const mfa = throttle.attempts.filter((a) => a.flow === 'mfa');
    expect(mfa).to.have.length(1);
    expect(mfa[0].ctx.purpose).to.eq('login');
    expect(mfa[0].ctx.ip).to.be.a('string');
    expect(mfa[0].ctx.session?.state).to.eq('pending');
  });

  it('a wrong code answers the one failure body and the session stays pending', async () => {
    const u = await seedUser();
    const c = await pending(u);
    const before = c.cookie;
    const res = await c.post('/auth/mfa/verify', { code: '000000x' });
    expect(res.status).to.eq(401);
    expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
    expect(res.headers['retry-after']).to.eq(undefined);
    expect(c.cookie).to.eq(before);
    expect((await c.get('/auth')).body).to.deep.eq({ MfaRequired: ['totp'] });
  });

  it('a code that is not a string, empty or over 1024 characters fails without reaching the step', async () => {
    const u = await seedUser();
    const c = await pending(u);
    const calls = step.verifyCalls.length;
    for (const code of [undefined, '', 42, ['1'], 'x'.repeat(1025)]) {
      const res = await c.post('/auth/mfa/verify', { code });
      expect(res.status, JSON.stringify(code)).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
    }
    expect(step.verifyCalls.length).to.eq(calls);
  });

  it('a throttled completion answers the one failure body with Retry-After', async () => {
    const u = await seedUser();
    const c = await pending(u);
    throttle.refuse(5);
    const res = await c.post('/auth/mfa/verify', { code: step.nextCode(u.ref) });
    expect(res.status).to.eq(401);
    expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
    expect(res.headers['retry-after']).to.eq('5');
  });

  it('takes the step from the body when it is a pending step, else the first pending step', async () => {
    const u = await seedUser();
    const c = await pending(u);
    expect((await c.post('/auth/mfa/verify', { code: step.nextCode(u.ref), step: 'no-such-step' })).status).to.eq(200);
    const v = await seedUser();
    const d = await pending(v);
    expect((await d.post('/auth/mfa/verify', { code: step.nextCode(v.ref), step: 'totp' })).status).to.eq(200);
  });

  it('a recovery code completes the login once (A10)', async () => {
    const u = await seedUser();
    const c = await pending(u);
    const [code] = await step.regenerateRecoveryCodes!(u.ref);
    const before = c.cookie;
    const res = await c.post('/auth/mfa/recovery', { code });
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(c.cookie).to.not.eq(before);
    expect((await probe(c)).principal.authn.assurance).to.eq('aal2');

    const again = await pending(u);
    const reuse = await again.post('/auth/mfa/recovery', { code });
    expect(reuse.status).to.eq(401);
    expect(reuse.body).to.deep.eq(AUTHN_FAILURE_BODY);
  });

  it('the MFA routes take only a pending session: none 401, active 403', async () => {
    for (const path of ['/auth/mfa/verify', '/auth/mfa/recovery']) {
      expect((await new Client().post(path, { code: '123456' })).status, path).to.eq(401);
      const active = await loggedIn(await seedUser());
      const res = await active.post(path, { code: '123456' });
      expect(res.status, path).to.eq(403);
      expect(res.body.error).to.eq('mfa_not_pending');
    }
  });

  describe('under authn.mfa.policy.force', () => {
    before(() => setForce(true));
    after(() => setForce(false));

    it('a user enrolled in no step gets a pending session that reaches the enrolment routes and nothing else', async () => {
      const u = await seedUser();
      const c = new Client();
      const login = await c.post('/auth/login', { login: u.login, password: u.password });
      expect(login.status).to.eq(200);
      expect(login.body).to.deep.eq({ MfaRequired: ['totp'] });
      const enrol = await c.post('/v3-app-enrol-stub');
      expect(enrol.status, JSON.stringify(enrol.body)).to.eq(200);
      expect(enrol.body.identity).to.deep.eq({ type: 'user', id: u.ref.id });
      expect((await c.get('/user/sessions')).status).to.eq(401);
      expect((await probe(c)).principal).to.eq(null);
    });

    it('a pending session of an enrolled user does not reach the enrolment routes', async () => {
      const u = await seedUser();
      const c = await pending(u);
      expect((await c.post('/v3-app-enrol-stub')).status).to.be.oneOf([401, 403]);
    });

    it('an active session reaches the enrolment stub through Authenticated; an anonymous caller does not', async () => {
      expect((await new Client().post('/v3-app-enrol-stub')).status).to.eq(401);
      const active = await loggedInAal2(await seedUser());
      expect((await active.post('/v3-app-enrol-stub')).status).to.eq(200);
    });
  });

  it('without force, a user enrolled in no step logs in with no MFA and the pending-only enrolment window stays shut', async () => {
    const u = await seedUser();
    const c = await loggedIn(u);
    expect((await probe(c)).principal.id).to.eq(u.ref.id);
    expect((await c.post('/v3-app-enrol-stub')).status, 'an active session passes through Authenticated').to.eq(200);
  });
}
