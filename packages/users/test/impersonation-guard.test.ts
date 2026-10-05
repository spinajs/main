import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { ResourceNotFound } from '@spinajs/exceptions';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzConfigError, AuthzDomains, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AssignmentSubject, AuthzCommand, Principal, ResourceRef } from '@spinajs/authz';
import { ImpersonationGuard, PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, Ceiling, IdentityRef } from '@spinajs/authn/contracts';

import { AuthzImpersonationGuard, AuthzTargetGuard, PrincipalAttributeProvider, UserPrincipalFactory } from '../src/index.js';
import type { User } from '../src/index.js';
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
  'team.member': { subjectSet: true },
  projectowner: { implies: [{ role: 'admin', at: 'self-and-descendants' }] },
  // Ladder 'ops' (admin joins it in configure): each rank holds the grants of the ranks below it.
  opsmember: { ladder: 'ops', grants: ['doc:read'] },
  owner: { ladder: 'ops' },
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
  config.set(['authz', 'rbac', 'roles', 'admin', 'ladder'], 'ops');
  config.set(['authz', 'rbac', 'ladders', 'ops'], { roles: ['opsmember', 'admin', 'owner'] });
}

async function grantTo(subject: AssignmentSubject, role: string, scope: ResourceRef = GLOBAL): Promise<void> {
  const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject, role, scope }];
  const results = await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test' });
  expect(
    results.every((r) => r.ok),
    JSON.stringify(results),
  ).to.eq(true);
}

const grantAt = (ref: IdentityRef, role: string, scope: ResourceRef = GLOBAL) => grantTo({ type: ref.type, id: ref.id }, role, scope);

let seq = 0;

/** A new active user holding `roles` at GLOBAL. */
async function user(...roles: string[]): Promise<IdentityRef> {
  const { ref } = await seedUser({ login: `imp-${++seq}` });
  for (const role of roles) {
    await grantAt(ref, role);
  }
  return ref;
}

