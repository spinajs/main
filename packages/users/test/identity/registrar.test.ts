import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { InvalidArgument } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { DefaultQueueService } from '@spinajs/queue';
import { IdentityRegistrar } from '@spinajs/authn/contracts';
import type { AuthnContext } from '@spinajs/authn/contracts';
import { PasswordHasher } from '@spinajs/authn-local';
import { join, normalize, resolve } from 'path';

import { User, UserIdentityRegistrar, UserIdentityStore, identityRegistrar } from '../../src/index.js';
import { TestConfiguration } from '../common.test.js';
import { globalRolesOf, registerAuthzHost } from '../support/authz-host.js';
import { passwordCalls, resetPasswordCalls } from '../support/password-service.js';
import { testHasher } from '../support/hasher.js';

const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'request', ip: '198.51.100.7' });
const dto = (over: Partial<{ login: string; email: string; password: string }> = {}) => ({ login: 'newcomer', email: 'newcomer@spinajs.pl', password: 'passw0rd123', ...over });

class CountingHasher extends PasswordHasher {
  public static hashes = 0;
  public async hash(password: string): Promise<string> {
    CountingHasher.hashes++;
    return testHasher.hash(password);
  }
  public verify(stored: string | null | undefined, password: string): Promise<boolean> {
    return testHasher.verify(stored, password);
  }
  public needsRehash(): boolean {
    return false;
  }
}

async function boot(registration?: { enabled?: boolean; activate?: boolean }): Promise<void> {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }
  const config = await DI.resolve(Configuration, [null, null, [resolve(normalize(join(process.cwd(), 'test', 'config')))]]);
  if (registration) {
    config.set('users.registration', registration);
  }
  await DI.resolve(Orm);
}

const rowsWithEmail = async (email: string) => (await User.query().withDeleted().where('Email', email)).length;
const allRows = async () => (await User.query().withDeleted()).length;

describe('users: self-service registration (FEAT-4)', function () {
  this.timeout(30000);

  before(() => {
    DI.register(TestConfiguration).as(Configuration);
    registerAuthzHost();
    DI.register(CountingHasher).as(PasswordHasher);
  });

  beforeEach(() => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    resetPasswordCalls();
    CountingHasher.hashes = 0;
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  describe('registration', () => {
    it('is off by default: nothing resolves as the IdentityRegistrar', async () => {
      await boot();
      expect(await DI.resolve(IdentityRegistrar)).to.not.be.ok;
      expect(identityRegistrar(DI.RootContainer)).to.eq(null);
    });

    it('is off with users.registration.enabled false', async () => {
      await boot({ enabled: false });
      expect(await DI.resolve(IdentityRegistrar)).to.not.be.ok;
    });

    it('is on with users.registration.enabled true: a UserIdentityRegistrar', async () => {
      await boot({ enabled: true });
      expect(await DI.resolve(IdentityRegistrar)).to.be.instanceOf(UserIdentityRegistrar);
    });
  });

  describe('register', () => {
    let registrar: UserIdentityRegistrar;

    async function on(registration: { activate?: boolean } = {}): Promise<void> {
      await boot({ enabled: true, ...registration });
      registrar = (await DI.resolve(IdentityRegistrar)) as UserIdentityRegistrar;
    }

    it('creates an active account with the given password and the default roles, and answers created with its reference', async () => {
      await on();
      const res = await registrar.register(dto(), ctx());

      const row = await User.query().whereLogin('newcomer').firstOrFail();
      expect(res).to.deep.eq({ status: 'created', id: { type: 'user', id: row.Uuid } });
      expect(row.Email).to.eq('newcomer@spinajs.pl');
      expect(row.IsActive).to.eq(true);
      expect(await testHasher.verify(row.Password, 'passw0rd123')).to.eq(true);
      expect(await globalRolesOf(row.Uuid)).to.deep.eq(['user']);
      expect((await new UserIdentityStore().status(res.id)).addressVerified).to.eq(false);
    });

    it('leaves the account inactive with users.registration.activate false', async () => {
      await on({ activate: false });
      const res = await registrar.register(dto(), ctx());

      expect(res.status).to.eq('created');
      expect((await User.query().whereLogin('newcomer').firstOrFail()).IsActive).to.eq(false);
    });

    it('answers exists with the owner for a taken email, writes nothing and sets no password', async () => {
      await on();
      const first = await registrar.register(dto(), ctx());
      resetPasswordCalls();

      const again = await registrar.register(dto({ login: 'someone-else', password: 'other-passw0rd1' }), ctx());

      expect(again).to.deep.eq({ status: 'exists', id: first.id });
      expect(await rowsWithEmail('newcomer@spinajs.pl')).to.eq(1);
      expect(await User.query().whereLogin('someone-else').first()).to.not.be.ok;
      expect(passwordCalls).to.deep.eq([]);
      expect(await testHasher.verify((await User.query().whereLogin('newcomer').firstOrFail()).Password, 'passw0rd123')).to.eq(true);
    });

    it('answers exists for a taken login with another email, and for an email that differs in case', async () => {
      await on();
      const before = await allRows();
      const first = await registrar.register(dto(), ctx());

      expect(await registrar.register(dto({ email: 'fresh@spinajs.pl' }), ctx())).to.deep.eq({ status: 'exists', id: first.id });
      expect(await registrar.register(dto({ login: 'x', email: 'NEWCOMER@spinajs.pl' }), ctx())).to.deep.eq({ status: 'exists', id: first.id });
      expect(await allRows()).to.eq(before + 1);
    });

    it('does the hash work of a registration on the exists path too, so the two cannot be told apart by time', async () => {
      await on();
      await registrar.register(dto(), ctx());
      expect(CountingHasher.hashes, 'a new account is hashed by PasswordService, not the registrar').to.eq(0);

      await registrar.register(dto({ login: 'x' }), ctx());
      expect(CountingHasher.hashes).to.eq(1);
    });

    it('two simultaneous registrations of one address make one account', async () => {
      await on();
      const [a, b] = await Promise.all([registrar.register(dto(), ctx()), registrar.register(dto({ login: 'twin' }), ctx())]);

      expect([a.status, b.status].sort()).to.deep.eq(['created', 'exists']);
      expect(a.id).to.deep.eq(b.id);
      expect(await rowsWithEmail('newcomer@spinajs.pl')).to.eq(1);
    });

    it('refuses a password that breaks the policy with InvalidArgument and writes nothing', async () => {
      await on();
      const before = await allRows();
      const err = await registrar.register(dto({ password: 'short' }), ctx()).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(err).to.be.instanceOf(InvalidArgument);
      expect(await allRows()).to.eq(before);
    });

    it('refuses a reserved login', async () => {
      await on();
      const before = await allRows();
      const err = await registrar.register(dto({ login: '__system__' }), ctx()).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(err).to.be.instanceOf(InvalidArgument);
      expect(await allRows()).to.eq(before);
    });
  });
});
