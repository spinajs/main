import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzConfigError, AuthzDomains, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal, ResourceRef } from '@spinajs/authz';
import { ImpersonationGuard, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';

import { AuthzImpersonationGuard, AuthzTargetGuard, UserPrincipalFactory } from '../src/index.js';
import { rootAdmin } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, seedUser, setIdentityFlags } from './support/users-db.js';

chai.use(chaiAsPromised);

const FACTS: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date('2026-10-01T10:00:00Z'), sessionHandle: 'h-actor' };

const PERMISSIONS = ['doc:read', 'doc:write', 'users:credentials'];

const ROLES: Record<string, object> = {
  support: { grants: ['user:impersonate', 'users:read', 'users:update', 'doc:read', 'doc:write'] },
  member: { grants: ['doc:read'] },
  'support.peer': { grants: ['user:impersonate', 'users:read', 'users:update', 'doc:read', 'doc:write'] },
  auditor: { grants: ['users:credentials'] },
  superadmin: { extends: ['admin'] },
  // SR-10: both hold credential-admin rights, the helpdesk a strictly smaller set.
  helpdesk: { grants: ['users:read', 'users:credentials'] },
  useradmin: { grants: ['users:read', 'users:update', 'users:credentials'] },
};

function configure(config: Configuration): void {
  for (const p of PERMISSIONS) {
    config.set(['authz', 'permissions', p], {});
  }
  for (const [name, def] of Object.entries(ROLES)) {
    config.set(['authz', 'rbac', 'roles', name], def);
  }
}

async function grantAt(ref: IdentityRef, role: string, scope: ResourceRef = GLOBAL): Promise<void> {
  const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject: { type: ref.type, id: ref.id }, role, scope }];
  const results = await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test' });
  expect(results.every((r) => r.ok), JSON.stringify(results)).to.eq(true);
}

let seq = 0;

/** A new active user holding `roles` at GLOBAL. */
async function user(...roles: string[]): Promise<IdentityRef> {
  const { ref } = await seedUser({ login: `imp-${++seq}` });
  for (const role of roles) {
    await grantAt(ref, role);
  }
  return ref;
}

async function signedIn(ref: IdentityRef, facts: AuthnFacts = FACTS): Promise<Principal> {
  return new UserPrincipalFactory().principalOf(ref, facts, {});
}

/** Records what the guard asks the PrincipalFactory for. */
class RecordingFactory extends PrincipalFactory {
  public readonly calls: { id: IdentityRef; facts: AuthnFacts; extra: object; principal?: Principal }[] = [];

  constructor(private readonly inner: PrincipalFactory = new UserPrincipalFactory()) {
    super();
  }

  public async principalOf(id: IdentityRef, facts: AuthnFacts, extra: Parameters<PrincipalFactory['principalOf']>[2]): Promise<Principal> {
    const call: (typeof this.calls)[number] = { id, facts, extra };
    this.calls.push(call);
    call.principal = await this.inner.principalOf(id, facts, extra);
    return call.principal;
  }
}

class FailingFactory extends PrincipalFactory {
  public async principalOf(): Promise<Principal> {
    throw new Error('identity store down');
  }
}

