import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { GLOBAL, ResourceAdapter, SYSTEM } from '@spinajs/authz';
import { join, normalize, resolve } from 'path';

import { AuthProvider, PasswordProvider, SimpleDbAuthProvider, User, UserPrincipalFactory, UserResourceAdapter } from '../src/index.js';
import { activate, create } from '../src/actions.js';
import { TestConfiguration } from './common.test.js';
import { TEST_USER_UUID } from './migration/rbac.migration.js';
import { registerAuthzHost, rootAuthz } from './support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

const UNKNOWN_UUID = '0d7f3b8e-5a4e-4c1e-8f61-3b7a2c9d1e44';

async function adapter(): Promise<UserResourceAdapter> {
  const chain = (await DI.RootContainer.resolve(Array.chainOf(ResourceAdapter))) as ResourceAdapter[];
  return chain.find((a) => a instanceof UserResourceAdapter) as UserResourceAdapter;
}

describe('UserResourceAdapter', function () {
  this.timeout(30000);

  before(() => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
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

  it("is the one ResourceAdapter of type 'user' in the host chain, and leaves 'users' alone", async () => {
    const chain = (await DI.RootContainer.resolve(Array.chainOf(ResourceAdapter))) as ResourceAdapter[];

    expect(chain.filter((a) => a.types.includes('user'))).to.have.lengthOf(1);
    expect((await adapter()).types).to.deep.eq(['user']);
    expect((await adapter()).relations).to.eq(undefined);
  });

  it('accepts no object, so user records stay with the adapter of users; refOf still gives user:<Uuid>', async () => {
    const a = await adapter();
    const user = await User.query().whereLogin('test').firstOrFail();

    expect(a.accepts(user)).to.eq(false);
    expect(a.accepts({ Uuid: TEST_USER_UUID })).to.eq(false);
    expect(a.refOf(user)).to.deep.eq({ type: 'user', id: TEST_USER_UUID });
  });

  it('does not turn a user record into a user ref for a users permission', async () => {
    const me = await ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory).principalOf(await User.query().whereLogin('test').populate('Metadata').firstOrFail());
    const record = await User.query().whereLogin('test').firstOrFail();

    const err = await (await rootAuthz()).can(me, 'users:read', record).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).to.match(/neither accepted by an adapter nor a ResourceRef/);
    expect(err?.message).to.not.match(/type "user"/);
  });

  it('answers [ref, GLOBAL] for a user that exists or a type-level ref, and null for an unknown or soft-deleted one', async () => {
    const a = await adapter();
    const deleted = await User.query().withDeleted().whereLogin('test-deleted').firstOrFail();

    expect(await a.ancestors({ type: 'user', id: TEST_USER_UUID })).to.deep.eq([{ type: 'user', id: TEST_USER_UUID }, GLOBAL]);
    expect(await a.ancestors({ type: 'user' })).to.deep.eq([{ type: 'user' }, GLOBAL]);
    expect(await a.ancestors({ type: 'user', id: UNKNOWN_UUID })).to.eq(null);
    expect(await a.ancestors({ type: 'user', id: deleted.Uuid })).to.eq(null);
    expect(await a.ancestors({ type: 'user', id: 'not-a-uuid' })).to.eq(null);
  });

  it('loads the row with metadata, as SYSTEM; null when there is none', async () => {
    const a = await adapter();
    const runAs = sinon.spy(await rootAuthz(), 'runAs');

    const row = await a.load({ type: 'user', id: TEST_USER_UUID });

    expect(row).to.be.instanceOf(User);
    expect(row!.Metadata['test:test']).to.eq('test');
    expect(runAs.firstCall.args.slice(0, 2)).to.deep.eq([SYSTEM, 'user-resource-adapter']);
    expect(await a.load({ type: 'user', id: UNKNOWN_UUID })).to.eq(null);
    expect(await a.load({ type: 'user' })).to.eq(null);
  });

  describe("end to end: a 'self' grant on user:read", () => {
    async function selfReader() {
      const { User: created } = await create('reader@spinajs.pl', 'reader', ['self-reader'], { password: 'passw0rd123' });
      await activate(created.Uuid);
      const own = await User.query().whereLogin('reader').populate('Metadata').firstOrFail();
      const me = await ((await DI.resolve(UserPrincipalFactory)) as UserPrincipalFactory).principalOf(own);
      return { own, me, authz: await rootAuthz() };
    }

    it('a user ref with the record as subject: the row decides', async () => {
      const { own, me, authz } = await selfReader();
      const other = await User.query().whereLogin('test').firstOrFail();
      const a = await adapter();

      expect(await authz.can(me, 'user:read', a.refOf(own), own)).to.eq(true);
      expect(await authz.can(me, 'user:read', a.refOf(other), other)).to.eq(false);
    });

    it("a ref plus the row the adapter loads (what authz-http's subject: 'load' does) allows the own Uuid only", async () => {
      const { own, me, authz } = await selfReader();
      const a = await adapter();

      const ownRef = { type: 'user', id: own.Uuid };
      const otherRef = { type: 'user', id: TEST_USER_UUID };
      expect(await authz.can(me, 'user:read', ownRef, await a.load(ownRef))).to.eq(true);
      expect(await authz.can(me, 'user:read', otherRef, await a.load(otherRef))).to.eq(false);
    });

    it('an unknown user is denied as an unknown resource', async () => {
      const { me, authz } = await selfReader();

      const d = await authz.check({ principal: me, permission: 'user:read', resource: { type: 'user', id: UNKNOWN_UUID } });
      expect(d.allowed).to.eq(false);
      expect(d.reason?.code).to.eq('unknown_resource');
    });
  });
});
