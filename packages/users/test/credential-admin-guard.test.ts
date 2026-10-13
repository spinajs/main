import { Bootstrapper, DI } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY, Configuration } from '@spinajs/configuration';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AUTHZ_CONFIGURATION_SCHEMA, AuthzConfigError, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal, ResourceRef } from '@spinajs/authz';
import { CredentialAdminGuard } from '@spinajs/authn/contracts';
import type { AuthnFacts, CredentialAdminAction, IdentityRef } from '@spinajs/authn/contracts';

import { AuthzCredentialAdminGuard, AuthzTargetGuard, CREDENTIAL_ADMIN_PERMISSION_KEY, CredentialAdminConfigBootstrapper, USERS_ACCESS_CONFIGURATION_SCHEMA, USERS_CREDENTIAL_ADMIN_CONFIGURATION_SCHEMA, UserPrincipalFactory } from '../src/index.js';
import { rootAdmin } from './support/authz-host.js';
import { bootChild, disposeChildren, violationPaths } from './support/child-config.js';
import { bootUsersDb, registerUsersTestHost, seedUser, setIdentityFlags } from './support/users-db.js';

chai.use(chaiAsPromised);

const FACTS: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date('2026-10-01T10:00:00Z'), sessionHandle: 'h-actor' };

const ACTIONS: readonly CredentialAdminAction[] = ['password-reset', 'mfa-reset', 'sessions', 'tokens'];

const PERMISSIONS = ['doc:read', 'doc:write', 'users:credentials'];

const ROLES: Record<string, object> = {
  member: { grants: ['doc:read'] },
  editor: { grants: ['doc:read', 'doc:write'] },
  // Both hold credential-admin rights, the helpdesk a strictly smaller set.
  helpdesk: { grants: ['users:read', 'users:credentials'] },
  useradmin: { grants: ['users:read', 'users:update', 'users:credentials', 'doc:read', 'doc:write'] },
  'useradmin.peer': { grants: ['users:read', 'users:update', 'users:credentials', 'doc:read', 'doc:write'] },
  superadmin: { extends: ['admin'] },
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
  expect(
    results.every((r) => r.ok),
    JSON.stringify(results),
  ).to.eq(true);
}

let seq = 0;

async function user(...roles: string[]): Promise<IdentityRef> {
  const { ref } = await seedUser({ login: `cred-${++seq}` });
  for (const role of roles) {
    await grantAt(ref, role);
  }
  return ref;
}

function signedIn(ref: IdentityRef, facts: AuthnFacts = FACTS): Promise<Principal> {
  return new UserPrincipalFactory().principalOf(ref, facts, {});
}

const FORBIDDEN = { ok: false, code: 'forbidden' };
const UNKNOWN_USER: IdentityRef = { type: 'user', id: '00000000-0000-4000-8000-000000000000' };

