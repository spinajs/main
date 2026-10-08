import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthnAudit } from '@spinajs/authn';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn-http';
import { User } from '@spinajs/users';

import { Security } from '../../src/admin/controllers/Users/Security.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { HttpClient, Res, RoleDefs, UsersHttpApp } from '../support/http-app.js';
import { ACCOUNT_PASSWORD, REAUTH_STRATEGIES } from '../support/reauth-strategy.js';

const SERVICE_TOKEN = 'sessions-svc-' + 'Rk3Wq8Tn'.repeat(4);
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';
const HOUR_MS = 60 * 60 * 1000;

/**
 * The admin session routes on the 3.0 SessionIssuer, with real sessions issued by it. Both routes need `@Access`
 * (decided on the addressed row), a session caller that is not impersonating, and authn's CredentialAdminGuard
 * (users' AuthzCredentialAdminGuard: `users:credentials`, the target covered, no protected role); the revoke also needs
 * fresh auth. The forced logout of all sessions is authn-http's `DELETE /authn/admin/users/:uuid/sessions`.
 */
describe('users-http v3: admin session routes on the SessionIssuer', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let sessionAdmin: User;
  let noCredentials: User;
  let selfCredentials: User;
  let protectedAdmin: User;
  let higherAdmin: User;
  let plain: User;
  let published: AuthnEvent[];
  let seq = 0;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [Security],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        member: {},
        'session-admin': { grants: ['users:read', 'users:update', 'users:credentials'] },
        // Holds more than session-admin: session-admin does not cover it.
        'senior-admin': { grants: ['users:read', 'users:update', 'users:delete', 'users:credentials'] },
        // Passes @Access on every row, but holds no credential admin right.
        'no-credentials': { grants: ['users:read', 'users:update'] },
        // The credential admin right, but users:read/update only on its own row.
        'self-credentials': { grants: [{ permission: 'users:read', relation: 'self' }, { permission: 'users:update', relation: 'self' }, 'users:credentials'] },
      }),
      config: {
        'authz.permissions.users:credentials': {},
        'authn.strategies': REAUTH_STRATEGIES,
        'authz.http.services': [{ name: 'sessions-svc', header: 'X-Service-Token', token: SERVICE_TOKEN }],
        'authz.rbac.serviceRoles': { 'service:sessions-svc': ['session-admin'] },
      },
    });

    sessionAdmin = await app.seedUser({ login: 'session-admin', roles: ['session-admin'] });
    noCredentials = await app.seedUser({ login: 'no-credentials', roles: ['no-credentials'] });
    selfCredentials = await app.seedUser({ login: 'self-credentials', roles: ['self-credentials'] });
    protectedAdmin = await app.seedUser({ login: 'protected-admin', roles: ['admin'] });
    higherAdmin = await app.seedUser({ login: 'senior-admin', roles: ['senior-admin'] });
    plain = await app.seedUser({ login: 'plain', roles: ['user'] });
  });

  beforeEach(() => {
    published = [];
    sinon.stub(AuthnAudit.prototype, 'publish').callsFake(async (e: AuthnEvent) => {
      published.push(e);
    });
  });

  afterEach(() => {
    (AuthnAudit.prototype.publish as sinon.SinonStub).restore();
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const issuer = async () => (await DI.resolve(SessionIssuer)) as SessionIssuer;
  const target = () => app.seedUser({ login: `session-target-${++seq}`, roles: ['member'] });
  const list = (client: HttpClient, uuid: string): Promise<Res> => client.get(`/users/security/sessions/${uuid}`);
  const revoke = (client: HttpClient, uuid: string, handle: string, body?: unknown): Promise<Res> => client.del(`/users/security/sessions/${uuid}/${encodeURIComponent(handle)}`, body);

  /** The listed handle of the session `client` sends. */
  async function handleOf(uuid: string, client: HttpClient): Promise<string> {
    const rows = await (await issuer()).list({ type: 'user', id: uuid }, { current: client.session! });
    const row = rows.find((r) => r.current === true);
    if (!row) throw new Error('the client session is not live');
    return row.handle;
  }

  async function liveHandles(uuid: string): Promise<string[]> {
    return (await (await issuer()).list({ type: 'user', id: uuid })).map((r) => r.handle).sort();
  }

  /** A live member session answers 403 here (no users:read); an ended one 401 (no principal). */
  async function isLive(client: HttpClient, uuid: string): Promise<boolean> {
    const res = await list(client, uuid);
    if (res.status === 401) return false;
    expect(res.status, res.text).to.eq(403);
    return true;
  }

  describe('GET /users/security/sessions/:user', () => {
    it("lists the target's sessions newest first by handle, never by id, uncached", async () => {
      const t = await target();
      const first = await app.signIn(t.Uuid);
      await new Promise((r) => setTimeout(r, 5));
      const second = await app.signIn(t.Uuid);
      const admin = await app.signIn(sessionAdmin.Uuid);

      const res = await list(admin, t.Uuid);

      expect(res.status, res.text).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(res.body.map((e: { Handle: string }) => e.Handle)).to.deep.eq([await handleOf(t.Uuid, second), await handleOf(t.Uuid, first)]);
      for (const entry of res.body) {
        expect(Object.keys(entry).sort()).to.include.members(['Created', 'Handle', 'LastSeen']);
        expect(Object.keys(entry).every((k) => ['Handle', 'Created', 'LastSeen', 'Ip', 'UserAgent'].includes(k)), JSON.stringify(entry)).to.eq(true);
        expect(new Date(entry.Created).toISOString()).to.eq(entry.Created);
        expect(new Date(entry.LastSeen).toISOString()).to.eq(entry.LastSeen);
      }
      expect(res.text).to.not.contain(first.session!.id);
      expect(res.text).to.not.contain(second.session!.id);
    });

    it('answers an empty list for a user without sessions', async () => {
      const t = await target();

      const res = await list(await app.signIn(sessionAdmin.Uuid), t.Uuid);
      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.eq([]);
    });

    it('answers 404 for an unknown or deleted user', async () => {
      const admin = await app.signIn(sessionAdmin.Uuid);
      const gone = await target();
      await (await User.query().where('Uuid', gone.Uuid).firstOrFail()).destroy();

      expect((await list(admin, UNKNOWN_UUID)).status).to.eq(404);
      expect((await list(admin, gone.Uuid)).status).to.eq(404);
    });

    it('needs no fresh authentication', async () => {
      const t = await target();
      await app.signIn(t.Uuid);
      const stale = await app.signIn(sessionAdmin.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });

      const res = await list(stale, t.Uuid);
      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.have.length(1);
    });
  });

  describe('DELETE /users/security/sessions/:user/:handle', () => {
    it('ends exactly that session; its cookie then answers 401, the other session lives on', async () => {
      const t = await target();
      const first = await app.signIn(t.Uuid);
      const second = await app.signIn(t.Uuid);
      const admin = await app.signIn(sessionAdmin.Uuid);
      const handle = await handleOf(t.Uuid, first);

      const res = await revoke(admin, t.Uuid, handle);

      expect(res.status, res.text).to.eq(200);
      expect(res.headers['cache-control']).to.eq('no-store');
      expect(await isLive(first, t.Uuid)).to.eq(false);
      expect(await isLive(second, t.Uuid)).to.eq(true);
      expect(await liveHandles(t.Uuid)).to.deep.eq([await handleOf(t.Uuid, second)]);
    });

    it('audits the revoke with the admin as actor and the handle, never the session id', async () => {
      const t = await target();
      const victim = await app.signIn(t.Uuid);
      const admin = await app.signIn(sessionAdmin.Uuid);
      const handle = await handleOf(t.Uuid, victim);

      expect((await revoke(admin, t.Uuid, handle)).status).to.eq(200);

      const event = published.find((e) => e.type === 'session.revoke');
      expect(event, JSON.stringify(published)).to.exist;
      expect(event).to.deep.include({ outcome: 'success', reason: 'admin', identity: { type: 'user', id: t.Uuid }, actor: { type: 'user', id: sessionAdmin.Uuid }, session: handle });
      expect(JSON.stringify(published)).to.not.contain(victim.session!.id);
    });

    it("answers 404 session_not_found for another user's handle through this uuid, and ends nothing", async () => {
      const t = await target();
      const other = await target();
      const otherClient = await app.signIn(other.Uuid);
      await app.signIn(t.Uuid);
      const admin = await app.signIn(sessionAdmin.Uuid);
      const before = await liveHandles(t.Uuid);

      const res = await revoke(admin, t.Uuid, await handleOf(other.Uuid, otherClient));

      expect(res.status, res.text).to.eq(404);
      expect(res.body.error).to.eq('session_not_found');
      expect(await isLive(otherClient, other.Uuid)).to.eq(true);
      expect(await liveHandles(t.Uuid)).to.deep.eq(before);
    });

    it('answers 404 session_not_found for an unknown handle', async () => {
      const t = await target();
      await app.signIn(t.Uuid);

      const res = await revoke(await app.signIn(sessionAdmin.Uuid), t.Uuid, 'no-such-handle');
      expect(res.status, res.text).to.eq(404);
      expect(res.body.error).to.eq('session_not_found');
      expect(await liveHandles(t.Uuid)).to.have.length(1);
    });

    it('answers 404 for an unknown user', async () => {
      const res = await revoke(await app.signIn(sessionAdmin.Uuid), UNKNOWN_UUID, 'some-handle');
      expect(res.status, res.text).to.eq(404);
    });

    it('needs fresh authentication: a stale admin session gets 403 fresh_auth_required and ends nothing', async () => {
      const t = await target();
      const victim = await app.signIn(t.Uuid);
      const stale = await app.signIn(sessionAdmin.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });

      const res = await revoke(stale, t.Uuid, await handleOf(t.Uuid, victim));

      expect(res.status, res.text).to.eq(403);
      expect(res.body.error).to.eq('fresh_auth_required');
      expect(await isLive(victim, t.Uuid)).to.eq(true);
    });

    it('answers a stale admin session with a wrong reauthPassword the login failure 401, and ends nothing', async () => {
      const t = await target();
      const victim = await app.signIn(t.Uuid);
      const stale = await app.signIn(sessionAdmin.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });

      const res = await revoke(stale, t.Uuid, await handleOf(t.Uuid, victim), { reauthPassword: 'wrong-' + ACCOUNT_PASSWORD });

      expect(res.status, res.text).to.eq(401);
      expect(res.body).to.deep.eq(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY)));
      expect(await isLive(victim, t.Uuid)).to.eq(true);
    });

    it('lets a stale admin session re-authenticate with reauthPassword and end the session', async () => {
      const t = await target();
      const victim = await app.signIn(t.Uuid);
      const stale = await app.signIn(sessionAdmin.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });

      const res = await revoke(stale, t.Uuid, await handleOf(t.Uuid, victim), { reauthPassword: ACCOUNT_PASSWORD });

      expect(res.status, res.text).to.eq(200);
      expect(await isLive(victim, t.Uuid)).to.eq(false);
      expect(published.find((e) => e.type === 'reauth'), JSON.stringify(published)).to.deep.include({ outcome: 'success', identity: { type: 'user', id: sessionAdmin.Uuid } });
    });
  });

  it('serves no forced logout of all sessions any more: authn-http serves it with the credential admin guard', async () => {
    const t = await target();
    const victim = await app.signIn(t.Uuid);

    const res = await (await app.signIn(sessionAdmin.Uuid)).del(`/users/security/sessions/${t.Uuid}`);

    expect(res.status, res.text).to.eq(404);
    expect(await isLive(victim, t.Uuid)).to.eq(true);
  });

  describe('refusals: nothing is listed and nothing ends', () => {
    /** Calls both routes as `client` on `t` and expects `status` (and `error` when given) from each. */
    async function refused(client: HttpClient, t: User, status: number, error?: string): Promise<void> {
      const victim = await app.signIn(t.Uuid);
      const handle = await handleOf(t.Uuid, victim);

      for (const res of [await list(client, t.Uuid), await revoke(client, t.Uuid, handle)]) {
        expect(res.status, res.text).to.eq(status);
        if (error) expect(res.body.error, res.text).to.eq(error);
        expect(res.text).to.not.contain(handle);
      }
      expect(await isLive(victim, t.Uuid)).to.eq(true);
    }

    it('401 for an anonymous caller', async () => {
      await refused(app.anonymous(), await target(), 401);
    });

    it("403 for users' plain user role", async () => {
      await refused(await app.signIn(plain.Uuid), await target(), 403);
    });

    it('403 forbidden for a users:read/update holder without the credential admin right', async () => {
      await refused(await app.signIn(noCredentials.Uuid), await target(), 403, 'forbidden');
    });

    it("403 for a conditional (self) users:read/update holder on another user's row, credential right or not", async () => {
      await refused(await app.signIn(selfCredentials.Uuid), await target(), 403);
    });

    it('403 protected_role for a target holding a protected role', async () => {
      await refused(await app.signIn(sessionAdmin.Uuid), protectedAdmin, 403, 'protected_role');
    });

    it('403 escalation for a target holding rights the caller does not hold', async () => {
      await refused(await app.signIn(sessionAdmin.Uuid), higherAdmin, 403, 'escalation');
    });

    it('403 forbidden for the caller itself, its current session included: the owner uses /user/sessions', async () => {
      const own = await app.signIn(sessionAdmin.Uuid);
      const handle = await handleOf(sessionAdmin.Uuid, own);

      const listed = await list(own, sessionAdmin.Uuid);
      expect(listed.status, listed.text).to.eq(403);
      expect(listed.body.error).to.eq('forbidden');

      const res = await revoke(own, sessionAdmin.Uuid, handle);
      expect(res.status, res.text).to.eq(403);
      expect(res.body.error).to.eq('forbidden');
      expect(await liveHandles(sessionAdmin.Uuid)).to.include(handle);
    });

    it('403 impersonating for an admin session that impersonates', async () => {
      const t = await target();
      const victim = await app.signIn(t.Uuid);
      const impersonating = await app.signIn(sessionAdmin.Uuid, { impersonator: { type: 'user', id: protectedAdmin.Uuid } });

      for (const res of [await list(impersonating, t.Uuid), await revoke(impersonating, t.Uuid, await handleOf(t.Uuid, victim))]) {
        expect(res.status, res.text).to.eq(403);
        expect(res.body.error).to.eq('impersonating');
      }
      expect(await isLive(victim, t.Uuid)).to.eq(true);
    });

    it('401 for a service principal holding the same roles: no session caller', async () => {
      const t = await target();
      const victim = await app.signIn(t.Uuid);
      const headers = { 'X-Service-Token': SERVICE_TOKEN };

      expect((await app.anonymous().get(`/users/security/sessions/${t.Uuid}`, headers)).status).to.eq(401);
      expect((await app.anonymous().del(`/users/security/sessions/${t.Uuid}/${await handleOf(t.Uuid, victim)}`, undefined, headers)).status).to.eq(401);
      expect(await isLive(victim, t.Uuid)).to.eq(true);
    });
  });
});
