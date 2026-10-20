import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { DefaultQueueService } from '@spinajs/queue';
import { DefaultEmailService, EmailPasswordMailer } from '@spinajs/email';
import type { IEmail } from '@spinajs/email';
import { PasswordService } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, MemorySecretStore, MemorySessionIssuer } from '@spinajs/authn-testing';
import { Argon2PasswordHasher, LocalPasswordPolicy, LocalPasswordService, PasswordMailer } from '@spinajs/authn-local';

import { QueueAuthnEventSink, RbacBootstrapper, UserAccountSink, UserIdentityStore, UserPasswordStore } from '../src/index.js';
import { create, expirePassword } from '../src/actions.js';
import './migration/rbac.migration.js';
import { TestPasswordService } from './support/password-service.js';
import { bootUsersDb, registerUsersTestHost, storedUser } from './support/users-db.js';

const RESET_URL = 'https://app.test/password-reset';

describe('reset and invite mails (SR-09, C9 EmailPasswordMailer)', function () {
  this.timeout(60000);

  let emit: sinon.SinonStub;
  let sent: IEmail[];

  before(() => {
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb((config: Configuration) => config.set('email.defaultConnection', 'rbac-email-connection'));
    emit = sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);
    sent = [];
    sinon.stub(DefaultEmailService.prototype, 'send').callsFake(async (email: IEmail) => {
      sent.push(email);
    });
  });

  afterEach(() => {
    sinon.restore();
    DI.clearCache();
  });

  it("users' bootstrapper registers EmailPasswordMailer as the PasswordMailer", async () => {
    expect(DI.RootContainer.hasRegistered(PasswordMailer)).to.eq(true);
    expect(await DI.resolve(PasswordMailer)).to.be.instanceOf(EmailPasswordMailer);
  });

  describe("an application's own PasswordMailer", () => {
    class AppMailer extends PasswordMailer {
      public async send(): Promise<void> {}
    }

    const bootstrap = async () => (await DI.resolve(Array.ofType(Bootstrapper))).find((b) => b instanceof RbacBootstrapper)!.bootstrap();
    // An unregister that empties the key drops it (di c673c88f0), so getTypes answers null.
    const mailerTypes = () => (DI.RootContainer.Registry.getTypes(PasswordMailer) ?? []).map((t) => t as unknown);

    afterEach(() => {
      DI.unregister(AppMailer);
      if (!mailerTypes().includes(EmailPasswordMailer)) {
        DI.register(EmailPasswordMailer).as(PasswordMailer);
      }
      DI.uncache(PasswordMailer);
    });

    it('registered before the bootstrapper runs, is kept and resolves', async () => {
      DI.unregister(EmailPasswordMailer);
      DI.register(AppMailer).as(PasswordMailer);

      await bootstrap();
      DI.uncache(PasswordMailer);

      expect(mailerTypes()).to.not.include(EmailPasswordMailer);
      expect(await DI.resolve(PasswordMailer)).to.be.instanceOf(AppMailer);
    });

    it('registered after the bootstrapper ran, resolves (last registration wins)', async () => {
      await bootstrap();
      DI.register(AppMailer).as(PasswordMailer);
      DI.uncache(PasswordMailer);

      expect(await DI.resolve(PasswordMailer)).to.be.instanceOf(AppMailer);
    });
  });

  it('puts the secret of an invite and of a reset only into the mail sent at once, never into a queued payload', async () => {
    const hasher = new Argon2PasswordHasher({});
    await hasher.resolve();
    const real = new LocalPasswordService({
      identities: new UserIdentityStore(),
      passwords: new UserPasswordStore(),
      sessions: new MemorySessionIssuer(),
      throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
      tokens: null,
      secrets: new MemorySecretStore(),
      mailer: (await DI.resolve(PasswordMailer)) as PasswordMailer,
      sinks: [await DI.resolve(UserAccountSink), await DI.resolve(QueueAuthnEventSink)],
      hasher,
      policy: new LocalPasswordPolicy({}),
      resetUrl: RESET_URL,
    });
    // create() and expirePassword() resolve the PasswordService the suites register.
    for (const method of ['invite', 'requestReset', 'expire'] as const) {
      sinon.stub(TestPasswordService.prototype, method).callsFake(((...args: unknown[]) => (real[method] as (...a: unknown[]) => Promise<unknown>)(...args)) as never);
    }

    const { User: invited } = await create({ Email: 'mail-invite@spinajs.pl', Login: 'mail-invite' });
    await ((await DI.resolve(PasswordService)) as PasswordService).requestReset('test@spinajs.pl', { now: new Date(), purpose: 'request' });
    await real.drain();
    await expirePassword(await storedUser(invited.Uuid));

    expect(sent.map((m) => [m.to, m.model?.Purpose])).to.deep.eq([
      [['mail-invite@spinajs.pl'], 'invite'],
      [['test@spinajs.pl'], 'reset'],
    ]);
    const secrets = sent.map((m) => String(m.model!.Token));
    for (const [i, m] of sent.entries()) {
      expect(secrets[i]).to.have.length.greaterThan(20);
      expect(m.redact).to.include(secrets[i]);
      expect(m.redact).to.include(String(m.model!.ResetUrl));
    }

    const payloads = JSON.stringify(emit.args.map((a) => a[0]));
    expect(emit.callCount, 'the queue was used (events, the passwordExpired mail)').to.be.greaterThan(0);
    for (const secret of secrets) {
      expect(payloads).to.not.contain(secret);
    }
    expect(payloads).to.not.contain(RESET_URL);
    expect(payloads).to.not.match(/token=/i);
  });
});
