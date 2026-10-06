import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzConfigError, AuthzDomains, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AssignmentSubject, AuthzCommand, Principal, ResourceRef } from '@spinajs/authz';
import { DefaultMfaPolicy } from '@spinajs/authn';
import { MfaStep, RoleSource } from '@spinajs/authn/contracts';
import type { AuthnFacts, Ceiling, IdentityRef } from '@spinajs/authn/contracts';

import { RbacRoleSource, UserPrincipalFactory } from '../src/index.js';
import { rootAdmin } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, seedUser } from './support/users-db.js';

chai.use(chaiAsPromised);

const PASSWORD_KEY = ['authz', 'principals', 'roleSwitch', 'requirePassword'];
const LEGACY_PASSWORD_KEY = ['rbac', 'roleSwitch', 'requirePassword'];

const FACTS: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date('2026-10-01T10:00:00Z'), sessionHandle: 'h-1' };

function configure(config: Configuration): void {
  config.set(['authz', 'permissions', 'doc:read'], {});
  for (const role of ['support', 'member', 'auditor']) {
    config.set(['authz', 'rbac', 'roles', role], { grants: ['doc:read'] });
  }
  config.set(['authz', 'rbac', 'roles', 'team.member'], { subjectSet: true });
  // With no list every role asks for the password; most tests here are about which roles are listed.
  config.set(PASSWORD_KEY, []);
}

async function grantTo(subject: AssignmentSubject, role: string, scope: ResourceRef = GLOBAL, expiresAt?: Date): Promise<void> {
  const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject, role, scope, ...(expiresAt ? { expiresAt } : {}) }];
  const results = await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test' });
  expect(
    results.every((r) => r.ok),
    JSON.stringify(results),
  ).to.eq(true);
}

let seq = 0;

/** A new active user holding `roles` at GLOBAL. */
async function user(...roles: string[]): Promise<IdentityRef> {
  const { ref } = await seedUser({ login: `rs-${++seq}` });
  for (const role of roles) {
    await grantTo({ type: ref.type, id: ref.id }, role);
  }
  return ref;
}

function signedIn(ref: IdentityRef, facts: AuthnFacts = FACTS, ceiling?: Ceiling): Promise<Principal> {
  return new UserPrincipalFactory().principalOf(ref, facts, ceiling ? { ceiling } : {});
}

/** What authn-token's ownerHolds asks with: the owner alone, no authn facts. */
const bareOwner = (ref: IdentityRef): Principal => ({ type: ref.type, id: ref.id, authenticated: true, source: 'token', attributes: {} });

const roles = (...names: string[]) => names.map((role) => ({ role, requirePassword: false }));

async function setConfig(path: string[], value: unknown): Promise<void> {
  (await DI.resolve(Configuration)).set(path, value);
}

class NeverEnrolledStep extends MfaStep {
  public readonly name = 'totp';
  public async enrolled(): Promise<boolean> {
    return false;
  }
  public beginEnrolment(): Promise<{ provisioning: string }> {
    throw new Error('not used');
  }
  public confirmEnrolment(): Promise<{ recoveryCodes?: readonly string[] }> {
    throw new Error('not used');
  }
  public verify(): Promise<boolean> {
    throw new Error('not used');
  }
  public disable(): Promise<void> {
    throw new Error('not used');
  }
}

