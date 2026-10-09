import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { GLOBAL, RelationResolver, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { join, normalize, resolve } from 'path';

import { User, UserPrincipalFactory, UserSelfRelation, UsersSelfRelation } from '../src/index.js';
import { activate, create } from '../src/actions.js';
import { TestConfiguration } from './common.test.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { registerAuthzHost, rootAdmin, rootAuthz } from './support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

const OTHER_UUID = '6f1c1c55-3c1e-4a8f-9b9a-2f4f0c1d2e3a';

function principal(type: string, id: string, extra: Partial<Principal> = {}): Principal {
  return { type, id, authenticated: true, source: 'session', attributes: {}, ...extra };
}

describe('self relation', function () {
  this.timeout(30000);

  describe('resolvers', () => {
    for (const [Resolver, type] of [
      [UserSelfRelation, 'user'],
      [UsersSelfRelation, 'users'],
    ] as const) {
      describe(`${type}:self`, () => {
        const r = new Resolver();

        it(`is relation 'self' of type '${type}'`, () => {
          expect(r.type).to.eq(type);
          expect(r.relation).to.eq('self');
        });

        it("holds for the user's own ref only", async () => {
          expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: TEST_USER_UUID })).to.eq(true);
          expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: OTHER_UUID })).to.eq(false);
        });

        it('never holds on a type-level ref', async () => {
          expect(await r.holds(principal('user', TEST_USER_UUID), { type })).to.eq(false);
        });

        it('never holds for a principal that is not a user, whatever its id', async () => {
          expect(await r.holds(principal('service', TEST_USER_UUID), { type, id: TEST_USER_UUID })).to.eq(false);
          expect(await r.holds(SYSTEM, { type, id: 'system' })).to.eq(false);
        });

        it('does not read through onBehalfOf: an agent or a delegate holds self only as itself', async () => {
          const owner = principal('user', TEST_USER_UUID);

          expect(await r.holds(principal('agent', 'a-1', { onBehalfOf: owner, delegation: 'inherit' }), { type, id: TEST_USER_UUID })).to.eq(false);
          expect(await r.holds(principal('user', OTHER_UUID, { onBehalfOf: owner, delegation: 'intersect' }), { type, id: TEST_USER_UUID })).to.eq(false);
          expect(await r.holds(principal('user', OTHER_UUID, { onBehalfOf: owner, delegation: 'intersect' }), { type, id: OTHER_UUID })).to.eq(true);
        });

        describe('with a row (the subject the engine evaluates the residual against)', () => {
          const own = { Id: 7, Uuid: TEST_USER_UUID };
          const other = { Id: 8, Uuid: OTHER_UUID };

          it('decides on the row: a ref keyed by the numeric Id holds for the own row', async () => {
            expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: '7' }, own)).to.eq(true);
            expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: TEST_USER_UUID }, own)).to.eq(true);
          });

          it("the row wins over the ref: the own Uuid in the ref does not open another user's row", async () => {
            expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: TEST_USER_UUID }, other)).to.eq(false);
          });

          it('refuses a ref that names neither the row Uuid nor its Id', async () => {
            expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: OTHER_UUID }, own)).to.eq(false);
          });

          it('refuses a subject that is not a user row, and keeps the type-level and non-user refusals', async () => {
            expect(await r.holds(principal('user', TEST_USER_UUID), { type, id: TEST_USER_UUID }, { Name: 'x' })).to.eq(false);
            expect(await r.holds(principal('user', TEST_USER_UUID), { type }, own)).to.eq(false);
            expect(await r.holds(principal('service', TEST_USER_UUID), { type, id: TEST_USER_UUID }, own)).to.eq(false);
          });
        });
      });
    }
  });

  describe('through a real host', () => {
    before(() => {
      DI.register(TestConfiguration).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      registerAuthzHost();
    });

    beforeEach(async () => {
      sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

      for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
        await b.bootstrap();
      }

      await DI.resolve(Configuration, [null, null, [dir('./config')]]);
      await DI.resolve(Orm);
    });

    afterEach(() => {
      sinon.restore();
      DI.clearCache();
    });

    it('registers one resolver per type in the RelationResolver chain', async () => {
      const chain = (await DI.RootContainer.resolve(Array.chainOf(RelationResolver))) as RelationResolver[];
      const self = chain.filter((r) => r.relation === 'self').map((r) => r.type);

      expect(self).to.have.members(['user', 'users']);
      expect(self).to.have.lengthOf(2);
    });

    it("a role granting user:read with relation 'self' reads the user's own ref and not another user's", async () => {
      await (await rootAdmin()).assign(SYSTEM, { subject: { type: 'user', id: TEST_USER_UUID }, role: 'self-reader', scope: GLOBAL });
      const own = await User.query().whereLogin('test').populate('Metadata').firstOrFail();
      const other = await User.query().whereLogin('test-banned').firstOrFail();
      const me = await ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory).principalOf(own);
      const authz = await rootAuthz();

      // The row is the subject: without one the decision stays conditional on the relation.
      expect(await authz.can(me, 'user:read', { type: 'user', id: own.Uuid }, own)).to.eq(true);
      expect(await authz.can(me, 'user:read', { type: 'user', id: other.Uuid }, other)).to.eq(false);

      const unbound = await authz.check({ principal: me, permission: 'user:read', resource: { type: 'user', id: other.Uuid } });
      expect(unbound.residual).to.deep.eq({ op: 'relation', relation: 'self' });
    });

    it("on users, a ref keyed by the numeric Id opens the own row and not another user's", async () => {
      const { User: created } = await create('selfie@spinajs.pl', 'selfie', ['self-reader'], { password: 'passw0rd123' });
      await activate(created.Uuid);
      const own = await User.query().whereLogin('selfie').populate('Metadata').firstOrFail();
      const other = await User.query().whereLogin('test').firstOrFail();
      const me = await ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory).principalOf(own);
      const authz = await rootAuthz();

      expect(await authz.can(me, 'users:read', { type: 'users', id: String(own.Id) }, own)).to.eq(true);
      expect(await authz.can(me, 'users:read', { type: 'users', id: String(other.Id) }, other)).to.eq(false);
      expect(await authz.can(me, 'users:read', { type: 'users', id: String(own.Id) }, other), 'the row decides, not the ref').to.eq(false);
    });
  });
});
