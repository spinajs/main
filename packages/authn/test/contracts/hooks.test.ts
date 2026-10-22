import * as chai from 'chai';
import 'mocha';

import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';

import { AuthnResponseExtension, RoleSource, SessionStartHook } from '../../src/contracts/hooks.js';
import * as hooksModule from '../../src/contracts/hooks.js';
import type { AuthnLoginIdentifiedInput } from '../../src/hooks.js';
import type { CredentialAdminAction, IAuthnPrincipalStorage } from '../../src/contracts/hooks.js';
import type { ExternalSubject, IdentityRef } from '../../src/contracts/credentials.js';
import type { Ceiling, Principal } from '../../src/contracts/principal.js';
import type { SessionHandle, SessionIssuer } from '../../src/contracts/session.js';
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

class FirstRole extends SessionStartHook {
  readonly calls: ['login' | 'mfa', SessionHandle][] = [];
  async onStart(kind: 'login' | 'mfa', session: SessionHandle, p: Principal, _sessions: SessionIssuer): Promise<Ceiling | undefined> {
    this.calls.push([kind, session]);
    return p.id === 'alice' ? { roles: ['admin'] } : undefined;
  }
}

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
      expect(index.SessionStartHook).to.eq(SessionStartHook);
      for (const c of [AuthnResponseExtension, RoleSource, SessionStartHook]) {
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

    it('a session start hook answers a ceiling for a new active session, or undefined', async () => {
      const hook = new FirstRole();
      const handle: SessionHandle = { id: 'raw', state: 'active' };
      const sessions = {} as SessionIssuer;
      expect(await hook.onStart('login', handle, principal, sessions)).to.deep.eq({ roles: ['admin'] });
      expect(await hook.onStart('mfa', handle, { ...principal, id: 'bob' }, sessions)).to.eq(undefined);
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

    it('CredentialAdminGuard is gone (D17): a CredentialAdminRule on authn.admin.credentials (@spinajs/authn/hooks) replaces it', () => {
      expect((index as unknown as Record<string, unknown>).CredentialAdminGuard).to.eq(undefined);
      expect((hooksModule as unknown as Record<string, unknown>).CredentialAdminGuard).to.eq(undefined);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('hooks.ts holds exactly the three hook classes', () => {
      expect(shapeOf(classMembers('hooks.ts'))).to.deep.eq({
        AuthnResponseExtension: { base: null, members: [{ name: 'extend', modifiers: ['abstract'], optional: false, params: ['kind', 'principal', 'body'] }] },
        RoleSource: { base: null, members: [{ name: 'rolesOf', modifiers: ['abstract'], optional: false, params: ['principal'] }] },
        SessionStartHook: { base: null, members: [{ name: 'onStart', modifiers: ['abstract'], optional: false, params: ['kind', 'session', 'principal', 'sessions'] }] },
      });
    });

    it('docs carry the rules a reader needs', () => {
      const c = classMembers('hooks.ts');
      expect(c.AuthnResponseExtension.doc).to.contain('Array.ofType');
      expect(c.AuthnResponseExtension.doc).to.contain('Access');
      expect(docOf(c.AuthnResponseExtension.members, 'extend')).to.contain('body');
      expect(c.RoleSource.doc).to.contain('none registered ⇒ role switch off');
      expect(c.SessionStartHook.doc).to.contain('Array.ofType');
      expect(c.SessionStartHook.doc).to.contain('registration order');
      expect(c.SessionStartHook.doc).to.contain('ActiveRole');
      expect(c.SessionStartHook.doc).to.contain('at most one role');
      expect(c.SessionStartHook.doc).to.contain('ends the session');
      expect(declarationDocs('hooks.ts').CredentialAdminAction).to.contain('A25');
    });
  });

  describe('types', () => {
    it('re-exports every name from the contracts index', () => {
      same<index.IAuthnPrincipalStorage, IAuthnPrincipalStorage>(true);
      same<index.AuthnResponseExtension, AuthnResponseExtension>(true);
      same<index.RoleSource, RoleSource>(true);
      same<index.SessionStartHook, SessionStartHook>(true);
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
      same<Parameters<SessionStartHook['onStart']>, ['login' | 'mfa', SessionHandle, Principal, SessionIssuer]>(true);
      same<ReturnType<SessionStartHook['onStart']>, Promise<Ceiling | undefined>>(true);
      same<AuthnLoginIdentifiedInput['identity'], IdentityRef>(true);
      same<AuthnLoginIdentifiedInput['external'], ExternalSubject | undefined>(true);
      same<CredentialAdminAction, 'password-reset' | 'mfa-reset' | 'sessions' | 'tokens'>(true);
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
      // @ts-expect-error abstract
      const c = () => new SessionStartHook();
      const hook = new GroupSync();
      // @ts-expect-error the identity is an IdentityRef, not an external subject
      const d = () => hook.before(identifiedCtx({ identity: external, strategy: 'oidc:corp', method: 'oidc', attributes: {}, ctx: { now: new Date(), purpose: 'login' } }));
      class NoPassword extends RoleSource {
        // @ts-expect-error every role says whether it needs a password
        async rolesOf(): Promise<readonly { role: string }[]> {
          return [];
        }
      }
      expect([a, b, c, d, NoPassword]).to.have.length(5);
    });
  });
});