describe('RbacRoleSource (users DB, root authz host)', function () {
  this.timeout(30000);

  let source: RbacRoleSource;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
    source = new RbacRoleSource();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is the RoleSource DI resolves', async () => {
    expect(await DI.resolve(RoleSource)).to.be.instanceOf(RbacRoleSource);
  });

  it('lists every held role, once each and by name, despite a role switch ceiling', async () => {
    const ref = await user('support', 'member', 'auditor');
    const team = { type: 'project', id: 'team-1' };
    await grantTo({ set: { role: 'team.member', scope: team } }, 'member');
    await grantTo({ type: ref.type, id: ref.id }, 'team.member', team);

    expect(await source.rolesOf(await signedIn(ref))).to.deep.eq(roles('auditor', 'member', 'support', 'team.member'));
    expect(await source.rolesOf(await signedIn(ref, FACTS, { roles: ['member'] }))).to.deep.eq(roles('auditor', 'member', 'support', 'team.member'));
  });

  it('flags the roles of authz.principals.roleSwitch.requirePassword', async () => {
    const ref = await user('support', 'member');
    await setConfig(['authz', 'principals', 'roleSwitch', 'requirePassword'], ['support']);

    expect(await source.rolesOf(await signedIn(ref))).to.deep.eq([
      { role: 'member', requirePassword: false },
      { role: 'support', requirePassword: true },
    ]);
  });

  describe('which roles need the password (N8a-D9)', () => {
    const flags = async (ref: IdentityRef) => Object.fromEntries((await source.rolesOf(await signedIn(ref))).map((r) => [r.role, r.requirePassword]));

    it('asks for the password for every role when neither key is set', async () => {
      const ref = await user('support', 'member');
      await setConfig(PASSWORD_KEY, undefined);

      expect(await flags(ref)).to.deep.eq({ member: true, support: true });
    });

    it('reads the 2.x rbac.roleSwitch.requirePassword while the 3.0 key is unset', async () => {
      const ref = await user('support', 'member');
      await setConfig(PASSWORD_KEY, undefined);
      await setConfig(LEGACY_PASSWORD_KEY, ['support']);

      expect(await flags(ref)).to.deep.eq({ member: false, support: true });
    });

    it('takes the 3.0 key over the 2.x one, an empty list included', async () => {
      const ref = await user('support', 'member');
      await setConfig(LEGACY_PASSWORD_KEY, ['support', 'member']);

      await setConfig(PASSWORD_KEY, ['member']);
      expect(await flags(ref)).to.deep.eq({ member: true, support: false });

      await setConfig(PASSWORD_KEY, []);
      expect(await flags(ref)).to.deep.eq({ member: false, support: false });
    });

    it('rejects a malformed 3.0 key set at runtime, instead of reading it as no role needing the password', async () => {
      const ref = await user('member');
      for (const bad of ['support', { support: true }, 5, [1]]) {
        await setConfig(PASSWORD_KEY, bad);
        await expect(source.rolesOf(await signedIn(ref)), JSON.stringify(bad)).to.be.rejectedWith(AuthzConfigError, /authz\.principals\.roleSwitch\.requirePassword/);
      }
    });

    it('takes a null 3.0 key as unset', async () => {
      const ref = await user('support', 'member');
      await setConfig(PASSWORD_KEY, null);

      expect(await flags(ref), 'neither').to.deep.eq({ member: true, support: true });

      await setConfig(LEGACY_PASSWORD_KEY, ['member']);
      expect(await flags(ref), '2.x').to.deep.eq({ member: true, support: false });
    });

    it('rejects a malformed 2.x key while it is read, and ignores it once the 3.0 key is set', async () => {
      const ref = await user('member');
      await setConfig(PASSWORD_KEY, undefined);

      for (const bad of ['support', [''], [1], { support: true }]) {
        await setConfig(LEGACY_PASSWORD_KEY, bad);
        await expect(source.rolesOf(await signedIn(ref)), JSON.stringify(bad)).to.be.rejectedWith(AuthzConfigError, /rbac\.roleSwitch\.requirePassword/);
      }

      await setConfig(PASSWORD_KEY, ['member']);
      expect(await flags(ref)).to.deep.eq({ member: true });
    });
  });

  it('lists roles held only at a scope, directly or through a subject set, and leaves out expired holdings', async () => {
    const ref = await user('member');
    const team = { type: 'project', id: 'team-2' };
    await grantTo({ set: { role: 'team.member', scope: team } }, 'auditor', team);
    await grantTo({ type: ref.type, id: ref.id }, 'team.member', team);
    await grantTo({ type: ref.type, id: ref.id }, 'support', { type: 'project', id: 'p1' }, new Date(Date.now() + 60_000));
    expect(await source.rolesOf(await signedIn(ref))).to.deep.eq(roles('auditor', 'member', 'support', 'team.member'));

    sinon.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] });

    expect(await source.rolesOf(await signedIn(ref))).to.deep.eq(roles('auditor', 'member', 'team.member'));
  });

  it('offers roles to the interactive sign-ins: password, oidc, ldap, saml', async () => {
    const ref = await user('support');

    for (const method of ['password', 'oidc', 'ldap', 'saml']) {
      expect(await source.rolesOf(await signedIn(ref, { ...FACTS, method, strategy: method })), method).to.deep.eq(roles('support'));
    }
  });

  it('offers nothing to any other sign-in: token, jws, http-signature, jwt, an unknown method', async () => {
    const ref = await user('support');

    for (const method of ['token', 'jws', 'http-signature', 'jwt', 'magic-link']) {
      expect(await source.rolesOf(await signedIn(ref, { ...FACTS, method, strategy: method })), method).to.deep.eq([]);
    }
  });

  it('offers nothing when the authn facts are not an object', async () => {
    const principal = await signedIn(await user('support'));

    for (const authn of ['password', 42, true]) {
      expect(await source.rolesOf({ ...principal, authn: authn as unknown as AuthnFacts }), String(authn)).to.deep.eq([]);
    }
  });

  it('offers nothing to agents and principals that are not users', async () => {
    const owner = await signedIn(await user('support'));

    expect(await source.rolesOf({ ...owner, onBehalfOf: owner })).to.deep.eq([]);
    expect(await source.rolesOf({ type: 'agent', id: 'agent-1', authenticated: true, source: 'token', attributes: {}, onBehalfOf: owner, delegation: 'inherit' })).to.deep.eq([]);
    expect(await source.rolesOf({ ...owner, type: 'service' })).to.deep.eq([]);
    expect(await source.rolesOf(SYSTEM)).to.deep.eq([]);
  });

  it('offers nothing to a service principal that holds a role', async () => {
    await grantTo({ type: 'service', id: 'svc-roles' }, 'support');

    expect(await source.rolesOf({ type: 'service', id: 'svc-roles', authenticated: true, source: 'token', attributes: {} })).to.deep.eq([]);
  });

  it('gives the bare owner principal of authn-token its full roles, past authz.token.excludedRoles', async () => {
    const ref = await user('support', 'member');
    await setConfig(['authz', 'token', 'excludedRoles'], ['support']);

    expect(await source.rolesOf(bareOwner(ref))).to.deep.eq(roles('member', 'support'));
  });

  it("gives an impersonation session the target's roles", async () => {
    const actor = await user('support');
    const target = await user('member');

    expect(await source.rolesOf(await signedIn(target, { ...FACTS, impersonator: { type: 'user', id: actor.id } }))).to.deep.eq(roles('member'));
  });

  it('fails when the access domain has no RbacService', async () => {
    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    const container = domains.create('c3-no-rbac-roles');
    await setConfig(['authz', 'http', 'access', 'domain'], 'c3-no-rbac-roles');
    try {
      await expect(source.rolesOf(await signedIn(await user('member')))).to.be.rejectedWith(AuthzConfigError, /RbacService/);
    } finally {
      await container.dispose();
    }
  });

  describe("authn's DefaultMfaPolicy with authn.mfa.policy.forceForRoles", () => {
    before(() => {
      DI.register(NeverEnrolledStep).as(MfaStep);
    });

    after(() => {
      DI.unregister(NeverEnrolledStep);
    });

    it('requires the first step for a holder of a listed role only', async () => {
      const config = (await DI.resolve(Configuration)) as Configuration;
      config.set(['authn', 'mfa', 'steps'], [{ name: 'totp', service: 'NeverEnrolledStep' }]);
      config.set(['authn', 'mfa', 'policy', 'forceForRoles'], ['support']);
      const policy = new DefaultMfaPolicy(DI.RootContainer);
      const login = { method: 'password', strategy: 'local' };

      expect(await policy.required(await user('support'), login)).to.deep.eq(['totp']);
      expect(await policy.required(await user('member'), login)).to.deep.eq([]);
    });

    it('requires the first step for a holder of a listed role at a scope only', async () => {
      const config = (await DI.resolve(Configuration)) as Configuration;
      config.set(['authn', 'mfa', 'steps'], [{ name: 'totp', service: 'NeverEnrolledStep' }]);
      config.set(['authn', 'mfa', 'policy', 'forceForRoles'], ['support']);
      const policy = new DefaultMfaPolicy(DI.RootContainer);
      const ref = await user('member');
      await grantTo({ type: ref.type, id: ref.id }, 'support', { type: 'project', id: 'p2' });

      expect(await policy.required(ref, { method: 'password', strategy: 'local' })).to.deep.eq(['totp']);
    });
  });
});
