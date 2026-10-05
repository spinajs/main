import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand } from '@spinajs/authz';
import { ACTIVE_ROLE_KEY, AuthnImpersonationService, FreshAuthCheck } from '@spinajs/authn';
import { AuthnEventSink, SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { MemorySessionIssuer, RecordingEventSink } from '@spinajs/authn-testing';

import { rootAdmin } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, releaseUsersHost, seedUser } from './support/users-db.js';

const ROLES: Record<string, object> = {
  support: { grants: ['user:impersonate', 'users:read', 'users:update'] },
  useradmin: { grants: ['users:read', 'users:update', 'users:credentials'] },
  auditor: { grants: ['users:credentials'] },
};

function configure(config: Configuration): void {
  config.set(['authz', 'permissions', 'users:credentials'], {});
  for (const [name, def] of Object.entries(ROLES)) {
    config.set(['authz', 'rbac', 'roles', name], def);
  }
}

let seq = 0;

async function user(...roles: string[]): Promise<IdentityRef> {
  const { ref } = await seedUser({ login: `imp-switch-${++seq}` });
  for (const role of roles) {
    const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject: { type: ref.type, id: ref.id }, role, scope: GLOBAL }];
    const results = await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test' });
    expect(
      results.every((r) => r.ok),
      JSON.stringify(results),
    ).to.eq(true);
  }
  return ref;
}

const bind = (c: IContainer, base: object, name: string, value: unknown) => c.register({ [name]: () => value }[name]).as(base as never);

const facts = (): AuthnFacts => ({ method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date() });

const ctx = (): AuthnContext => ({ now: new Date(), ip: '192.0.2.10', purpose: 'login' });

// The real AuthnImpersonationService over the real AuthzImpersonationGuard and UserPrincipalFactory; the session store,
// fresh auth and the audit sink are the kit's (fresh auth is AuthnService's, which this host does not boot).
describe('impersonation by an actor narrowed by a role switch (users guard, authn service, D14)', function () {
  this.timeout(30000);

  let child: IContainer;
  let sessions: MemorySessionIssuer;
  let events: RecordingEventSink;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
    sessions = new MemorySessionIssuer();
    events = new RecordingEventSink();
    child = DI.RootContainer.child();
    bind(child, SessionIssuer, 'RoleSwitchTestSessions', sessions);
    bind(child, FreshAuthCheck, 'RoleSwitchTestFresh', { check: async () => true });
    bind(child, AuthnEventSink, 'RoleSwitchTestEvents', events);
  });

  afterEach(async () => {
    await child.dispose();
    sinon.restore();
    releaseUsersHost();
  });

  it('refuses an admin switched to a role that does not cover the target, and lets it start unswitched', async () => {
    const actor = await user('support', 'useradmin');
    const target = await user('auditor');
    const svc = await child.resolve(AuthnImpersonationService);

    const narrowed = await sessions.issue(actor, facts());
    await sessions.set(narrowed, ACTIVE_ROLE_KEY, 'support');
    expect(await svc.start(narrowed, target, ctx())).to.deep.eq({ ok: false });
    expect(await sessions.restore(narrowed.id), 'the actor session stays').to.not.eq(null);

    const own = await sessions.issue(actor, facts());
    const started = await svc.start(own, target, ctx());
    expect(started.ok).to.eq(true);

    expect(events.ofType('impersonation.start').map((e) => [e.outcome, e.reason])).to.deep.eq([
      ['failure', 'escalation'],
      ['success', undefined],
    ]);
  });
});
