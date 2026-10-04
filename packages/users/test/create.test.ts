import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { EmailSend } from '@spinajs/email';
import { AuthzConfigError, AuthzService, DefaultAuthzAdmin, SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PasswordService } from '@spinajs/authn/contracts';
import { join, normalize, resolve } from 'path';

import { AuthProvider, InvalidCredentials, PasswordProvider, SimpleDbAuthProvider, User, UserCreated, USER_COMMON_METADATA, passwordMatch } from '../src/index.js';
import { create } from '../src/actions.js';
import { TestConfiguration } from './common.test.js';
import { globalRolesOf, registerAuthzHost, rootAuthz } from './support/authz-host.js';
import { passwordCalls, resetPasswordCalls } from './support/password-service.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(err, 'expected a rejection').to.be.instanceOf(Error);
  return err as Error;
}

async function nothingWritten(login: string): Promise<void> {
  expect(await User.query().withDeleted().whereLogin(login).first(), 'no row, not even a soft-deleted one').to.not.exist;
}

describe('create(user, roles?)', function () {
  this.timeout(30000);

  let emit: sinon.SinonStub;

  before(() => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    registerAuthzHost();
  });

  beforeEach(async () => {
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));
    resetPasswordCalls();

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

  describe('roles', () => {
    it('grants the roles it is given as GLOBAL assignments', async () => {
      const { User: u } = await create({ Email: 'given@spinajs.pl', Login: 'given', Password: 'passw0rd123' }, ['editor', ' normal ']);

      expect(await globalRolesOf(u.Uuid)).to.have.members(['editor', 'normal']);
    });

    it('grants authz.rbac.defaultRoles when it is given none (L1-1)', async () => {
      const { User: u } = await create({ Email: 'defaults@spinajs.pl', Login: 'defaults', Password: 'passw0rd123' });
      const { User: empty } = await create({ Email: 'defaults2@spinajs.pl', Login: 'defaults2', Password: 'passw0rd123' }, []);

      expect(await globalRolesOf(u.Uuid)).to.deep.eq(['user']);
      expect(await globalRolesOf(empty.Uuid)).to.deep.eq(['user']);
    });

    it('creates a user without roles when it is given none and no defaults are configured', async () => {
      DI.get(Configuration)!.set('authz.rbac.defaultRoles', undefined);

      const { User: u } = await create({ Email: 'bare@spinajs.pl', Login: 'bare', Password: 'passw0rd123' });

      expect(await globalRolesOf(u.Uuid)).to.deep.eq([]);
    });

    it('refuses a role AuthzAdmin would refuse before anything is written', async () => {
      const err = await rejection(create({ Email: 'refused@spinajs.pl', Login: 'refused' }, ['admin.users']));

      expect(err).to.be.instanceOf(InvalidArgument);
      expect((err as InvalidArgument).errorCode).to.eq('not_assignable');
      await nothingWritten('refused');
      expect(passwordCalls).to.deep.eq([]);
    });

    it('removes the inserted account and rethrows when the real grant fails', async () => {
      const execute = DefaultAuthzAdmin.prototype.execute;
      sinon.stub(DefaultAuthzAdmin.prototype, 'execute').callsFake(function (this: DefaultAuthzAdmin, ...args: Parameters<DefaultAuthzAdmin['execute']>) {
        return args[2]?.dryRun ? execute.apply(this, args) : Promise.reject(new Error('assignment store down'));
      });

      await expect(create({ Email: 'half@spinajs.pl', Login: 'half', Metadata: { 'user:phone': '1' } }, ['editor'])).to.be.rejectedWith('assignment store down');

      await nothingWritten('half');
    });

    it('passes the actor to AuthzAdmin, so its guard runs for a caller', async () => {
      const { User: assigner } = await create({ Email: 'assigner@spinajs.pl', Login: 'assigner', Password: 'passw0rd123' }, ['assigner']);
      const actor: Principal = { type: 'user', id: assigner.Uuid, authenticated: true, source: 'session', attributes: {} };

      const err = await rejection(create({ Email: 'escalated@spinajs.pl', Login: 'escalated', Password: 'passw0rd123' }, ['admin'], actor));

      expect((err as { code?: string }).code).to.eq('escalation');
      await nothingWritten('escalated');
    });
  });

  describe('a supplied password', () => {
    it('is checked, then set through PasswordService after the insert, by the actor', async () => {
      const { User: u } = await create({ Email: 'pw@spinajs.pl', Login: 'pw', Password: 'passw0rd123' });

      expect(passwordCalls).to.have.lengthOf(1);
      expect(passwordCalls[0]).to.deep.include({ method: 'set', id: { type: 'user', id: u.Uuid }, password: 'passw0rd123', actor: { type: SYSTEM.type, id: SYSTEM.id } });
      expect(await passwordMatch('passw0rd123')(await User.query().whereLogin('pw').firstOrFail())).to.eq(true);
    });

    it('that breaks the policy refuses the create with the 2.x error, before anything is written', async () => {
      const err = await rejection(create({ Email: 'weak@spinajs.pl', Login: 'weak', Password: 'short' }));

      expect(err).to.be.instanceOf(InvalidArgument);
      expect((err as InvalidArgument).fieldName).to.eq('password');
      expect((err as InvalidArgument).errorCode).to.eq('E_PASSWORD_DOES_NOT_MEET_REQUIREMENTS');
      await nothingWritten('weak');
    });

    it("gets the plain 'created' mail, no invite and no invite marker", async () => {
      await create({ Email: 'welcome@spinajs.pl', Login: 'welcome', Password: 'passw0rd123' });

      const user = await User.query().whereLogin('welcome').populate('Metadata').firstOrFail();
      expect(user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING]).to.not.be.ok;
      expect(passwordCalls.map((c) => c.method)).to.deep.eq(['set']);
      expect(emit.args.map((a) => a[0]).filter((e) => e instanceof EmailSend)).to.have.lengthOf(1);
    });

    it('is not returned', async () => {
      const result = await create({ Email: 'noecho@spinajs.pl', Login: 'noecho', Password: 'passw0rd123' });

      expect(Object.keys(result)).to.deep.eq(['User']);
    });
  });

  describe('without a password', () => {
    it('stores none, marks the account invite-pending and invites it through PasswordService', async () => {
      const { User: u } = await create({ Email: 'invited@spinajs.pl', Login: 'invited' }, ['editor']);

      const user = await User.query().whereLogin('invited').populate('Metadata').firstOrFail();
      expect(user.Metadata[USER_COMMON_METADATA.USER_INVITE_PENDING]).to.eq(true);
      expect(user.IsActive).to.eq(false);
      expect(passwordCalls).to.have.lengthOf(1);
      expect(passwordCalls[0]).to.deep.include({ method: 'invite', id: { type: 'user', id: u.Uuid }, actor: { type: SYSTEM.type, id: SYSTEM.id } });
    });

    it('hands PasswordService only the reference of a caller actor', async () => {
      const { User: admin } = await create({ Email: 'creator@spinajs.pl', Login: 'creator', Password: 'passw0rd123' }, ['admin']);
      const actor: Principal = { type: 'user', id: admin.Uuid, authenticated: true, source: 'session', identity: admin, attributes: {} };
      resetPasswordCalls();

      await create({ Email: 'byadmin@spinajs.pl', Login: 'byadmin' }, ['editor'], actor);

      expect(passwordCalls[0].actor).to.deep.eq({ type: 'user', id: admin.Uuid });
    });

    it('leaves an account the legacy login refuses as invalid credentials, not a server error', async () => {
      await create({ Email: 'nologin@spinajs.pl', Login: 'nologin' });

      const auth = (await DI.resolve(AuthProvider)) as SimpleDbAuthProvider;
      await expect(auth.authenticate('nologin@spinajs.pl', 'passw0rd123')).to.be.rejectedWith(InvalidCredentials);
    });

    it('sends no users mail and writes no reset token', async () => {
      await create({ Email: 'nomail@spinajs.pl', Login: 'nomail' });

      const user = await User.query().whereLogin('nomail').populate('Metadata').firstOrFail();
      expect(emit.args.map((a) => a[0]).filter((e) => e instanceof EmailSend)).to.deep.eq([]);
      expect(Object.keys(user.Metadata).some((k) => k.startsWith('user:pwd_reset:'))).to.eq(false);
      expect(emit.args.map((a) => a[0]).some((e) => e instanceof UserCreated)).to.eq(true);
    });
  });

  describe('PasswordService', () => {
    it('missing from DI refuses the create, with or without a password, before anything is written', async () => {
      const hasRegistered = DI.RootContainer.hasRegistered.bind(DI.RootContainer);
      sinon.stub(DI.RootContainer, 'hasRegistered').callsFake((token: unknown, parent?: boolean) => (token === PasswordService ? false : hasRegistered(token as never, parent)));

      await expect(create({ Email: 'nopw1@spinajs.pl', Login: 'nopw1', Password: 'passw0rd123' })).to.be.rejectedWith(InvalidOption, /PasswordService/);
      await expect(create({ Email: 'nopw2@spinajs.pl', Login: 'nopw2' })).to.be.rejectedWith(InvalidOption, /PasswordService/);
      await nothingWritten('nopw1');
      await nothingWritten('nopw2');
    });
  });

  describe('the deprecated positional form', () => {
    it('still creates the user with its roles and password', async () => {
      const { User: u } = await create('positional@spinajs.pl', 'positional', ['editor'], { password: 'passw0rd123', metadata: { 'user:phone': '5' } });

      expect(await globalRolesOf(u.Uuid)).to.deep.eq(['editor']);
      expect(passwordCalls.map((c) => c.method)).to.deep.eq(['set']);
      const user = await User.query().whereLogin('positional').populate('Metadata').firstOrFail();
      expect(user.Metadata['user:phone']).to.eq('5');
    });
  });

  describe('authz.rbac.defaultRoles boot check (L1-1)', () => {
    for (const [value, fragment] of [
      [['ghost'], "role 'ghost'"],
      [['admin.users'], "role 'admin.users'"],
      ['user', 'must be an array of role names'],
      [['user', 7], 'must be an array of role names'],
    ] as const) {
      it(`fails the root boot for ${JSON.stringify(value)}`, async () => {
        DI.get(Configuration)!.set('authz.rbac.defaultRoles', value);

        const err = await rejection(DI.resolve(AuthzService) as Promise<unknown>);

        expect(err).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.contain('authz.rbac.defaultRoles');
        expect(err.message).to.contain(fragment);
      });
    }

    it('boots with valid default roles', async () => {
      expect(await rootAuthz()).to.be.instanceOf(AuthzService);
    });
  });
});
