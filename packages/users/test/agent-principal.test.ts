import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';
import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AssignmentSubject, Principal } from '@spinajs/authz';
import type { AuthnFacts, Ceiling, IdentityRef, PrincipalFactory } from '@spinajs/authn/contracts';

import { UserIsBanned, UserNotActive, UserPrincipalFactory } from '../src/index.js';
import { rootAdmin, rootAuthz } from './support/authz-host.js';
import { bootUsersDb, registerUsersTestHost, seedUser, setIdentityFlags } from './support/users-db.js';

chai.use(chaiAsPromised);

// What authn's DefaultAuthnService.principalOf passes for an agent token (authn-token validate, A15).
const FACTS: AuthnFacts = { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [], authenticatedAt: new Date('2026-10-05T10:00:00Z') };
const CEILING: Ceiling = { reason: 'out_of_scope' };

function configure(config: Configuration): void {
  config.set(['authz', 'permissions', 'doc:read'], {});
  config.set(['authz', 'rbac', 'roles', 'reader'], { grants: ['doc:read'] });
}

let seq = 0;

async function owner(): Promise<IdentityRef> {
  return (await seedUser({ login: `agent-owner-${++seq}` })).ref;
}

async function grant(subject: AssignmentSubject, role: string): Promise<void> {
  const results = await (await rootAdmin()).execute(SYSTEM, [{ kind: 'assignment.grant', subject, role, scope: GLOBAL }], { reason: 'test' });
  expect(results.every((r) => r.ok), JSON.stringify(results)).to.eq(true);
}

/** The agent path of DefaultAuthnService.principalOf: the owner first, then the agent acting for it. */
async function agentOf(factory: UserPrincipalFactory, ownerRef: IdentityRef, extra: Parameters<PrincipalFactory['principalOf']>[2] = {}): Promise<Principal> {
  const onBehalfOf = await factory.principalOf(ownerRef, FACTS, {});
  return factory.principalOf({ type: 'agent', id: `agent-token-${seq}` }, FACTS, { ceiling: CEILING, onBehalfOf, delegation: 'inherit', ...extra });
}

/** An owner principal as a caller may still hold it after the account changed. */
const stale = (ref: IdentityRef): Principal => ({ type: 'user', id: ref.id, authenticated: true, source: 'token', attributes: {} });

describe('UserPrincipalFactory: agent identities (A15)', function () {
  this.timeout(30000);

  let factory: UserPrincipalFactory;

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    await bootUsersDb(configure);
    factory = new UserPrincipalFactory();
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it('builds agent:<id> acting for its owner, with the delegation, ceiling, facts and attributes authn passes', async () => {
    const ref = await owner();
    const onBehalfOf = await factory.principalOf(ref, FACTS, {});

    const p = await factory.principalOf({ type: 'agent', id: 'agent-token-1' }, FACTS, { ceiling: CEILING, onBehalfOf, delegation: 'inherit', attributes: { from: 'strategy' } });

    expect(p).to.include({ type: 'agent', id: 'agent-token-1', authenticated: true, source: 'token', delegation: 'inherit' });
    expect(p.onBehalfOf).to.eq(onBehalfOf);
    expect(p.onBehalfOf).to.include({ type: 'user', id: ref.id });
    expect(p.ceiling).to.eq(CEILING);
    expect(p.authn).to.eq(FACTS);
    expect(p.attributes).to.deep.eq({ from: 'strategy' });
    expect(Object.isFrozen(p.attributes)).to.eq(true);
    expect(p, 'no user record: the agent is not its owner').to.not.have.property('identity');
  });

  it("leaves out a delegation authn does not pass (the contract's default is intersect)", async () => {
    const onBehalfOf = await factory.principalOf(await owner(), FACTS, {});

    const p = await factory.principalOf({ type: 'agent', id: 'agent-token-2' }, FACTS, { onBehalfOf });

    expect(p).to.not.have.property('delegation');
    expect(p).to.not.have.property('ceiling');
  });

  it('refuses an agent without a user to act for', async () => {
    await expect(factory.principalOf({ type: 'agent', id: 'agent-token-3' }, FACTS, {})).to.be.rejectedWith(InvalidArgument);
    await expect(factory.principalOf({ type: 'agent', id: 'agent-token-3' }, FACTS, { onBehalfOf: { type: 'service', id: 'svc', authenticated: true, source: 'token', attributes: {} } })).to.be.rejectedWith(InvalidArgument);
  });

  it('refuses a malformed agent id or delegation', async () => {
    const onBehalfOf = await factory.principalOf(await owner(), FACTS, {});

    await expect(factory.principalOf({ type: 'agent', id: '' }, FACTS, { onBehalfOf })).to.be.rejectedWith(InvalidArgument);
    await expect(factory.principalOf({ type: 'agent', id: 'agent-token-4' }, FACTS, { onBehalfOf, delegation: 'all' as 'inherit' })).to.be.rejectedWith(InvalidArgument);
  });

  for (const [state, flags, error] of [
    ['inactive', { active: false }, UserNotActive],
    ['banned', { banned: true }, UserIsBanned],
    ['deleted', { deleted: true }, ResourceNotFound],
  ] as const) {
    it(`refuses an agent whose owner is ${state}, also with an owner principal built before`, async () => {
      const ref = await owner();
      const before = await factory.principalOf(ref, FACTS, {});
      await setIdentityFlags(ref, flags);

      await expect(agentOf(factory, ref), 'through the owner principal').to.be.rejectedWith(error);
      await expect(factory.principalOf({ type: 'agent', id: 'agent-token-5' }, FACTS, { onBehalfOf: before, delegation: 'inherit' }), 'stale owner principal').to.be.rejectedWith(error);
      await expect(factory.principalOf({ type: 'agent', id: 'agent-token-5' }, FACTS, { onBehalfOf: stale(ref), delegation: 'inherit' }), 'bare owner principal').to.be.rejectedWith(error);
    });
  }

  describe('never more than its owner (authz over the built principal)', () => {
    it("acts with its owner's roles", async () => {
      const ref = await owner();
      await grant({ type: ref.type, id: ref.id }, 'reader');

      expect(await (await rootAuthz()).can(await agentOf(factory, ref), 'doc:read')).to.eq(true);
    });

    it('gets nothing from a role assigned to the agent itself, under inherit and under the default intersect', async () => {
      const ref = await owner();
      const agent = await agentOf(factory, ref);
      await grant({ type: 'agent', id: agent.id }, 'reader');
      const authz = await rootAuthz();

      expect(await authz.can(agent, 'doc:read'), 'inherit').to.eq(false);
      const { delegation: _inherit, ...intersect } = agent;
      expect(await authz.can(intersect, 'doc:read'), 'intersect').to.eq(false);
    });

    it('is narrowed by its ceiling', async () => {
      const ref = await owner();
      await grant({ type: ref.type, id: ref.id }, 'reader');

      expect(await (await rootAuthz()).can(await agentOf(factory, ref, { ceiling: { permissions: ['other:read'], reason: 'out_of_scope' } }), 'doc:read')).to.eq(false);
    });
  });
});