describe('AuthzCredentialAdminGuard (users DB, root authz host)', function () {
  this.timeout(30000);

  let guard: AuthzCredentialAdminGuard;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
    guard = new AuthzCredentialAdminGuard();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is the CredentialAdminGuard DI resolves', async () => {
    expect(await DI.resolve(CredentialAdminGuard)).to.be.instanceOf(AuthzCredentialAdminGuard);
  });

  it('allows a holder of users:credentials whose rights strictly contain the target’s, for every action', async () => {
    const actor = await signedIn(await user('useradmin'));
    const targets = [await user('member'), await user('helpdesk'), await user()];

    for (const target of targets) {
      for (const action of ACTIONS) {
        expect(await guard.allowed(actor, target, action), `${target.id} ${action}`).to.deep.eq({ ok: true });
      }
    }
  });

  it('allows an inactive or banned target judged on its rights', async () => {
    const actor = await signedIn(await user('useradmin'));
    const inactive = await user('member');
    const banned = await user('member');
    await setIdentityFlags(inactive, { active: false });
    await setIdentityFlags(banned, { banned: true });

    expect(await guard.allowed(actor, inactive, 'password-reset')).to.deep.eq({ ok: true });
    expect(await guard.allowed(actor, banned, 'sessions')).to.deep.eq({ ok: true });
  });

  describe('forbidden', () => {
    it('without users:credentials at GLOBAL', async () => {
      const actor = await signedIn(await user('editor'));

      for (const action of ACTIONS) {
        expect(await guard.allowed(actor, await user('member'), action), action).to.deep.eq(FORBIDDEN);
      }
    });

    it('with users:credentials at a scope only', async () => {
      const ref = await user('editor');
      await grantAt(ref, 'useradmin', { type: 'project', id: 'p1' });

      expect(await guard.allowed(await signedIn(ref), await user('member'), 'password-reset')).to.deep.eq(FORBIDDEN);
    });

    it('for the actor itself: the owner routes change one’s own credentials', async () => {
      const ref = await user('useradmin');

      expect(await guard.allowed(await signedIn(ref), ref, 'password-reset')).to.deep.eq(FORBIDDEN);
    });

    it('for an actor that is impersonating', async () => {
      const impersonator = await user('useradmin');
      const actor = await signedIn(await user('useradmin'), { ...FACTS, impersonator: { type: 'user', id: impersonator.id } });

      expect(await guard.allowed(actor, await user('member'), 'password-reset')).to.deep.eq(FORBIDDEN);
    });

    it('for an actor not signed in interactively: token, jws, http-signature, jwt, an unknown method', async () => {
      const ref = await user('useradmin');
      const target = await user('member');

      for (const method of ['token', 'jws', 'http-signature', 'jwt', 'magic-link']) {
        const actor = await signedIn(ref, { ...FACTS, method, strategy: method });
        expect(await guard.allowed(actor, target, 'tokens'), method).to.deep.eq(FORBIDDEN);
      }
    });

    it('for an actor that is not a signed-in user principal', async () => {
      const signed = await signedIn(await user('useradmin'));
      const target = await user('member');
      const { authn: _authn, ...withoutFacts } = signed;

      expect(await guard.allowed({ ...signed, authenticated: false }, target, 'sessions')).to.deep.eq(FORBIDDEN);
      expect(await guard.allowed(withoutFacts, target, 'sessions')).to.deep.eq(FORBIDDEN);
      expect(await guard.allowed({ ...signed, authn: 'password' as unknown as AuthnFacts }, target, 'sessions')).to.deep.eq(FORBIDDEN);
      expect(await guard.allowed({ ...signed, type: 'service' }, target, 'sessions')).to.deep.eq(FORBIDDEN);
      expect(await guard.allowed(SYSTEM, target, 'sessions')).to.deep.eq(FORBIDDEN);
    });

    it('for a target that is not a user', async () => {
      const actor = await signedIn(await user('useradmin'));

      expect(await guard.allowed(actor, { type: 'service', id: 'svc-1' }, 'tokens')).to.deep.eq(FORBIDDEN);
    });

    it('before it looks the target up: an actor without the permission learns nothing of unknown ids', async () => {
      const actor = await signedIn(await user('editor'));

      expect(await guard.allowed(actor, UNKNOWN_USER, 'password-reset')).to.deep.eq(FORBIDDEN);
    });
  });

  describe('protected_role', () => {
    it('for a target holding a protected role, directly or through extends', async () => {
      const actor = await signedIn(await user('useradmin'));

      expect(await guard.allowed(actor, await user('admin'), 'password-reset')).to.deep.eq({ ok: false, code: 'protected_role' });
      expect(await guard.allowed(actor, await user('superadmin'), 'mfa-reset')).to.deep.eq({ ok: false, code: 'protected_role' });
    });

    it('for a target holding a protected role at a scope only', async () => {
      const actor = await signedIn(await user('useradmin'));
      const target = await user('member');
      await grantAt(target, 'admin', { type: 'project', id: 'p2' });

      expect(await guard.allowed(actor, target, 'sessions')).to.deep.eq({ ok: false, code: 'protected_role' });
    });
  });

  describe('escalation', () => {
    // The exact SR-10 name belongs to C3's rule test and to the route test of N8b task 5b.
    it('for a lower credential admin acting on a higher admin’s account (the SR-10 rule, at the guard)', async () => {
      const lower = await signedIn(await user('helpdesk'));
      const higher = await user('useradmin');

      for (const action of ACTIONS) {
        expect(await guard.allowed(lower, higher, action), action).to.deep.eq({ ok: false, code: 'escalation' });
      }
      expect(await guard.allowed(await signedIn(higher), await user('helpdesk'), 'password-reset')).to.deep.eq({ ok: true });
    });

    it('for a target with an equal set', async () => {
      const actor = await signedIn(await user('useradmin'));

      expect(await guard.allowed(actor, await user('useradmin.peer'), 'tokens')).to.deep.eq({ ok: false, code: 'escalation' });
    });
  });

  describe('not_found', () => {
    it('for an unknown or deleted target', async () => {
      const actor = await signedIn(await user('useradmin'));
      const deleted = await user('member');
      await setIdentityFlags(deleted, { deleted: true });

      expect(await guard.allowed(actor, UNKNOWN_USER, 'password-reset')).to.deep.eq({ ok: false, code: 'not_found' });
      expect(await guard.allowed(actor, deleted, 'sessions')).to.deep.eq({ ok: false, code: 'not_found' });
    });
  });

  describe('fails closed', () => {
    it('propagates any target rule error other than ResourceNotFound', async () => {
      const targets = new AuthzTargetGuard();
      sinon.stub(targets, 'checkIdentity').rejects(new Error('identity store down'));
      const actor = await signedIn(await user('useradmin'));

      await expect(new AuthzCredentialAdminGuard({ targets }).allowed(actor, await user('member'), 'password-reset')).to.be.rejectedWith('identity store down');
    });

    it('rejects an authz.credentials.permission that is not a permission name, set past the schema', async () => {
      const actor = await signedIn(await user('useradmin'));
      const target = await user('member');

      for (const bad of ['', 5, ['users:credentials'], null]) {
        (await DI.resolve(Configuration)).set(['authz', 'credentials', 'permission'], bad);
        await expect(new AuthzCredentialAdminGuard().allowed(actor, target, 'password-reset'), JSON.stringify(bad)).to.be.rejectedWith(AuthzConfigError, /authz\.credentials\.permission/);
      }
    });
  });

  describe('authz.credentials.permission', () => {
    it('is users:credentials when the app sets nothing', async () => {
      expect((await DI.resolve(Configuration)).get(CREDENTIAL_ADMIN_PERMISSION_KEY)).to.eq('users:credentials');
    });

    it('names the permission the actor needs', async () => {
      (await DI.resolve(Configuration)).set(['authz', 'credentials', 'permission'], 'doc:write');
      const editor = await signedIn(await user('editor'));
      const helpdesk = await signedIn(await user('helpdesk'));
      const target = await user('member');

      expect(await guard.allowed(editor, target, 'password-reset')).to.deep.eq({ ok: true });
      expect(await guard.allowed(helpdesk, target, 'password-reset')).to.deep.eq(FORBIDDEN);
    });
  });
});

