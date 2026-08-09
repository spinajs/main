import 'mocha';
import { expect } from 'chai';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User } from '@spinajs/rbac';
import { InvalidOperation } from '@spinajs/exceptions';

import { Default2FaToken, TWO_FA_METATADATA_KEYS } from '../src/2fa/Default2FaToken.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * The three-state enrolment machine: none -> pending -> enabled.
 *
 * `pending` is the state that did not exist before: the secret is stored, but
 * `2fa:enabled` is not set, so the login check does not yet demand a code.
 */
describe('Default2FaToken enrolment states', function () {
  this.timeout(25000);

  const USER_UUID = '99999999-2222-4222-8222-999999999999';

  let user: User;
  let provider: Default2FaToken;

  before(() => {
    DI.setESMModuleSupport();
  });

  beforeEach(async () => {
    DI.clearCache();

    DI.register(DbTestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
    DI.register(SimpleDbAuthProvider).as(AuthProvider);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration);
    await DI.resolve(Orm);

    const pwd = DI.resolve(BasicPasswordProvider);
    user = new User({
      Uuid: USER_UUID,
      Email: 'enrolment@spinajs.pl',
      Login: 'enrolment',
      Password: await pwd.hash('current123'),
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();

    provider = await DI.resolve(Default2FaToken);
  });

  afterEach(async () => {
    DI.clearCache();
  });

  const reload = async () => await User.where({ Uuid: USER_UUID }).populate('Metadata').firstOrFail();

  it('beginEnrolment stores the secret without enabling 2fa', async () => {
    const url = await provider.beginEnrolment(user);

    expect(url).to.match(/^otpauth:\/\//);

    const stored = await reload();
    expect(stored.Metadata[TWO_FA_METATADATA_KEYS.TOKEN], 'the secret must be persisted').to.be.a('string');
    expect(stored.Metadata[TWO_FA_METATADATA_KEYS.ENABLED], 'enrolment is not proven yet').to.not.equal(true);
  });

  it('beginEnrolment replaces the secret of a pending enrolment', async () => {
    await provider.beginEnrolment(user);
    const first = (await reload()).Metadata[TWO_FA_METATADATA_KEYS.TOKEN];

    await provider.beginEnrolment(await reload());
    const second = (await reload()).Metadata[TWO_FA_METATADATA_KEYS.TOKEN];

    expect(second, 'an abandoned enrolment must be replaceable').to.not.equal(first);
  });

  it('beginEnrolment refuses on an already enabled account', async () => {
    await provider.initialize(user);

    let thrown: unknown = null;
    try {
      await provider.beginEnrolment(await reload());
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'an enabled device must be disabled before re-enrolling').to.be.instanceOf(InvalidOperation);
  });

  it('activate flips a pending enrolment to enabled', async () => {
    await provider.beginEnrolment(user);

    await provider.activate(await reload());

    expect((await reload()).Metadata[TWO_FA_METATADATA_KEYS.ENABLED]).to.equal(true);
  });

  it('activate refuses when there is no secret', async () => {
    let thrown: unknown = null;
    try {
      await provider.activate(user);
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'nothing to activate without a stored secret').to.be.instanceOf(InvalidOperation);
  });

  it('initialize still enables immediately', async () => {
    await provider.initialize(user);

    const stored = await reload();
    expect(stored.Metadata[TWO_FA_METATADATA_KEYS.TOKEN]).to.be.a('string');
    expect(stored.Metadata[TWO_FA_METATADATA_KEYS.ENABLED], 'the CLI, admin reset and seeding rely on this').to.equal(true);
  });
});
