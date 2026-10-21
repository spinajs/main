import assert from 'node:assert/strict';
import 'mocha';
import { CookieJar, send } from '@spinajs/authn-testing';
import type { HttpPort, HttpResponse } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { ConfigScope, ROUTES, grantGlobal, registerRootRbac, removeAccounts, resetAuthnCaseServices, seedAccount, startUsersHttpApp, stopUsersHttpApp, useMfaStep, usersHttpApp } from '../support/http-app.js';

const PASSWORD = 'initial-Role-Pass-1';
const INITIAL = ['authz', 'principals', 'roleSwitch', 'initial'];

interface AccessBody {
  readonly Access: { readonly ceiling?: { readonly roles?: readonly string[] }; readonly permissions: readonly { readonly name: string }[] };
}

const permissions = (res: HttpResponse): string[] => (res.body as AccessBody).Access.permissions.map((p) => p.name);

describe('authz.principals.roleSwitch.initial over http: OrderedActiveRoleHook on the authn-http login routes', function () {
  this.timeout(120000);

  const scope = new ConfigScope();
  const seeded: IdentityRef[] = [];
  let users = 0;
  let h: { http: HttpPort };

  before(async function () {
    await startUsersHttpApp({ register: registerRootRbac });
    h = { http: usersHttpApp().httpPort() };
  });

  after(async function () {
    await stopUsersHttpApp();
  });

  beforeEach(() => resetAuthnCaseServices());

  afterEach(async () => {
    scope.restore();
    await removeAccounts(seeded.splice(0));
  });

  /** A user holding `admin` and `user` at GLOBAL. */
  async function adminAndUser(): Promise<{ ref: IdentityRef; login: string }> {
    const login = `initial-role-${++users}@users.test`;
    const ref = await seedAccount({ login, password: PASSWORD });
    seeded.push(ref);
    await grantGlobal(ref, ['admin', 'user']);
    return { ref, login };
  }

  const activeRole = async (jar: CookieJar) => (await send(h, { method: 'GET', path: '/auth/active-role' }, jar)).body as { ActiveRole: string | null; Roles: { role: string }[] };

  it('a login starts narrowed to the first role of the order the user holds; the answer and GET /auth/active-role say so', async () => {
    scope.set(INITIAL, { order: ['user', 'admin'] });
    const { login } = await adminAndUser();
    const jar = new CookieJar();

    const res = await send(h, ROUTES.login!(login, PASSWORD), jar);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body as AccessBody).Access.ceiling, { roles: ['user'] });
    assert.ok(!permissions(res).includes('user:impersonate'), `admin's grant is narrowed away: ${permissions(res).join(', ')}`);

    const state = await activeRole(jar);
    assert.equal(state.ActiveRole, 'user');
    assert.deepEqual(state.Roles.map((r) => r.role), ['admin', 'user']);
    const whoami = await send(h, ROUTES.whoami!(), jar);
    assert.deepEqual((whoami.body as AccessBody).Access.ceiling, { roles: ['user'] }, 'every later request carries the narrowing');
  });

  it('an MFA completion starts the session narrowed the same way', async () => {
    scope.set(INITIAL, { order: ['user', 'admin'] });
    const step = useMfaStep();
    const { ref, login } = await adminAndUser();
    step.enrol(ref);
    const jar = new CookieJar();

    const pending = await send(h, ROUTES.login!(login, PASSWORD), jar);
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.deepEqual((pending.body as { MfaRequired?: unknown }).MfaRequired, ['totp']);

    const verified = await send(h, ROUTES.mfaVerify!(step.nextCode(ref)), jar);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.deepEqual((verified.body as AccessBody).Access.ceiling, { roles: ['user'] });
    assert.equal((await activeRole(jar)).ActiveRole, 'user');
  });

  it('with the key null the session keeps every held role, as in 3.0.1', async () => {
    scope.set(INITIAL, null);
    const { login } = await adminAndUser();
    const jar = new CookieJar();

    const res = await send(h, ROUTES.login!(login, PASSWORD), jar);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as AccessBody).Access.ceiling, undefined);
    assert.ok(permissions(res).includes('user:impersonate'));
    assert.equal((await activeRole(jar)).ActiveRole, null);
  });
});