describe('AuthzImpersonationGuard (users DB, root authz host)', function () {
  this.timeout(30000);

  let guard: AuthzImpersonationGuard;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
    guard = new AuthzImpersonationGuard();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is the ImpersonationGuard DI resolves', async () => {
    expect(await DI.resolve(ImpersonationGuard)).to.be.instanceOf(AuthzImpersonationGuard);
  });

  it('allows a holder of user:impersonate whose set strictly contains the target’s', async () => {
    const actor = await signedIn(await user('support'));

    expect(await guard.allowed(actor, await user('member'))).to.deep.eq({ ok: true });
    expect(await guard.allowed(actor, await user())).to.deep.eq({ ok: true });
  });

  it('builds the target as the session will carry it: the actor’s authn facts, impersonator set, no ceiling', async () => {
    const factory = new RecordingFactory();
    const actorRef = await user('support');
    const actor = await signedIn(actorRef);
    const target = await user('member');

    expect(await new AuthzImpersonationGuard({ principals: factory }).allowed(actor, target)).to.deep.eq({ ok: true });

    expect(factory.calls).to.have.length(1);
    const [call] = factory.calls;
    expect(call.id).to.deep.eq(target);
    expect(call.facts).to.deep.eq({ method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: FACTS.authenticatedAt, impersonator: { type: 'user', id: actorRef.id } });
    expect(call.extra).to.deep.eq({});
    expect(call.principal).to.not.have.property('ceiling');
  });

  describe('forbidden', () => {
    it('without user:impersonate at GLOBAL', async () => {
      const actor = await signedIn(await user('useradmin', 'member'));

      expect(await guard.allowed(actor, await user())).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for the actor itself', async () => {
      const ref = await user('support');

      expect(await guard.allowed(await signedIn(ref), ref)).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for an actor that is already impersonating', async () => {
      const impersonator = await user('support');
      const actor = await signedIn(await user('support'), { ...FACTS, impersonator: { type: 'user', id: impersonator.id } });

      expect(await guard.allowed(actor, await user('member'))).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for an actor that is not a signed-in user principal', async () => {
      const ref = await user('support');
      const target = await user('member');
      const signed = await signedIn(ref);
      const { authn: _authn, ...withoutFacts } = signed;

      expect(await guard.allowed({ ...signed, authenticated: false }, target)).to.deep.eq({ ok: false, code: 'forbidden' });
      expect(await guard.allowed(withoutFacts, target)).to.deep.eq({ ok: false, code: 'forbidden' });
      expect(await guard.allowed({ ...signed, type: 'service' }, target)).to.deep.eq({ ok: false, code: 'forbidden' });
      expect(await guard.allowed(SYSTEM, target)).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for a target that is not a user', async () => {
      const actor = await signedIn(await user('support'));

      expect(await guard.allowed(actor, { type: 'service', id: 'svc-1' })).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for a target that cannot act: unknown, inactive, banned, deleted', async () => {
      const actor = await signedIn(await user('support'));
      const inactive = await user('member');
      const banned = await user('member');
      const deleted = await user('member');
      await setIdentityFlags(inactive, { active: false });
      await setIdentityFlags(banned, { banned: true });
      await setIdentityFlags(deleted, { deleted: true });

      for (const target of [{ type: 'user', id: '00000000-0000-4000-8000-000000000000' }, inactive, banned, deleted]) {
        expect(await guard.allowed(actor, target), JSON.stringify(target)).to.deep.eq({ ok: false, code: 'forbidden' });
      }
    });
  });

  it('propagates a PrincipalFactory error other than "cannot act"', async () => {
    const actor = await signedIn(await user('support'));

    await expect(new AuthzImpersonationGuard({ principals: new FailingFactory() }).allowed(actor, await user('member'))).to.be.rejectedWith('identity store down');
  });

  describe('protected_role', () => {
    it('for a target holding a protected role at GLOBAL', async () => {
      const actor = await signedIn(await user('support', 'useradmin'));

      expect(await guard.allowed(actor, await user('admin'))).to.deep.eq({ ok: false, code: 'protected_role' });
    });

    it('for a target holding a protected role at a scope only', async () => {
      const actor = await signedIn(await user('support'));
      const target = await user('member');
      await grantAt(target, 'admin', { type: 'project', id: 'p1' });

      expect(await guard.allowed(actor, target)).to.deep.eq({ ok: false, code: 'protected_role' });
    });

    it('for a target holding a role that reaches a protected one through extends', async () => {
      const actor = await signedIn(await user('support'));

      expect(await guard.allowed(actor, await user('superadmin'))).to.deep.eq({ ok: false, code: 'protected_role' });
    });

    it('reads authz.impersonation.protectedRoles', async () => {
      const actor = await signedIn(await user('support'));
      const member = await user('member');
      (await DI.resolve(Configuration)).set(['authz', 'impersonation', 'protectedRoles'], ['member']);

      expect(await guard.allowed(actor, member)).to.deep.eq({ ok: false, code: 'protected_role' });
    });
  });

  describe('escalation', () => {
    it('for a target with a permission the actor lacks', async () => {
      const actor = await signedIn(await user('support'));

      expect(await guard.allowed(actor, await user('auditor'))).to.deep.eq({ ok: false, code: 'escalation' });
    });

    it('for a target with an equal set', async () => {
      const actor = await signedIn(await user('support'));

      expect(await guard.allowed(actor, await user('support.peer'))).to.deep.eq({ ok: false, code: 'escalation' });
    });
  });

  describe('the target rule (AuthzTargetGuard)', () => {
    it("SR-10 lower admin cannot reset a higher admin's password", async () => {
      // The rule only; the credential admin routes that apply it are N8b's.
      const rule = new AuthzTargetGuard();
      const lower = await signedIn(await user('helpdesk'));
      const higher = await signedIn(await user('useradmin'));
      const protectedHigher = await signedIn(await user('useradmin', 'admin'));

      expect(await rule.check(lower, higher)).to.deep.eq({ ok: false, code: 'escalation' });
      expect(await rule.check(lower, protectedHigher)).to.deep.eq({ ok: false, code: 'protected_role' });
      expect(await rule.check(higher, lower)).to.deep.eq({ ok: true });
    });

    it('fails closed when the access domain has no RbacService', async () => {
      const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
      const container = domains.create('c3-no-rbac');
      (await DI.resolve(Configuration)).set(['authz', 'http', 'access', 'domain'], 'c3-no-rbac');
      try {
        const actor = await signedIn(await user('useradmin'));
        const target = await signedIn(await user('helpdesk'));

        await expect(new AuthzTargetGuard().check(actor, target)).to.be.rejectedWith(AuthzConfigError, /RbacService/);
      } finally {
        await container.dispose();
      }
    });
  });
});
