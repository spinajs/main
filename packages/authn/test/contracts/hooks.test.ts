import * as chai from 'chai';
import 'mocha';

import { AuthnResponseExtension, ExternalLoginHook, RoleSource } from '../../src/contracts/hooks.js';
import type { IAuthnPrincipalStorage } from '../../src/contracts/hooks.js';
import type { ExternalSubject, IdentityRef } from '../../src/contracts/credentials.js';
import type { Principal } from '../../src/contracts/principal.js';
import * as index from '../../src/contracts/index.js';
import { classMembers, declarationDocs, docOf, memberDocs, same, shapeOf } from './source-shape.js';

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

class GroupSync extends ExternalLoginHook {
  readonly synced: [IdentityRef, readonly string[]][] = [];
  async afterLogin(identity: IdentityRef, ext: ExternalSubject): Promise<void> {
    this.synced.push([identity, (ext.claims?.groups as readonly string[] | undefined) ?? []]);
  }
}

describe('hand-off and hook contracts', () => {
  describe('runtime', () => {
    it('exports the three hooks from the contracts index as plain abstract classes', () => {
      expect(index.AuthnResponseExtension).to.eq(AuthnResponseExtension);
      expect(index.RoleSource).to.eq(RoleSource);
      expect(index.ExternalLoginHook).to.eq(ExternalLoginHook);
      for (const c of [AuthnResponseExtension, RoleSource, ExternalLoginHook]) {
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

    it('every external login hook gets the identity and the mapped claims', async () => {
      const hooks = [new GroupSync(), new GroupSync()];
      for (const h of hooks) await h.afterLogin(alice, external);
      for (const h of hooks) expect(h.synced).to.deep.eq([[alice, ['eng', 'ops']]]);
    });
  });

  describe('source shape (member names, modifiers, parameter names)', () => {
    it('hooks.ts holds exactly the three hook classes', () => {
      expect(shapeOf(classMembers('hooks.ts'))).to.deep.eq({
        AuthnResponseExtension: { base: null, members: [{ name: 'extend', modifiers: ['abstract'], optional: false, params: ['kind', 'principal', 'body'] }] },
        RoleSource: { base: null, members: [{ name: 'rolesOf', modifiers: ['abstract'], optional: false, params: ['principal'] }] },
        ExternalLoginHook: { base: null, members: [{ name: 'afterLogin', modifiers: ['abstract'], optional: false, params: ['identity', 'external'] }] },
      });
    });

    it('docs carry the rules a reader needs', () => {
      const storage = memberDocs('hooks.ts', 'IAuthnPrincipalStorage');
      expect(Object.keys(storage)).to.deep.eq(['AuthnPrincipal']);
      expect(storage.AuthnPrincipal).to.contain('null: no or pending credentials');
      expect(storage.AuthnPrincipal).to.contain('AuthnPrincipalSource');
      expect(declarationDocs('hooks.ts').IAuthnPrincipalStorage).to.contain('AuthnMiddleware');

      const c = classMembers('hooks.ts');
      expect(c.AuthnResponseExtension.doc).to.contain('Array.ofType');
      expect(c.AuthnResponseExtension.doc).to.contain('Access');
      expect(docOf(c.AuthnResponseExtension.members, 'extend')).to.contain('body');
      expect(c.RoleSource.doc).to.contain('none registered ⇒ role switch off');
      expect(c.ExternalLoginHook.doc).to.contain('Array.ofType');
      expect(c.ExternalLoginHook.doc).to.contain('after a successful external login');
      expect(c.ExternalLoginHook.doc).to.contain('group');
      expect(c.ExternalLoginHook.doc).to.contain('AuthnService calls every hook');
      expect(c.ExternalLoginHook.doc).to.contain('before MFA and the session are issued');
      expect(c.ExternalLoginHook.doc).to.contain('issues no session');
      expect(c.ExternalLoginHook.doc).to.contain('a throw fails the login with the A02 answer');
      expect(c.ExternalLoginHook.doc).to.contain('not rolled back');
      expect(c.ExternalLoginHook.doc).to.contain('idempotent');
    });
  });

  describe('types', () => {
    it('re-exports every name from the contracts index', () => {
      same<index.IAuthnPrincipalStorage, IAuthnPrincipalStorage>(true);
      same<index.AuthnResponseExtension, AuthnResponseExtension>(true);
      same<index.RoleSource, RoleSource>(true);
      same<index.ExternalLoginHook, ExternalLoginHook>(true);
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
      same<Parameters<ExternalLoginHook['afterLogin']>, [IdentityRef, ExternalSubject]>(true);
      same<ReturnType<ExternalLoginHook['afterLogin']>, Promise<void>>(true);
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
      const c = () => new ExternalLoginHook();
      const hook: ExternalLoginHook = new GroupSync();
      // @ts-expect-error the identity is an IdentityRef, the external subject comes second
      const d = () => hook.afterLogin(external, alice);
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
