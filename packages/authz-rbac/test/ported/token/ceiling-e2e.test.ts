import { GLOBAL } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';
import { anonymousPrincipal, fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, World } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { rbacHarness } from '../../model/harness.js';
import { tokenHandle } from '../../token/token-handle.js';
import type { TokenPrincipalRequest } from '../../token/token-handle.js';

const expect = chai.expect;
const { assignment, combine, role } = fixtureDsl;

const erin = userPrincipal('erin');
const gus = userPrincipal('gus');
const ada = userPrincipal('ada');

/**
 * The 2.x token-protected routes: `res:own` is `readOwn` (user), `res:any` is `readAny` (admin only), guest holds nothing.
 * erin holds user; gus holds user and guest; ada holds user and admin.
 */
const world: World = {
  permissions: ['res:own', 'res:any'],
  principals: { erin, gus, ada },
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('user', ['res:own']), role('admin', ['res:any']), role('guest', [])],
    assignments: [assignment('e1', erin, 'user'), assignment('g1', gus, 'user'), assignment('g2', gus, 'guest'), assignment('a1', ada, 'user'), assignment('a2', ada, 'admin')],
  },
};

interface Opened {
  readonly authz: AuthzService;
  token(req: Omit<TokenPrincipalRequest, 'owner'> & { owner: Principal }): Promise<Principal>;
  allowed(p: Principal, permission: string): Promise<boolean>;
  status(p: Principal, permission: string): Promise<'allowed' | 'unauthenticated' | 'forbidden'>;
}

function useLane() {
  const harness = rbacHarness({
    facets: ['token'],
    extend: (_host, session) => ({ lane: { token: tokenHandle(session.clock!) } }),
  });
  const sessions: HarnessSession[] = [];
  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.dispose();
  });
  return async (): Promise<Opened> => {
    const session = await harness.setup(world, { id: 'B24', part: 'token-ported', case: 'token-ported', title: 'token-ported', facets: ['engine', 'rbac', 'list', 'token'] });
    sessions.push(session);
    const authz = session.authz as unknown as AuthzService;
    const handle = session.lane!.token as ReturnType<typeof tokenHandle>;
    const allowed = async (principal: Principal, permission: string) => {
      const d = await authz.check({ principal, permission, resource: GLOBAL });
      return d.allowed && d.residual.op === 'true';
    };
    return {
      authz,
      token: (req) => handle.principal(req),
      allowed,
      // authn-http turns 'unauthenticated' into 401 and 'forbidden' into 403.
      status: async (principal, permission) => (await allowed(principal, permission)) ? 'allowed' : principal.authenticated ? 'forbidden' : 'unauthenticated',
    };
  };
}

describe('authz-rbac ported token: a token at an @Access route', function () {
  this.timeout(30_000);
  const open = useLane();

  it('a token with the grant reaches the route; the same owner via session does too (token-policy-e2e 1, token-policies 2)', async () => {
    const { token, status } = await open();
    const t = await token({ owner: erin, roles: ['user'] });
    expect(t.source).to.equal('token');
    expect(await status(t, 'res:own')).to.equal('allowed');
    expect(await status(erin, 'res:own')).to.equal('allowed');
  });

  it('no credential is unauthenticated, a token without the grant is forbidden (token-policies 1, 3)', async () => {
    const { token, status } = await open();
    expect(await status(anonymousPrincipal(), 'res:own')).to.equal('unauthenticated');
    const guest = await token({ owner: gus, roles: ['guest'] });
    expect(await status(guest, 'res:own')).to.equal('forbidden');
    expect(await status(gus, 'res:own')).to.equal('allowed');
  });

  it('a token narrower than its owner is denied what only the other role grants (token-policy-e2e 5)', async () => {
    const { token, status } = await open();
    const t = await token({ owner: gus, roles: ['guest'] });
    expect(t.authenticated).to.equal(true);
    expect(await status(t, 'res:own')).to.equal('forbidden');
    expect(await status(gus, 'res:own')).to.equal('allowed');
  });

  it('a multi-role token uses the whole set, not its first role (token-policy-e2e 6)', async () => {
    const { token, allowed } = await open();
    const t = await token({ owner: ada, roles: ['user', 'admin'] });
    expect(await allowed(t, 'res:own'), 'the token is usable at all').to.equal(true);
    expect(await allowed(t, 'res:any'), 'the grant of the second role').to.equal(true);
  });

  it('the ceiling keeps the token roles as given, with no role pinned (token-middleware 2)', async () => {
    const { token } = await open();
    const t = await token({ owner: ada, roles: ['user', 'admin'] });
    expect(t.ceiling?.roles).to.deep.equal(['user', 'admin']);
    expect(Object.keys(t).filter((k) => /active/i.test(k))).to.deep.equal([]);
    expect(Object.keys(t.attributes).filter((k) => /role/i.test(k))).to.deep.equal([]);
  });

  it('a ceiling never widens: owner roles outside it stay out (token-policy-e2e 7)', async () => {
    const { token, allowed } = await open();
    const t = await token({ owner: ada, roles: ['user'] });
    expect(await allowed(t, 'res:own')).to.equal(true);
    expect(await allowed(t, 'res:any'), "the owner's admin leaked into the token").to.equal(false);
    expect(await allowed(ada, 'res:any')).to.equal(true);
  });

  it('a token cannot pick a role its owner lacks, whichever role it names (token-policy-e2e 7, B07)', async () => {
    const { token, allowed } = await open();
    const t = await token({ owner: erin, roles: ['user', 'admin'] });
    expect(await allowed(t, 'res:own')).to.equal(true);
    expect(await allowed(t, 'res:any')).to.equal(false);
  });
});
