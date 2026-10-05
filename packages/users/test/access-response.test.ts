import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { AuthzDomains, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AccessSummary, AuthzCommand, AuthzService, Principal } from '@spinajs/authz';
import { AuthnResponseExtension } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';

import { AccessResponseExtension, UserPrincipalFactory, buildUserWithAccess } from '../src/index.js';
import { rootAdmin, rootAuthz } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

chai.use(chaiAsPromised);

const FACTS: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['totp'], authenticatedAt: new Date('2026-10-01T10:00:00Z'), sessionHandle: 'h-1' };

const KINDS = ['login', 'mfa', 'role-switch', 'impersonation', 'whoami'] as const;

function configure(config: Configuration): void {
  for (const p of ['doc:read', 'doc:write']) {
    config.set(['authz', 'permissions', p], {});
  }
  config.set(['authz', 'rbac', 'roles', 'editor'], { grants: ['doc:read', 'doc:write'] });
  config.set(['authz', 'rbac', 'roles', 'viewer'], { grants: ['doc:read'] });
}

let seq = 0;

async function user(...roles: string[]): Promise<IdentityRef> {
  const { ref } = await seedUser({ login: `acc-${++seq}` });
  const commands: AuthzCommand[] = roles.map((role) => ({ kind: 'assignment.grant', subject: { type: ref.type, id: ref.id }, role, scope: GLOBAL }));
  const results = await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test' });
  expect(
    results.every((r) => r.ok),
    JSON.stringify(results),
  ).to.eq(true);
  return ref;
}

const signedIn = (ref: IdentityRef): Promise<Principal> => new UserPrincipalFactory().principalOf(ref, FACTS, {});

const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('AccessResponseExtension and buildUserWithAccess (users DB, root authz host)', function () {
  this.timeout(30000);

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('is an AuthnResponseExtension that Array.ofType resolves', async () => {
    const extensions = await DI.resolve(Array.ofType(AuthnResponseExtension));

    expect(extensions.some((e) => e instanceof AccessResponseExtension)).to.eq(true);
  });

  it('adds Access, what GET /user/access answers, for every kind and keeps the body', async () => {
    const principal = await signedIn(await user('editor'));
    const summary = asJson(await (await rootAuthz()).summary(principal)) as AccessSummary;
    expect(summary.permissions.map((p) => p.name)).to.include.members(['doc:read', 'doc:write']);

    for (const kind of KINDS) {
      const body: Record<string, unknown> = { Uuid: principal.id };
      await new AccessResponseExtension().extend(kind, principal, body);

      expect(asJson(body), kind).to.deep.eq({ Uuid: principal.id, Access: summary });
    }
  });

  it('answers in the domain of authz.http.access.domain', async () => {
    const principal = await signedIn(await user('viewer'));
    const answer = { principal: { type: 'user', id: principal.id }, models: [], permissions: [{ name: 'doc:other', conditional: false }] } as AccessSummary;
    const summary = sinon.stub().resolves(answer);
    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    const container = domains.create('c3-access');
    sinon
      .stub(domains, 'service')
      .withArgs('c3-access')
      .resolves({ summary } as unknown as AuthzService);
    (await DI.resolve(Configuration)).set(['authz', 'http', 'access', 'domain'], 'c3-access');
    try {
      const body: Record<string, unknown> = {};
      await new AccessResponseExtension().extend('login', principal, body);

      expect(body.Access).to.eq(answer);
      expect(summary.calledOnceWithExactly(principal)).to.eq(true);
    } finally {
      await container.dispose();
    }
  });

  it('rejects when the summary fails, without adding Access', async () => {
    const principal = await signedIn(await user('viewer'));
    sinon.stub(await rootAuthz(), 'summary').rejects(new Error('store down'));

    const body: Record<string, unknown> = {};
    await expect(new AccessResponseExtension().extend('whoami', principal, body)).to.be.rejectedWith('store down');
    expect(body).to.not.have.property('Access');
  });

  it('buildUserWithAccess: the dehydrated user plus Access, no 2.x Role, ActiveRole or Grants', async () => {
    const ref = await user('editor');
    const stored = await storedUser(ref.id);
    const principal = await signedIn(ref);

    const payload = asJson(await buildUserWithAccess(stored, principal)) as Record<string, unknown>;

    const { Access, ...rest } = payload;
    expect(rest).to.deep.eq(asJson(stored.dehydrateWithRelations({ dateTimeFormat: 'iso' })));
    expect(Access).to.deep.eq(asJson(await (await rootAuthz()).summary(principal)));
    expect(payload).to.include({ Uuid: ref.id, Login: stored.Login });
    expect(payload).to.not.have.any.keys('Role', 'ActiveRole', 'Grants', 'Password');
  });
});
