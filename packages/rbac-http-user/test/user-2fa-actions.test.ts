import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';

import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { DefaultQueueService } from '@spinajs/queue';

import { AuthProvider, BasicPasswordProvider, PasswordProvider, SimpleDbAuthProvider, User, UserMetadata } from '@spinajs/rbac';

import * as OTPAuth from 'otpauth';
import { beginUser2FaEnrolment, confirmUser2Fa, disableUser2Fa, enableUser2Fa, resetUser2Fa } from '../src/actions/2fa.js';
import { TWO_FA_METATADATA_KEYS } from '../src/2fa/Default2FaToken.js';
import { User2FaEnabled } from '../src/events/User2FaEnabled.js';
import { User2FaDisabled } from '../src/events/User2FaDisabled.js';
import { User2FaReset } from '../src/events/User2FaReset.js';
import { DbTestConfiguration } from './db-common.js';

/**
 * Database backed tests for the 2FA actions used by both the user-facing
 * TwoFactorAuthController and the admin "reset 2fa" route.
 */

describe('2FA actions', function () {
  this.timeout(25000);

  const USER_UUID = '99999999-1111-4111-8111-999999999999';

  let emitStub: sinon.SinonStub;
  let user: User;

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

    emitStub = sinon.stub(DefaultQueueService.prototype, 'emit').returns(Promise.resolve(undefined));

    const pwd = DI.resolve(BasicPasswordProvider);
    user = new User({
      Uuid: USER_UUID,
      Email: 'twofa@spinajs.pl',
      Login: 'twofa',
      Password: await pwd.hash('current123'),
      Role: ['user'],
      IsActive: true,
    });
    await user.insert();
  });

  afterEach(async () => {
    sinon.restore();
    DI.clearCache();
  });

  const events = () => emitStub.getCalls().map((c) => c.args[0]);
  const secretCount = () => UserMetadata.where({ user_id: user.Id }).whereIn('Key', [TWO_FA_METATADATA_KEYS.TOKEN, TWO_FA_METATADATA_KEYS.ENABLED, TWO_FA_METATADATA_KEYS.OTP]).selectCount();

  it('enable stores the secrets and returns the otpauth url', async () => {
    const url = await enableUser2Fa(USER_UUID);

    expect(url, 'the otpauth url is what the caller shows as a qr code').to.be.a('string');
    expect(String(url)).to.match(/^otpauth:\/\//);
    expect(await secretCount()).to.be.greaterThan(0);
  });

  it('enable emits User2FaEnabled for the user', async () => {
    await enableUser2Fa(USER_UUID);

    const ev = events().find((e) => e instanceof User2FaEnabled);
    expect(ev, 'User2FaEnabled must be emitted').to.be.not.undefined;
    expect((ev as User2FaEnabled).UserUUID, 'the event must carry the user, not the otpauth url').to.eq(USER_UUID);
  });

  it('disable clears the secrets and emits User2FaDisabled', async () => {
    await enableUser2Fa(USER_UUID);
    emitStub.resetHistory();

    await disableUser2Fa(USER_UUID);

    expect(await secretCount(), 'secrets must be gone once disable resolves').to.eq(0);

    const ev = events().find((e) => e instanceof User2FaDisabled);
    expect(ev, 'User2FaDisabled must be emitted — not User2FaEnabled').to.be.not.undefined;
    expect((ev as User2FaDisabled).UserUUID).to.eq(USER_UUID);
  });

  it('reset clears the secrets and emits User2FaReset', async () => {
    await enableUser2Fa(USER_UUID);
    emitStub.resetHistory();

    await resetUser2Fa(USER_UUID);

    expect(await secretCount(), 'reset must await the provider before returning').to.eq(0);

    const ev = events().find((e) => e instanceof User2FaReset);
    expect(ev, 'User2FaReset must be emitted').to.be.not.undefined;
    expect((ev as User2FaReset).UserUUID).to.eq(USER_UUID);
  });

  it('reset leaves an account that never enabled 2fa untouched', async () => {
    await resetUser2Fa(USER_UUID);

    expect(await secretCount()).to.eq(0);
  });

  it('beginUser2FaEnrolment stores a secret but emits no enabled event', async () => {
    const url = await beginUser2FaEnrolment(USER_UUID);

    expect(String(url)).to.match(/^otpauth:\/\//);
    expect(await secretCount(), 'the secret and the otpauth url are stored').to.be.greaterThan(0);

    const ev = events().find((e) => e instanceof User2FaEnabled);
    expect(ev, 'enrolment is not a fact until the user confirms it').to.be.undefined;
  });

  it('confirmUser2Fa activates and emits User2FaEnabled on a valid code', async () => {
    await beginUser2FaEnrolment(USER_UUID);
    emitStub.resetHistory();

    const stored = await User.where({ Uuid: USER_UUID }).populate('Metadata').firstOrFail();
    const secret = String(stored.Metadata[TWO_FA_METATADATA_KEYS.TOKEN]);
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();

    await confirmUser2Fa(USER_UUID, code);

    const after = await User.where({ Uuid: USER_UUID }).populate('Metadata').firstOrFail();
    expect(after.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]).to.equal(true);

    const ev = events().find((e) => e instanceof User2FaEnabled);
    expect(ev, 'User2FaEnabled belongs on the confirmation, not on the secret handout').to.be.not.undefined;
    expect((ev as User2FaEnabled).UserUUID).to.eq(USER_UUID);
  });

  it('confirmUser2Fa rejects a wrong code and leaves the enrolment pending', async () => {
    await beginUser2FaEnrolment(USER_UUID);

    let thrown: unknown = null;
    try {
      await confirmUser2Fa(USER_UUID, '000000');
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'a wrong code must not activate anything').to.be.not.null;

    const after = await User.where({ Uuid: USER_UUID }).populate('Metadata').firstOrFail();
    expect(after.Metadata[TWO_FA_METATADATA_KEYS.ENABLED]).to.not.equal(true);
  });
});