async function signedIn(ref: IdentityRef, facts: AuthnFacts = FACTS, ceiling?: Ceiling): Promise<Principal> {
  return new UserPrincipalFactory().principalOf(ref, facts, ceiling ? { ceiling } : {});
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

/** A store that answers every id with one user, as a case-insensitive match on the actor's own id would. */
class OneUserFactory extends PrincipalFactory {
  constructor(private readonly ref: IdentityRef) {
    super();
  }

  public principalOf(_id: IdentityRef, facts: AuthnFacts): Promise<Principal> {
    return new UserPrincipalFactory().principalOf(this.ref, facts, {});
  }
}

let probeAttributes = false;

class ProbeAttributeProvider extends PrincipalAttributeProvider {
  public async attributes(user: User): Promise<Readonly<Record<string, unknown>>> {
    return probeAttributes ? { probe: user.Login } : {};
  }
}

describe('AuthzImpersonationGuard (users DB, root authz host)', function () {
  this.timeout(30000);

  let guard: AuthzImpersonationGuard;

  before(() => {
    registerUsersTestHost();
    DI.register(ProbeAttributeProvider).as(PrincipalAttributeProvider);
  });

  after(() => {
    DI.unregister(ProbeAttributeProvider);
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
    guard = new AuthzImpersonationGuard();
  });

  afterEach(() => {
    sinon.restore();
    probeAttributes = false;
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

  it('allows the interactive sign-ins: password, oidc, ldap, saml', async () => {
    const ref = await user('support');
    const target = await user('member');

    for (const method of ['password', 'oidc', 'ldap', 'saml']) {
      expect(await guard.allowed(await signedIn(ref, { ...FACTS, method, strategy: method }), target), method).to.deep.eq({ ok: true });
    }
  });

  it('builds the target as the session will carry it: the actor’s authn facts and session, impersonator set, no ceiling', async () => {
    const factory = new RecordingFactory();
    const actorRef = await user('support');
    const actor = await signedIn(actorRef);
    const target = await user('member');

    expect(await new AuthzImpersonationGuard({ principals: factory }).allowed(actor, target)).to.deep.eq({ ok: true });

    expect(factory.calls).to.have.length(1);
    const [call] = factory.calls;
    expect(call.id).to.deep.eq(target);
    expect(call.facts).to.deep.eq({ method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: FACTS.authenticatedAt, sessionHandle: 'h-actor', impersonator: { type: 'user', id: actorRef.id } });
    expect(call.extra).to.deep.eq({});
    expect(call.principal).to.not.have.property('ceiling');
    expect(call.principal!.source).to.eq('session');
  });

  describe('forbidden', () => {
    it('without user:impersonate at GLOBAL', async () => {
      const actor = await signedIn(await user('useradmin', 'member'));

      expect(await guard.allowed(actor, await user())).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for an actor whose role switch ceiling drops user:impersonate', async () => {
      const actor = await signedIn(await user('support', 'useradmin'), FACTS, { roles: ['useradmin'] });

      expect(await guard.allowed(actor, await user())).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for the actor itself', async () => {
      const ref = await user('support');

      expect(await guard.allowed(await signedIn(ref), ref)).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for another id the store resolves to the actor', async () => {
      const ref = await user('support');
      const other = await user('member');

      expect(await new AuthzImpersonationGuard({ principals: new OneUserFactory(ref) }).allowed(await signedIn(ref), other)).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for an actor that is already impersonating', async () => {
      const impersonator = await user('support');
      const actor = await signedIn(await user('support'), { ...FACTS, impersonator: { type: 'user', id: impersonator.id } });

      expect(await guard.allowed(actor, await user('member'))).to.deep.eq({ ok: false, code: 'forbidden' });
    });

    it('for an actor not signed in interactively: token, jws, http-signature, jwt, an unknown method', async () => {
      const ref = await user('support');
      const target = await user('member');

      for (const method of ['token', 'jws', 'http-signature', 'jwt', 'magic-link']) {
        const actor = await signedIn(ref, { ...FACTS, method, strategy: method });
        expect(await guard.allowed(actor, target), method).to.deep.eq({ ok: false, code: 'forbidden' });
      }
    });

    it('for an actor whose authn facts are not an object', async () => {
      const actor = await signedIn(await user('support'));

      expect(await guard.allowed({ ...actor, authn: 'password' as unknown as AuthnFacts }, await user('member'))).to.deep.eq({ ok: false, code: 'forbidden' });
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

    it('for a target in a subject set that holds a protected role', async () => {
      const actor = await signedIn(await user('support'));
      const team = { type: 'project', id: 'team-1' };
      const target = await user('member');
      await grantTo({ set: { role: 'team.member', scope: team } }, 'admin');
      await grantAt(target, 'team.member', team);

      expect(await guard.allowed(actor, target)).to.deep.eq({ ok: false, code: 'protected_role' });
    });

    it('for a target holding, at a scope, a role that implies a protected one', async () => {
      const actor = await signedIn(await user('support'));
      const target = await user('member');
      await grantAt(target, 'projectowner', { type: 'project', id: 'p2' });

      expect(await guard.allowed(actor, target)).to.deep.eq({ ok: false, code: 'protected_role' });
    });

    // A ladder rank holds every rank below it: a rank above a protected role reaches it, a rank below does not.
    it('for a target holding a ladder rank above a protected role, not one below it', async () => {
      const actor = await signedIn(await user('support'));

      expect(await guard.allowed(actor, await user('owner'))).to.deep.eq({ ok: false, code: 'protected_role' });
      expect(await guard.allowed(actor, await user('opsmember'))).to.deep.eq({ ok: true });
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

    it('for an actor whose role switch ceiling keeps user:impersonate but not the target’s rights', async () => {
      const ref = await user('support', 'useradmin');
      const target = await user('auditor');

      expect(await guard.allowed(await signedIn(ref, FACTS, { roles: ['support'] }), target)).to.deep.eq({ ok: false, code: 'escalation' });
      expect(await guard.allowed(await signedIn(ref), target)).to.deep.eq({ ok: true });
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

    describe('checkIdentity (A25)', () => {
      it('judges an inactive or banned account on its rights', async () => {
        const rule = new AuthzTargetGuard();
        const helpdesk = await signedIn(await user('helpdesk'));
        const useradmin = await signedIn(await user('useradmin'));

        for (const flags of [{ active: false }, { banned: true }]) {
          const lower = await user('helpdesk');
          const higher = await user('useradmin');
          const guarded = await user('admin');
          await setIdentityFlags(lower, flags);
          await setIdentityFlags(higher, flags);
          await setIdentityFlags(guarded, flags);

          expect(await rule.checkIdentity(useradmin, lower), JSON.stringify(flags)).to.deep.eq({ ok: true });
          expect(await rule.checkIdentity(helpdesk, higher), JSON.stringify(flags)).to.deep.eq({ ok: false, code: 'escalation' });
          expect(await rule.checkIdentity(useradmin, guarded), JSON.stringify(flags)).to.deep.eq({ ok: false, code: 'protected_role' });
        }
      });

      it('throws ResourceNotFound for an unknown or deleted account', async () => {
        const rule = new AuthzTargetGuard();
        const actor = await signedIn(await user('useradmin'));
        const deleted = await user('helpdesk');
        await setIdentityFlags(deleted, { deleted: true });

        await expect(rule.checkIdentity(actor, { type: 'user', id: '00000000-0000-4000-8000-000000000000' })).to.be.rejectedWith(ResourceNotFound);
        await expect(rule.checkIdentity(actor, deleted)).to.be.rejectedWith(ResourceNotFound);
      });

      it('builds the target with the actor’s sign-in, no ceiling, and the attribute providers’ attributes', async () => {
        probeAttributes = true;
        const rule = new AuthzTargetGuard();
        const check = sinon.spy(rule, 'check');
        const actor = await signedIn(await user('useradmin'), FACTS, { roles: ['useradmin'] });
        const ref = await user('helpdesk');
        await setIdentityFlags(ref, { active: false });

        expect(await rule.checkIdentity(actor, ref)).to.deep.eq({ ok: true });

        const target = check.firstCall.args[1];
        expect(target).to.include({ type: 'user', id: ref.id, source: 'session' });
        expect(target).to.not.have.property('ceiling');
        expect(target.authn).to.deep.eq({ method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: FACTS.authenticatedAt, sessionHandle: 'h-actor' });
        expect(target.attributes).to.deep.eq({ probe: (target.identity as User).Login });
      });
    });

    // authz.token narrows a token principal's roles; the target must be judged on all of its own.
    describe('token sign-ins and authz.token.excludedRoles', () => {
      const TOKEN: AuthnFacts = { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt: FACTS.authenticatedAt };

      async function excludeFromTokens(...roles: string[]): Promise<void> {
        (await DI.resolve(Configuration)).set(['authz', 'token', 'excludedRoles'], roles);
      }

      it('checkIdentity: a token actor gets protected_role for a target holding an excluded protected role', async () => {
        await excludeFromTokens('admin');
        const rule = new AuthzTargetGuard();
        const check = sinon.spy(rule, 'check');
        const actor = await signedIn(await user('useradmin'), TOKEN);

        expect(await rule.checkIdentity(actor, await user('admin'))).to.deep.eq({ ok: false, code: 'protected_role' });
        const target = check.firstCall.args[1];
        expect(target).to.not.have.property('authn');
        expect(target.source).to.eq('identity');
      });

      it('checkIdentity: builds the target without facts after a jwt, unknown or unreadable sign-in', async () => {
        const rule = new AuthzTargetGuard();
        const check = sinon.spy(rule, 'check');
        const ref = await user('useradmin');
        const target = await user('helpdesk');
        const signed = await signedIn(ref);
        const actors = [await signedIn(ref, { ...FACTS, method: 'jwt', strategy: 'jwt' }), await signedIn(ref, { ...FACTS, method: 'magic-link', strategy: 'magic-link' }), { ...signed, authn: 'password' as unknown as AuthnFacts }];

        for (const [i, actor] of actors.entries()) {
          expect(await rule.checkIdentity(actor, target), String(i)).to.deep.eq({ ok: true });
          expect(check.getCall(i).args[1], String(i)).to.not.have.property('authn');
          expect(check.getCall(i).args[1].source, String(i)).to.eq('identity');
        }
      });

      it('checkIdentity: a token actor gets escalation for a target whose higher role tokens may not carry', async () => {
        await excludeFromTokens('useradmin');
        const actor = await signedIn(await user('helpdesk'), TOKEN);

        expect(await new AuthzTargetGuard().checkIdentity(actor, await user('useradmin'))).to.deep.eq({ ok: false, code: 'escalation' });
      });

      it('check: a target signed in with a token still counts its excluded protected role', async () => {
        await excludeFromTokens('admin');
        const actor = await signedIn(await user('useradmin'));
        const target = await signedIn(await user('admin'), TOKEN);

        expect(await new AuthzTargetGuard().check(actor, target)).to.deep.eq({ ok: false, code: 'protected_role' });
      });
    });
  });
});
