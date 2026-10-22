import * as chai from 'chai';
import 'mocha';

import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';

import { AuthnResponseExtension, CredentialAdminGuard, RoleSource } from '../../src/contracts/hooks.js';
import * as hooksModule from '../../src/contracts/hooks.js';
import type { AuthnLoginIdentifiedInput, AuthnSessionStartInput } from '../../src/hooks.js';
import type { CredentialAdminAction, IAuthnPrincipalStorage } from '../../src/contracts/hooks.js';
import type { ExternalSubject, IdentityRef } from '../../src/contracts/credentials.js';
import type { Ceiling, Principal } from '../../src/contracts/principal.js';
import type { SessionHandle } from '../../src/contracts/session.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, declarationDocs, docOf, same, shapeOf } from './source-shape.js';

const expect = chai.expect;

type ResponseKind = 'login' | 'mfa' | 'role-switch' | 'impersonation' | 'whoami';
type RoleOption = { role: string; requirePassword: boolean };

const alice: IdentityRef = { type: 'user', id: 'alice' };
const principal: Principal = { type: 'user', id: 'alice', authenticated: true, source: 'session', attributes: {} };
const external: ExternalSubject = { provider: 'oidc:corp', subject: 's-1', email: 'a@b.c', emailVerified: true, claims: { groups: ['eng', 'ops'] } };

class AccessExtension extends AuthnResponseExtension {
  async extend(kind: ResponseKind, p: Principal, body: Record<string, unknown>): Promise<void> {
    body.Access = { kind, who: p.id };
  }
}

class Roles extends RoleSource {
  async rolesOf(p: Principal): Promise<readonly { role: string; requirePassword: boolean }[]> {
    return p.id === 'alice'
      ? [
          { role: 'admin', requirePassword: true },
          { role: 'user', requirePassword: false },
        ]
      : [];
  }
}

type AdminAnswer = { ok: true } | { ok: false; code: 'forbidden' | 'protected_role' | 'escalation' | 'not_found' };

class AdminsOnly extends CredentialAdminGuard {
  readonly calls: [Principal, IdentityRef, CredentialAdminAction][] = [];
  async allowed(actor: Principal, target: IdentityRef, action: CredentialAdminAction): Promise<AdminAnswer> {
    this.calls.push([actor, target, action]);
    if (target.id === 'ghost') return { ok: false, code: 'not_found' };
    return actor.id === 'root' ? { ok: true } : { ok: false, code: 'forbidden' };
  }
}

/** Starts alice's sessions narrowed to admin. */
class FirstRole extends ActionHook<'authn.session.start'> {
  readonly actions: readonly ActionPattern[] = ['authn.session.start'];
  readonly calls: ['login' | 'mfa', SessionHandle][] = [];
  before(ctx: BeforeContext<'authn.session.start'>): void {
    this.calls.push([ctx.input.kind, ctx.input.session]);
    if (ctx.input.principal.id === 'alice') ctx.input.ceiling = { roles: ['admin'] };
  }
}

const startCtx = (input: AuthnSessionStartInput): BeforeContext<'authn.session.start'> => ({
  action: 'authn.session.start',
  input: { ...input },
  bag: new Map(),
  depth: 1,
  refuse: () => {
    throw new Error('refused');
  },
});

/** An app's group sync on authn.login.identified: reads the mapped claims of input.external. */
class GroupSync extends ActionHook<'authn.login.identified'> {
  readonly actions: readonly ActionPattern[] = ['authn.login.identified'];
  readonly synced: [IdentityRef, readonly string[]][] = [];
  async before(ctx: BeforeContext<'authn.login.identified'>): Promise<void> {
    const { identity, external: ext } = ctx.input;
    if (ext) this.synced.push([identity, (ext.claims?.groups as readonly string[] | undefined) ?? []]);
  }
}

const identifiedCtx = (input: AuthnLoginIdentifiedInput): BeforeContext<'authn.login.identified'> => ({
  action: 'authn.login.identified',
  input,
  bag: new Map(),
  depth: 1,
  refuse: (code: string) => {
    throw new Error(code);
  },
});