describe('authz.credentials configuration (users)', () => {
  const SCHEMAS = [AUTHZ_CONFIGURATION_SCHEMA, USERS_ACCESS_CONFIGURATION_SCHEMA, USERS_CREDENTIAL_ADMIN_CONFIGURATION_SCHEMA];

  afterEach(disposeChildren);

  it('defaults the permission to users:credentials', async () => {
    const { config } = await bootChild({}, ...SCHEMAS);

    expect(config.get('authz.credentials')).to.deep.eq({ permission: 'users:credentials' });
  });

  it('keeps a configured permission', async () => {
    const { config } = await bootChild({ authz: { credentials: { permission: 'users:admin-credentials' } } }, ...SCHEMAS);

    expect(config.get(CREDENTIAL_ADMIN_PERMISSION_KEY)).to.eq('users:admin-credentials');
  });

  describe('a bad value fails the boot with InvalidConfiguration and the full path of the bad key', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['an empty permission', { authz: { credentials: { permission: '' } } }, 'authz.credentials.permission'],
      ['a permission that is an object', { authz: { credentials: { permission: {} } } }, 'authz.credentials.permission'],
      ['a permission that is a list of two', { authz: { credentials: { permission: ['a', 'b'] } } }, 'authz.credentials.permission'],
      ['a permission set to null', { authz: { credentials: { permission: null } } }, 'authz.credentials.permission'],
      ['credentials set to null', { authz: { credentials: null } }, 'authz.credentials'],
    ];

    for (const [label, values, path] of cases) {
      it(`for ${label}`, async () => {
        expect(await violationPaths(values, ...SCHEMAS)).to.include(path);
      });
    }

    it('for an unknown key under authz.credentials', async () => {
      const paths = await violationPaths({ authz: { credentials: { permission: 'users:credentials', permision: 'x' } } }, ...SCHEMAS);

      expect(paths).to.include('authz.credentials.permision');
    });
  });

  it('@Config reads the permission from the configuration of the container the guard is handed', async () => {
    const { child } = await bootChild({ authz: { http: { access: { domain: 'tenant' } }, credentials: { permission: 'users:take-over' } } }, ...SCHEMAS);
    const guard = new AuthzCredentialAdminGuard();
    (guard as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = child;

    expect((guard as unknown as Record<string, unknown>).Permission).to.eq('users:take-over');
    expect((guard as unknown as Record<string, unknown>).AccessDomain).to.eq('tenant');
  });

  it('is registered again by a Bootstrapper, after DI.clearCache()', () => {
    expect(DI.RootContainer.getRegisteredTypes(Bootstrapper)).to.include(CredentialAdminConfigBootstrapper);
  });
});
