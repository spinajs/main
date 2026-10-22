import 'mocha';
import { expect } from 'chai';
import { IdentityAddressVerifier, PASSWORD_HARD_CAP } from '@spinajs/authn/contracts';
import { FakeIdentityStore, MemoryPasswordCredentialStore } from '@spinajs/authn-testing';

import { EmailCodes } from '../src/email-code/codes.js';
import { EmailCodeStrategy } from '../src/email-code/strategy.js';
import { Argon2PasswordHasher } from '../src/hasher.js';
import type { AuthnMailDelivery } from '../src/mail/contracts.js';
import { InlineAuthnMailDispatcher } from '../src/mail/inline.js';
import { LocalPasswordStrategy } from '../src/strategy.js';
import { RecordingDispatcher, ctx, setup } from './mail/support.js';

const LONG_LOGIN = `${'a'.repeat(PASSWORD_HARD_CAP - 7)}@ex.com`.padEnd(PASSWORD_HARD_CAP + 1, 'm');
const PASSWORD = 'Correct-Horse-9';
const INVALID = { ok: false, reason: 'invalid_credentials' };

class NoopVerifier extends IdentityAddressVerifier {
  public async markVerified(): Promise<void> {
    return undefined;
  }
}

const recording = (deliver: AuthnMailDelivery) => new RecordingDispatcher(new InlineAuthnMailDispatcher(deliver, { warn: () => undefined }));

describe('authn-local input caps (VAL V9)', function () {
  this.timeout(60_000);

  it(`the login is longer than ${PASSWORD_HARD_CAP} characters`, () => {
    expect(LONG_LOGIN).to.have.length(PASSWORD_HARD_CAP + 1);
  });

  describe('LocalPasswordService', () => {
    async function withLongLogin() {
      const x = await setup({}, recording);
      const long = x.identities.add({ login: LONG_LOGIN, email: 'long@example.com' });
      x.identities.setStatus(long, { addressVerified: true });
      return { ...x, long };
    }

    it('requestReset accepts a login longer than the cap and mails nothing', async () => {
      const x = await withLongLogin();
      expect(await x.service.requestReset(LONG_LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      await x.service.drain();
      expect(x.mailer.mails).to.deep.equal([]);
    });

    it('requestCode accepts a login longer than the cap and mails nothing', async () => {
      const x = await withLongLogin();
      expect(await x.service.requestCode(LONG_LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      await x.service.drain();
      expect(x.mailer.mails).to.deep.equal([]);
    });

    it('redeemVerification answers invalid for a well-formed secret longer than the cap, audited as malformed', async () => {
      const x = await setup({ verifier: new NoopVerifier(), verifyUrl: 'https://app.example.com/verify' }, recording);
      const idPart = Buffer.from(JSON.stringify([x.alice.type, x.alice.id])).toString('base64url');
      const secret = `${idPart}.${'s'.repeat(PASSWORD_HARD_CAP)}`;

      expect(await x.service.redeemVerification(secret, ctx())).to.deep.equal({ status: 'invalid' });
      const verify = x.events.all().filter((e) => e.type === 'address.verify');
      expect(verify.map((e) => `${e.outcome}:${e.reason}`)).to.deep.equal(['failure:malformed']);
    });
  });

  describe('LocalPasswordStrategy', () => {
    it('refuses a login longer than the cap even when it names an account', async () => {
      const identities = new FakeIdentityStore();
      const passwords = new MemoryPasswordCredentialStore();
      const hasher = new Argon2PasswordHasher({});
      const strategy = new LocalPasswordStrategy({ identities, passwords, hasher });
      await strategy.resolve();
      const long = identities.add({ login: LONG_LOGIN });
      await passwords.set(long, await hasher.hash(PASSWORD));

      expect(await strategy.verify({ kind: 'password', login: LONG_LOGIN, password: PASSWORD }, ctx())).to.deep.equal(INVALID);
    });
  });

  describe('EmailCodeStrategy', () => {
    it('refuses a login longer than the cap even with its code', async () => {
      const x = await setup({}, recording);
      const long = x.identities.add({ login: LONG_LOGIN, email: 'long@example.com' });
      x.identities.setStatus(long, { addressVerified: true });
      const code = await new EmailCodes(x.secrets).issue(long, 600);
      const strategy = new EmailCodeStrategy({ identities: x.identities, secrets: x.secrets });

      expect(await strategy.verify({ kind: 'email-code', login: LONG_LOGIN, code }, ctx())).to.deep.equal(INVALID);
    });
  });
});
