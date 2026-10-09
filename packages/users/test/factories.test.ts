import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';
import { join, normalize, resolve } from 'path';

import { AuthProvider, PasswordProvider, SimpleDbAuthProvider, SYSTEM_LOGIN, User, isReservedLogin } from '../src/index.js';
import { assertUserUnique, create } from '../src/actions.js';
import { TestConfiguration } from './common.test.js';
import { registerAuthzHost } from './support/authz-host.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('users bootstrap: reserved logins, 2.x AccessControl', function () {
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

  describe('reserved logins', () => {
    for (const login of [SYSTEM_LOGIN, '__anything__']) {
      it(`create() refuses the login ${login}`, async () => {
        const err = await create({ Email: `${login.replace(/_/g, 'x')}@spinajs.pl`, Login: login, Password: 'passw0rd123' }).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(err).to.be.instanceOf(InvalidArgument);
        expect((err as InvalidArgument).fieldName).to.eq('login');
        expect(await User.query().withDeleted().whereLogin(login).first()).to.not.exist;
      });
    }

    for (const login of [SYSTEM_LOGIN, '＿＿system＿＿']) {
      it(`assertUserUnique refuses the login ${login}, so a rename cannot take it`, async () => {
        const err = await assertUserUnique(login, undefined, 1).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(err).to.be.instanceOf(InvalidArgument);
        expect((err as InvalidArgument).fieldName).to.eq('login');
      });
    }

    it('counts a full-width underscore as an underscore', () => {
      expect(isReservedLogin('＿＿system＿＿')).to.eq(true);
      expect(isReservedLogin('_system_')).to.eq(false);
    });
  });

  it("keeps the deprecated 'AccessControl' registration for 2.x consumers", () => {
    expect(DI.get('AccessControl')).to.not.eq(undefined);
  });
});
