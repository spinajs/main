import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { DI } from '@spinajs/di';
import { DefaultQueueService } from '@spinajs/queue';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn-http';
import { User } from '@spinajs/users';

import { Users } from '../../src/admin/controllers/Users/Users.js';
import { Security } from '../../src/admin/controllers/Users/Security.js';
import { startUsersHttpApp, stopUsersHttpApp } from '../support/http-app.js';
import type { HttpClient, Res, RoleDefs, UsersHttpApp } from '../support/http-app.js';
import { ACCOUNT_PASSWORD, REAUTH_STRATEGIES } from '../support/reauth-strategy.js';

const HOUR_MS = 60 * 60 * 1000;

type Lifecycle = 'deactivate' | 'ban' | 'delete';

/**
 * Deactivate, ban and delete end every session of the target and keep it out (review C2b-final, I1): besides
 * `users:delete` they need what authn-http's `DELETE /authn/admin/users/:uuid/sessions` needs, fresh authentication and
 * authn's CredentialAdminGuard (action `sessions`; users': `users:credentials`, the target covered, no protected role),
 * asked in that order before the AccountGuard and any write.
 */
describe('users-http v3: deactivate, ban and delete ask fresh auth and the credential admin guard', function () {
  this.timeout(120000);

  let app: UsersHttpApp;
  let closer: User;
  let lowerAdmin: User;
  let protectedAdmin: User;
  let seniorAdmin: User;
  let seq = 0;

  before(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    app = await startUsersHttpApp({
      controllers: [Users, Security],
      roles: (shipped: RoleDefs): RoleDefs => ({
        ...shipped,
        member: {},
        closer: { grants: ['users:read', 'users:update', 'users:delete', 'users:credentials'] },
        // Closes accounts, without the credential admin right.
        'lower-admin': { grants: ['users:read', 'users:update', 'users:delete'] },
        // Holds more than closer: closer does not cover it.
        'senior-admin': { grants: ['users:read', 'users:create', 'users:update', 'users:delete', 'users:credentials'] },
      }),
      config: { 'authn.strategies': REAUTH_STRATEGIES },
    });

    closer = await app.seedUser({ login: 'closer', roles: ['closer'] });
    lowerAdmin = await app.seedUser({ login: 'lower-admin', roles: ['lower-admin'] });
    protectedAdmin = await app.seedUser({ login: 'protected-admin', roles: ['admin'] });
    seniorAdmin = await app.seedUser({ login: 'senior-admin', roles: ['senior-admin'] });
  });

  after(async () => {
    await stopUsersHttpApp();
    sinon.restore();
  });

  const member = () => app.seedUser({ login: `lifecycle-member-${++seq}`, roles: ['member'] });
  const stored = (uuid: string) => User.query().withDeleted().where('Uuid', uuid).populate('Metadata').firstOrFail() as Promise<User>;
  const liveSessions = async (uuid: string) => (await ((await DI.resolve(SessionIssuer)) as SessionIssuer).list({ type: 'user', id: uuid })).length;

  const run = (client: HttpClient, action: Lifecycle, uuid: string, body: Record<string, unknown> = {}): Promise<Res> => {
    switch (action) {
      case 'deactivate':
        return client.post(`/users/security/deactivate/${uuid}`, body);
      case 'ban':
        return client.post(`/users/security/ban/${uuid}`, { reason: 'test', ...body });
      case 'delete':
        return client.del(`/users/${uuid}`, body);
    }
  };

  /** `t` still in service, with the session it had. */
  async function untouched(t: User): Promise<void> {
    const now = await stored(t.Uuid);
    expect(now.DeletedAt, 'deleted').to.not.be.ok;
    expect(now.IsActive, 'active').to.eq(true);
    expect(now.IsBanned, 'banned').to.eq(false);
    expect(await liveSessions(t.Uuid), 'live sessions').to.eq(1);
  }

  async function outOfService(t: User, action: Lifecycle): Promise<void> {
    const now = await stored(t.Uuid);
    if (action === 'deactivate') expect(now.IsActive).to.eq(false);
    if (action === 'ban') expect(now.IsBanned).to.eq(true);
    if (action === 'delete') expect(now.DeletedAt).to.be.ok;
    expect(await liveSessions(t.Uuid), 'live sessions').to.eq(0);
  }

  for (const action of ['deactivate', 'ban', 'delete'] as const) {
    describe(action, () => {
      it('lets a covering credential admin take a member out of service, ending its sessions', async () => {
        const t = await member();
        await app.signIn(t.Uuid);

        const res = await run(await app.signIn(closer.Uuid), action, t.Uuid);

        expect(res.status, res.text).to.eq(200);
        await outOfService(t, action);
      });

      it('refuses a users:delete holder without users:credentials (403 forbidden); nothing is written', async () => {
        const t = await member();
        await app.signIn(t.Uuid);

        const res = await run(await app.signIn(lowerAdmin.Uuid), action, t.Uuid);

        expect(res.status, res.text).to.eq(403);
        expect(res.body.error, res.text).to.eq('forbidden');
        await untouched(t);
      });

      it('refuses a lower admin on a protected admin (403 protected_role), who stays in service', async () => {
        await app.signIn(protectedAdmin.Uuid);
        const before = await liveSessions(protectedAdmin.Uuid);

        for (const caller of [lowerAdmin, closer]) {
          const res = await run(await app.signIn(caller.Uuid), action, protectedAdmin.Uuid);
          expect(res.status, res.text).to.eq(403);
          expect(res.body.error, res.text).to.eq(caller === closer ? 'protected_role' : 'forbidden');
        }

        const now = await stored(protectedAdmin.Uuid);
        expect(now.DeletedAt).to.not.be.ok;
        expect(now.IsActive).to.eq(true);
        expect(now.IsBanned).to.eq(false);
        expect(await liveSessions(protectedAdmin.Uuid)).to.eq(before);
      });

      it('refuses a target holding rights the caller does not hold (403 escalation)', async () => {
        await app.signIn(seniorAdmin.Uuid);
        const before = await liveSessions(seniorAdmin.Uuid);

        const res = await run(await app.signIn(closer.Uuid), action, seniorAdmin.Uuid);

        expect(res.status, res.text).to.eq(403);
        expect(res.body.error, res.text).to.eq('escalation');
        const now = await stored(seniorAdmin.Uuid);
        expect(now.DeletedAt).to.not.be.ok;
        expect(now.IsActive).to.eq(true);
        expect(now.IsBanned).to.eq(false);
        expect(await liveSessions(seniorAdmin.Uuid)).to.eq(before);
      });

      it("refuses the caller's own account through the guard (403 forbidden), before the account guard", async () => {
        const own = await app.signIn(closer.Uuid);
        const before = await liveSessions(closer.Uuid);

        const res = await run(own, action, closer.Uuid);

        expect(res.status, res.text).to.eq(403);
        expect(res.body.error, res.text).to.eq('forbidden');
        expect(res.text).to.not.contain('your own account');
        const now = await stored(closer.Uuid);
        expect(now.DeletedAt).to.not.be.ok;
        expect(now.IsActive).to.eq(true);
        expect(now.IsBanned).to.eq(false);
        expect(await liveSessions(closer.Uuid)).to.eq(before);
      });

      it('needs fresh authentication first: a stale session gets 403 fresh_auth_required, even where the guard refuses', async () => {
        const t = await member();
        await app.signIn(t.Uuid);

        for (const caller of [closer, lowerAdmin]) {
          const stale = await app.signIn(caller.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });
          const res = await run(stale, action, t.Uuid);
          expect(res.status, res.text).to.eq(403);
          expect(res.body.error, res.text).to.eq('fresh_auth_required');
        }
        await untouched(t);
      });

      it('answers a stale session with a wrong reauthPassword the login failure 401, and writes nothing', async () => {
        const t = await member();
        await app.signIn(t.Uuid);
        const stale = await app.signIn(closer.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });

        const res = await run(stale, action, t.Uuid, { reauthPassword: 'wrong-' + ACCOUNT_PASSWORD });

        expect(res.status, res.text).to.eq(401);
        expect(res.body).to.deep.eq(JSON.parse(JSON.stringify(AUTHN_FAILURE_BODY)));
        await untouched(t);
      });

      it('lets a stale session re-authenticate with reauthPassword', async () => {
        const t = await member();
        await app.signIn(t.Uuid);
        const stale = await app.signIn(closer.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });

        const res = await run(stale, action, t.Uuid, { reauthPassword: ACCOUNT_PASSWORD });

        expect(res.status, res.text).to.eq(200);
        await outOfService(t, action);
      });

      it('answers 403 impersonating to an impersonation session', async () => {
        const t = await member();
        await app.signIn(t.Uuid);
        const impersonating = await app.signIn(closer.Uuid, { impersonator: { type: 'user', id: protectedAdmin.Uuid } });

        const res = await run(impersonating, action, t.Uuid);

        expect(res.status, res.text).to.eq(403);
        expect(res.body.error, res.text).to.eq('impersonating');
        await untouched(t);
      });
    });
  }

  it('leaves activate, unban and restore as they were: they give access back, so they need no credential admin right', async () => {
    const t = await member();
    const admin = await app.signIn(closer.Uuid);
    expect((await run(admin, 'deactivate', t.Uuid)).status).to.eq(200);
    expect((await run(admin, 'ban', t.Uuid)).status).to.eq(200);
    expect((await run(admin, 'delete', t.Uuid)).status).to.eq(200);

    const lower = await app.signIn(lowerAdmin.Uuid, { authenticatedAt: new Date(Date.now() - HOUR_MS) });
    for (const res of [await lower.patch(`/users/${t.Uuid}/restore`), await lower.post(`/users/security/activate/${t.Uuid}`), await lower.post(`/users/security/unban/${t.Uuid}`)]) {
      expect(res.status, res.text).to.eq(200);
    }
    const now = await stored(t.Uuid);
    expect(now.DeletedAt).to.not.be.ok;
    expect(now.IsActive).to.eq(true);
    expect(now.IsBanned).to.eq(false);
  });
});
