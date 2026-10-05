import { expect } from 'chai';
import sinon from 'sinon';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';

import { AUTHN_FAILURE_BODY } from '../../../src/v3/index.js';
import { AUTHN_PROBE_PATH } from '../../v3/probe.js';
import { Client, V3AppResponseExtension, loggedIn, loggedInAal2, resetRecorders, roles, seedUser, step, throttle, tokens } from '../app.js';
import type { KitUser } from '../app.js';

const probe = async (c: Client) => (await c.get(`/${AUTHN_PROBE_PATH}`)).body;

async function withRoles(): Promise<{ u: KitUser; c: Client }> {
  const u = await seedUser();
  await roles.grant(u.ref, [
    { role: 'editor', requirePassword: false },
    { role: 'root', requirePassword: true },
  ]);
  return { u, c: await loggedIn(u) };
}

/** Runs `fn` with Date (only) `seconds` ahead, on both sides of the wire: one process. */
async function later<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
  const clock = sinon.useFakeTimers({ now: Date.now() + seconds * 1000, toFake: ['Date'] });
  try {
    return await fn();
  } finally {
    clock.restore();
  }
}

const reauthAttempts = () => throttle.attempts.filter((a) => a.flow === 'reauth');

export function activeRoleSuite(): void {
  beforeEach(resetRecorders);

  it('GET /auth/active-role: the current role (none yet) and the roles RoleSource gives', async () => {
    const { c } = await withRoles();
    const res = await c.get('/auth/active-role');
    expect(res.status).to.eq(200);
    expect(res.body).to.deep.eq({
      ActiveRole: null,
      Roles: [
        { role: 'editor', requirePassword: false },
        { role: 'root', requirePassword: true },
      ],
    });
  });

  it('A26 a held role: rotates the session, then sets ActiveRole; the ceiling and the role-switch extensions follow', async () => {
    const { u, c } = await withRoles();
    resetRecorders();
    const before = c.cookie!;
    const issuer = (await DI.resolve(SessionIssuer)) as SessionIssuer;
    const order: string[] = [];
    const rotate = sinon.stub(issuer, 'rotate').callsFake(async function (this: SessionIssuer, h) {
      order.push(`rotate ${h.id === new Client(before).sessionId}`);
      return rotate.wrappedMethod.call(this, h);
    });
    const set = sinon.stub(issuer, 'set').callsFake(async function (this: SessionIssuer, h, key, value) {
      order.push(`set ${key}=${String(value)} on the old id: ${h.id === new Client(before).sessionId}`);
      return set.wrappedMethod.call(this, h, key, value);
    });
    let res;
    try {
      res = await c.post('/auth/active-role', { role: 'editor' });
    } finally {
      rotate.restore();
      set.restore();
    }
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(order).to.deep.eq(['rotate true', 'set ActiveRole=editor on the old id: false']);
    expect(c.cookie).to.not.eq(before);
    expect((await new Client(before).get('/auth')).status, 'the old cookie is dead').to.eq(401);
    expect(res.body.ActiveRole).to.eq('editor');
    expect(res.body.Identity).to.deep.eq({ type: 'user', id: u.ref.id });
    expect(res.body.Access).to.deep.eq({ kind: 'role-switch', id: u.ref.id, roles: ['editor'] });
    expect(V3AppResponseExtension.calls.map((x) => x.kind)).to.deep.eq(['role-switch']);
    expect((await probe(c)).principal.ceiling).to.deep.eq({ roles: ['editor'] });
    expect((await c.get('/auth/active-role')).body.ActiveRole).to.eq('editor');
  });

  it('switches back from a narrowed role: the roles held come from RoleSource, not from the ceiling', async () => {
    const { c } = await withRoles();
    expect((await c.post('/auth/active-role', { role: 'editor' })).status).to.eq(200);
    expect((await c.post('/auth/active-role', { role: 'root' })).status, 'root needs fresh auth, which a new login has').to.eq(200);
    expect((await probe(c)).principal.ceiling).to.deep.eq({ roles: ['root'] });
  });

  it('a role the principal does not hold is refused 403 role_not_held and changes nothing', async () => {
    const { c } = await withRoles();
    const before = c.cookie;
    const res = await c.post('/auth/active-role', { role: 'admin' });
    expect(res.status).to.eq(403);
    expect(res.body.error).to.eq('role_not_held');
    expect(c.cookie).to.eq(before);
    expect((await probe(c)).principal.ceiling).to.eq(undefined);
  });

  it('a role that is not a non-empty string is 400', async () => {
    const { c } = await withRoles();
    for (const role of [undefined, '', 42, ['editor'], 'r'.repeat(257)]) {
      expect((await c.post('/auth/active-role', { role })).status, JSON.stringify(role)).to.eq(400);
    }
  });

  it('accepts the 2.x field names Role and Password', async () => {
    const { u, c } = await withRoles();
    const res = await later(301, () => c.post('/auth/active-role', { Role: 'root', Password: u.password }));
    expect(res.status, JSON.stringify(res.body)).to.eq(200);
    expect(res.body.ActiveRole).to.eq('root');
  });

  describe('A26 a requirePassword role needs fresh auth (A13, SR-20)', () => {
    it('a fresh session switches without a password and verifies nothing', async () => {
      const { c } = await withRoles();
      expect((await c.post('/auth/active-role', { role: 'root' })).status).to.eq(200);
      expect(reauthAttempts()).to.have.length(0);
    });

    it('a stale session without a password is refused 403 fresh_auth_required', async () => {
      const { c } = await withRoles();
      const res = await later(301, () => c.post('/auth/active-role', { role: 'root' }));
      expect(res.status).to.eq(403);
      expect(res.body.error).to.eq('fresh_auth_required');
      expect(reauthAttempts()).to.have.length(0);
      expect((await probe(c)).principal.ceiling).to.eq(undefined);
    });

    it('a stale session switches with the right password, counted in the reauth flow', async () => {
      const { u, c } = await withRoles();
      const res = await later(301, () => c.post('/auth/active-role', { role: 'root', password: u.password }));
      expect(res.status, JSON.stringify(res.body)).to.eq(200);
      expect(reauthAttempts()).to.have.length(1);
      expect(reauthAttempts()[0].ctx.purpose).to.eq('reauth');
    });

    it('a wrong password answers the login failure body, no Retry-After, counted in the reauth flow', async () => {
      const { c } = await withRoles();
      const res = await later(301, () => c.post('/auth/active-role', { role: 'root', password: 'Wrong-Pass-9876' }));
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
      expect(res.headers['retry-after']).to.eq(undefined);
      expect(reauthAttempts()).to.have.length(1);
      expect(throttle.succeeds.filter((x) => x.flow === 'reauth')).to.have.length(0);
    });

    it('a throttled re-authentication answers the same 401 and no Retry-After', async () => {
      const { u, c } = await withRoles();
      throttle.refuse(30);
      const res = await later(301, () => c.post('/auth/active-role', { role: 'root', password: u.password }));
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
      expect(res.headers['retry-after']).to.eq(undefined);
    });

    it("another account's password never counts as fresh auth", async () => {
      const { c } = await withRoles();
      const other = await seedUser();
      const res = await later(301, () => c.post('/auth/active-role', { role: 'root', password: other.password }));
      expect(res.status).to.eq(401);
      expect(res.body).to.deep.eq(AUTHN_FAILURE_BODY);
    });

    it('a RoleSource answer without a boolean requirePassword counts as true (fail safe, N8a-D9)', async () => {
      const u = await seedUser();
      await roles.grant(u.ref, [{ role: 'vague', requirePassword: undefined as unknown as boolean }]);
      const c = await loggedIn(u);
      const res = await later(301, () => c.post('/auth/active-role', { role: 'vague' }));
      expect(res.status).to.eq(403);
      expect(res.body.error).to.eq('fresh_auth_required');
    });

    it('a role without requirePassword switches on a stale session with no password', async () => {
      const { c } = await withRoles();
      expect((await later(301, () => c.post('/auth/active-role', { role: 'editor' }))).status).to.eq(200);
    });
  });

  it('a pending session, an impersonation and a per-request credential cannot switch', async () => {
    const p = await seedUser();
    step.enrol(p.ref);
    const pending = new Client();
    await pending.post('/auth/login', { login: p.login, password: p.password });
    expect((await pending.post('/auth/active-role', { role: 'editor' })).status).to.eq(401);

    const admin = await seedUser();
    const target = await seedUser();
    await roles.grant(target.ref, [{ role: 'editor', requirePassword: false }]);
    const c = await loggedInAal2(admin);
    expect((await c.post('/auth/impersonate', { target: target.ref.id })).status).to.eq(200);
    const imp = await c.post('/auth/active-role', { role: 'editor' });
    expect(imp.status).to.eq(403);
    expect(imp.body.error).to.eq('impersonating');

    const token = `spt_${randomUUID()}`;
    tokens.set(token, target.ref);
    const byToken = await new Client().post('/auth/active-role', { role: 'editor' }, { Authorization: `Bearer ${token}` });
    expect(byToken.status).to.eq(403);
    expect(byToken.body.error).to.eq('session_required');
  });
}