describe('hand-off and hook contracts', () => {
  describe('runtime', () => {
    it('exports the three hooks from the contracts index as plain abstract classes', () => {
      expect(index.AuthnResponseExtension).to.eq(AuthnResponseExtension);
      expect(index.RoleSource).to.eq(RoleSource);
      expect(index.CredentialAdminGuard).to.eq(CredentialAdminGuard);
      for (const c of [AuthnResponseExtension, RoleSource, CredentialAdminGuard]) {
        expect(c).to.be.a('function');
        expect(Object.getPrototypeOf(c)).to.eq(Function.prototype);
      }
    });

    it('every response extension adds its fields to the same body', async () => {
      class Extra extends AuthnResponseExtension {
        async extend(_kind: ResponseKind, _p: Principal, body: Record<string, unknown>): Promise<void> {
          body.Extra = true;
        }
      }
      const body: Record<string, unknown> = { Uuid: 'alice' };
      for (const e of [new AccessExtension(), new Extra()]) await e.extend('login', principal, body);
      expect(body).to.deep.eq({ Uuid: 'alice', Access: { kind: 'login', who: 'alice' }, Extra: true });
    });

    it('a role source lists roles with requirePassword', async () => {
      expect(await new Roles().rolesOf(principal)).to.deep.eq([
        { role: 'admin', requirePassword: true },
        { role: 'user', requirePassword: false },
      ]);
    });

    it('SessionStartHook is gone (D17): an authn.session.start before hook sets the ceiling of a new active session', async () => {
      expect((index as unknown as Record<string, unknown>).SessionStartHook).to.eq(undefined);
      expect((hooksModule as unknown as Record<string, unknown>).SessionStartHook).to.eq(undefined);
      const hook = new FirstRole();
      const handle: SessionHandle = { id: 'raw', state: 'active' };
      const ctx = { now: new Date(), purpose: 'login' as const };
      const login = startCtx({ kind: 'login', session: handle, principal, ctx });
      hook.before(login);
      expect(login.input.ceiling).to.deep.eq({ roles: ['admin'] });
      const mfa = startCtx({ kind: 'mfa', session: handle, principal: { ...principal, id: 'bob' }, ctx });
      hook.before(mfa);
      expect(mfa.input.ceiling).to.eq(undefined);
      expect(hook.calls).to.deep.eq([
        ['login', handle],
        ['mfa', handle],
      ]);
    });

    it('ExternalLoginHook is gone (D17): an authn.login.identified hook gets the identity and the mapped claims', async () => {
      expect((index as unknown as Record<string, unknown>).ExternalLoginHook).to.eq(undefined);
      expect((hooksModule as unknown as Record<string, unknown>).ExternalLoginHook).to.eq(undefined);
      const hooks = [new GroupSync(), new GroupSync()];
      for (const h of hooks) await h.before(identifiedCtx({ identity: alice, strategy: 'oidc:corp', method: 'oidc', external, attributes: {}, ctx: { now: new Date(), purpose: 'login' } }));
      for (const h of hooks) expect(h.synced).to.deep.eq([[alice, ['eng', 'ops']]]);
    });

    it('a credential admin guard answers ok or a refusal code for an actor, a target and an action', async () => {
      const guard = new AdminsOnly();
      const root: Principal = { ...principal, id: 'root' };
      expect(await guard.allowed(root, alice, 'password-reset')).to.deep.eq({ ok: true });
      expect(await guard.allowed(principal, alice, 'tokens')).to.deep.eq({ ok: false, code: 'forbidden' });
      expect(await guard.allowed(root, { type: 'user', id: 'ghost' }, 'sessions')).to.deep.eq({ ok: false, code: 'not_found' });
      expect(guard.calls.map((c) => c[2])).to.deep.eq(['password-reset', 'tokens', 'sessions']);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('hooks.ts holds exactly the three hook classes', () => {
      expect(shapeOf(classMembers('hooks.ts'))).to.deep.eq({
        AuthnResponseExtension: { base: null, members: [{ name: 'extend', modifiers: ['abstract'], optional: false, params: ['kind', 'principal', 'body'] }] },
        RoleSource: { base: null, members: [{ name: 'rolesOf', modifiers: ['abstract'], optional: false, params: ['principal'] }] },
        CredentialAdminGuard: { base: null, members: [{ name: 'allowed', modifiers: ['abstract'], optional: false, params: ['actor', 'target', 'action'] }] },
      });
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('hooks.ts');
      expect(c.AuthnResponseExtension.doc).to.contain('Array.ofType');
      expect(c.AuthnResponseExtension.doc).to.contain('Access');
      expect(docOf(c.AuthnResponseExtension.members, 'extend')).to.contain('body');
      expect(c.RoleSource.doc).to.contain('none registered ⇒ role switch off');
      expect(declarationDocs('hooks.ts').CredentialAdminAction).to.contain('A25');
      expect(c.CredentialAdminGuard.doc).to.contain('None registered ⇒ the credential admin routes are off (404)');
      expect(c.CredentialAdminGuard.doc).to.contain('users:credentials at GLOBAL');
      expect(c.CredentialAdminGuard.doc).to.contain('impersonating');
      expect(c.CredentialAdminGuard.doc).to.contain('did not sign in interactively');
      expect(c.CredentialAdminGuard.doc).to.contain('AuthzService.covers');
      expect(c.CredentialAdminGuard.doc).to.contain('before any effect');
    });
  });

  describe('types', () => {
    it('re-exports every name from the contracts index', () => {
      same<index.IAuthnPrincipalStorage, IAuthnPrincipalStorage>(true);
      same<index.AuthnResponseExtension, AuthnResponseExtension>(true);
      same<index.RoleSource, RoleSource>(true);
    });

    it('IAuthnPrincipalStorage is exactly the design shape', () => {
      same<IAuthnPrincipalStorage, { AuthnPrincipal?: Principal | null }>(true);
      const pending: IAuthnPrincipalStorage = { AuthnPrincipal: null };
      const none: IAuthnPrincipalStorage = {};
      const signedIn: IAuthnPrincipalStorage = { AuthnPrincipal: principal };
      // written by AuthnMiddleware, so not readonly
      signedIn.AuthnPrincipal = null;
      // @ts-expect-error a PrincipalRef is not a Principal
      const ref: IAuthnPrincipalStorage = { AuthnPrincipal: { type: 'user', id: 'alice' } };
      expect([pending, none, signedIn, ref]).to.have.length(4);
    });

    it('hook members have the design types', () => {
      same<Parameters<AuthnResponseExtension['extend']>, [ResponseKind, Principal, Record<string, unknown>]>(true);
      same<ReturnType<AuthnResponseExtension['extend']>, Promise<void>>(true);
      same<Parameters<RoleSource['rolesOf']>, [Principal]>(true);
      same<ReturnType<RoleSource['rolesOf']>, Promise<readonly RoleOption[]>>(true);
      same<AuthnSessionStartInput['kind'], 'login' | 'mfa'>(true);
      same<AuthnSessionStartInput['ceiling'], Ceiling | undefined>(true);
      same<AuthnLoginIdentifiedInput['identity'], IdentityRef>(true);
      same<AuthnLoginIdentifiedInput['external'], ExternalSubject | undefined>(true);
      same<CredentialAdminAction, 'password-reset' | 'mfa-reset' | 'sessions' | 'tokens'>(true);
      same<Parameters<CredentialAdminGuard['allowed']>, [Principal, IdentityRef, CredentialAdminAction]>(true);
      same<ReturnType<CredentialAdminGuard['allowed']>, Promise<AdminAnswer>>(true);
      same<index.CredentialAdminGuard, CredentialAdminGuard>(true);
      same<index.CredentialAdminAction, CredentialAdminAction>(true);
    });

    it('extend takes only the five kinds and a mutable body', () => {
      const e: AuthnResponseExtension = new AccessExtension();
      // @ts-expect-error no such kind
      const a = () => e.extend('logout', principal, {});
      same<Parameters<AuthnResponseExtension['extend']>[2], Readonly<Record<string, unknown>>>(false);
      expect(a).to.be.a('function');
    });

    it('wrong shapes do not compile', () => {
      // @ts-expect-error abstract
      const a = () => new AuthnResponseExtension();
      // @ts-expect-error abstract
      const b = () => new RoleSource();
      // @ts-expect-error a session starts at a login or an MFA completion only
      const c = () => startCtx({ kind: 'stepUp', session: { id: 'raw', state: 'active' }, principal, ctx: { now: new Date(), purpose: 'login' } });
      const hook = new GroupSync();
      // @ts-expect-error the identity is an IdentityRef, not an external subject
      const d = () => hook.before(identifiedCtx({ identity: external, strategy: 'oidc:corp', method: 'oidc', attributes: {}, ctx: { now: new Date(), purpose: 'login' } }));
      class NoPassword extends RoleSource {
        // @ts-expect-error every role says whether it needs a password
        async rolesOf(): Promise<readonly { role: string }[]> {
          return [];
        }
      }
      // @ts-expect-error abstract
      const e = () => new CredentialAdminGuard();
      const admin: CredentialAdminGuard = new AdminsOnly();
      // @ts-expect-error no such action
      const f = () => admin.allowed(principal, alice, 'password-change');
      class NoNotFound extends CredentialAdminGuard {
        // @ts-expect-error the refusal codes are the four of the contract
        async allowed(): Promise<{ ok: false; code: 'gone' }> {
          return { ok: false, code: 'gone' };
        }
      }
      expect([a, b, c, d, NoPassword, e, f, NoNotFound]).to.have.length(8);
    });
  });
});
