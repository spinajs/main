import 'mocha';
import { expect } from 'chai';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { FakeClock, MemoryMfaEnrolmentMarks, RecordingThrottle } from '@spinajs/authn-testing';

import { EmailCodeMfaStep } from '../src/email-code/step.js';
import type { AuthnMailDelivery } from '../src/mail/contracts.js';
import { InlineAuthnMailDispatcher } from '../src/mail/inline.js';
import { LOGIN, RecordingDispatcher, ctx, setup } from './mail/support.js';

const recording = (deliver: AuthnMailDelivery) => new RecordingDispatcher(new InlineAuthnMailDispatcher(deliver, { warn: () => undefined }));
const SIX_DIGITS = /^\d{6}$/;

async function stepSetup(over: Parameters<typeof setup>[0] = {}, backoff = false) {
  const x = await setup(backoff ? over : { throttle: new RecordingThrottle(), ...over }, recording);
  x.identities.setStatus(x.alice, { addressVerified: true });
  const marks = new MemoryMfaEnrolmentMarks();
  const step = new EmailCodeMfaStep({ secrets: x.secrets, identities: x.identities, marks, passwords: x.service });
  return { ...x, marks, step };
}

type Setup = Awaited<ReturnType<typeof stepSetup>>;

const enrol = (x: Setup, id: IdentityRef = x.alice) => x.marks.mark(id, 'email-code');

/** The code of the newest `code` mail, once the dispatched requests are delivered. */
async function deliveredCode(x: Setup): Promise<string> {
  await x.service.drain();
  const mails = x.mailer.mails.filter((m) => m.purpose === 'code');
  const mail = mails[mails.length - 1];
  expect(mail, 'a code mail was sent').to.not.equal(undefined);
  return mail.code!;
}

async function challenged(x: Setup): Promise<string> {
  await x.step.challenge(x.alice, ctx());
  return deliveredCode(x);
}

const otherThan = (code: string) => (code === '000000' ? '111111' : '000000');

async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e,
  );
}

describe('EmailCodeMfaStep (FEAT-3)', function () {
  this.timeout(60_000);

  it('is the step named email-code, keeps no secrets of its own and has no recovery codes', async () => {
    const x = await stepSetup();
    expect(x.step.name).to.equal('email-code');
    expect(x.step.storesSecrets).to.equal(false);
    expect('verifyRecovery' in x.step).to.equal(false);
  });

  describe('challenge', () => {
    it('dispatches one code request whose payload holds no code and issues nothing before the delivery', async () => {
      const x = await stepSetup();
      await enrol(x);
      await x.step.challenge(x.alice, ctx());
      expect(x.secrets.rows(), 'nothing is issued before the delivery').to.have.length(0);
      await x.service.drain();

      expect(x.dispatcher!.requests).to.have.length(1);
      const [request] = x.dispatcher!.requests;
      expect(request).to.include({ purpose: 'code', ttlSeconds: 600 });
      expect(request.identity).to.deep.equal(x.alice);
      expect(Object.keys(request).sort()).to.deep.equal(['identity', 'purpose', 'requestedAt', 'ttlSeconds']);
      expect(JSON.stringify(request)).to.not.contain(x.mailer.mails[0].code!);
    });

    it('delivering it sends exactly one mail with a 6-digit code, to the identity address, with no link', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);

      expect(x.mailer.mails).to.have.length(1);
      const [mail] = x.mailer.mails;
      expect(code).to.match(SIX_DIGITS);
      expect(mail).to.include({ purpose: 'code', url: '', ttlSeconds: 600, code });
      expect(mail.identity).to.deep.equal(x.alice);
      expect(mail.to).to.deep.equal({ email: LOGIN, name: 'Alice' });
    });

    it('authn.local.emailCode.ttlSeconds sets the lifetime of the request and of the code', async () => {
      const x = await stepSetup({ emailCodeTtlSeconds: 120 });
      await enrol(x);
      await challenged(x);
      expect(x.dispatcher!.requests[0].ttlSeconds).to.equal(120);
      const row = x.secrets.rows().find((r) => r.purpose === 'email-code')!;
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).to.equal(120_000);
    });

    it('sends nothing for an identity that is not enrolled', async () => {
      const x = await stepSetup();
      await x.step.challenge(x.alice, ctx());
      await x.service.drain();
      expect(x.dispatcher!.requests).to.have.length(0);
      expect(x.mailer.mails).to.have.length(0);
    });

    it('sends nothing for a banned identity', async () => {
      const x = await stepSetup();
      await enrol(x);
      x.identities.setStatus(x.alice, { banned: true });
      await x.step.challenge(x.alice, ctx());
      await x.service.drain();
      expect(x.mailer.mails).to.have.length(0);
    });

    it('a second challenge inside the reset backoff sends no second mail', async () => {
      const x = await stepSetup({}, true);
      await enrol(x);
      await x.step.challenge(x.alice, ctx());
      await x.step.challenge(x.alice, ctx({ ip: '203.0.113.9' }));
      await x.service.drain();
      expect(x.dispatcher!.requests).to.have.length(1);
      expect(x.events.all().some((e) => e.type === 'throttle.block' && e.data?.flow === 'code')).to.equal(true);
    });

    it('audits code.request without the code', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      const audited = x.events.all().filter((e) => e.type === 'code.request');
      expect(audited.map((e) => [e.outcome, e.identity])).to.deep.equal([['success', x.alice]]);
      expect(JSON.stringify(audited)).to.not.contain(code);
    });
  });

  describe('verify', () => {
    it('accepts the code once', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      expect(await x.step.verify(x.alice, code)).to.equal(true);
      expect(await x.step.verify(x.alice, code), 'the same code a second time').to.equal(false);
    });

    it('a newer code voids the older one', async () => {
      const x = await stepSetup();
      await enrol(x);
      const first = await challenged(x);
      const second = await challenged(x);
      if (first !== second) {
        expect(await x.step.verify(x.alice, first)).to.equal(false);
      }
      expect(await x.step.verify(x.alice, second)).to.equal(true);
    });

    it('wrong codes five times void the code, the right one included', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      for (let i = 0; i < 5; i++) {
        expect(await x.step.verify(x.alice, otherThan(code)), `wrong code ${i + 1}`).to.equal(false);
      }
      expect(await x.step.verify(x.alice, code)).to.equal(false);
    });

    it('four wrong codes leave the code usable', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      for (let i = 0; i < 4; i++) {
        await x.step.verify(x.alice, otherThan(code));
      }
      expect(await x.step.verify(x.alice, code)).to.equal(true);
    });

    it('a new code starts a new count of attempts', async () => {
      const x = await stepSetup();
      await enrol(x);
      const first = await challenged(x);
      for (let i = 0; i < 5; i++) {
        await x.step.verify(x.alice, otherThan(first));
      }
      const second = await challenged(x);
      expect(await x.step.verify(x.alice, second)).to.equal(true);
    });

    it('a code that is not six digits is refused without using up an attempt', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) {
        expect(await x.step.verify(x.alice, bad), JSON.stringify(bad)).to.equal(false);
      }
      for (let i = 0; i < 4; i++) {
        await x.step.verify(x.alice, otherThan(code));
      }
      expect(await x.step.verify(x.alice, code)).to.equal(true);
    });

    it('refuses an expired code', async () => {
      const clock = new FakeClock(new Date('2026-10-21T08:00:00Z'));
      clock.install();
      try {
        const x = await stepSetup();
        await enrol(x);
        const code = await challenged(x);
        clock.tick(600_000 + 1000);
        expect(await x.step.verify(x.alice, code)).to.equal(false);
      } finally {
        clock.uninstall();
      }
    });

    it('refuses a code for an identity that is not enrolled, a valid one included', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      await x.step.disable(x.alice);
      expect(await x.step.verify(x.alice, code)).to.equal(false);
    });

    it('refuses the code of another identity', async () => {
      const x = await stepSetup();
      const bob = x.identities.add({ login: 'bob@example.com', email: 'bob@example.com', name: 'Bob' });
      x.identities.setStatus(bob, { addressVerified: true });
      await enrol(x);
      await enrol(x, bob);
      const code = await challenged(x);
      expect(await x.step.verify(bob, code)).to.equal(false);
    });

    it('spends the same number of secret-store redeems for a right, a wrong and a malformed code', async () => {
      const x = await stepSetup();
      await enrol(x);
      const code = await challenged(x);
      let redeems = 0;
      const redeem = x.secrets.redeem.bind(x.secrets);
      x.secrets.redeem = async (...args) => {
        redeems++;
        return redeem(...args);
      };
      const count = async (f: () => Promise<unknown>) => {
        redeems = 0;
        await f();
        return redeems;
      };
      const counts = [await count(() => x.step.verify(x.alice, otherThan(code))), await count(() => x.step.verify(x.alice, 'abc')), await count(() => x.step.verify(x.alice, code))];
      expect(new Set(counts).size, counts.join(',')).to.equal(1);
    });
  });

  describe('enrolment', () => {
    it('is refused for an address that is not verified, and for one the store does not track', async () => {
      for (const addressVerified of [false, undefined]) {
        const x = await stepSetup();
        x.identities.setStatus(x.alice, { addressVerified });
        const err = await rejection(x.step.beginEnrolment(x.alice));
        expect(err.name).to.equal('EmailCodeAddressUnverified');
        await x.service.drain();
        expect(x.mailer.mails, `addressVerified ${String(addressVerified)}`).to.have.length(0);
        expect(await x.step.enrolled(x.alice)).to.equal(false);
      }
    });

    it('begin sends a code, confirm with it enrols and returns no recovery codes', async () => {
      const x = await stepSetup();
      const begun = await x.step.beginEnrolment(x.alice);
      expect(begun.provisioning).to.be.a('string');
      expect(begun.provisioning).to.not.contain(LOGIN);
      expect(await x.step.enrolled(x.alice), 'a begun enrolment is not enrolled').to.equal(false);

      const code = await deliveredCode(x);
      expect(await x.step.confirmEnrolment(x.alice, code)).to.deep.equal({});
      expect(await x.step.enrolled(x.alice)).to.equal(true);
    });

    it('confirm with a wrong code fails and enrols nothing', async () => {
      const x = await stepSetup();
      await x.step.beginEnrolment(x.alice);
      const code = await deliveredCode(x);
      const err = await rejection(x.step.confirmEnrolment(x.alice, otherThan(code)));
      expect(err.name).to.equal('EmailCodeInvalid');
      expect(await x.step.enrolled(x.alice)).to.equal(false);
    });

    it('confirm without a begun enrolment fails', async () => {
      const x = await stepSetup();
      expect((await rejection(x.step.confirmEnrolment(x.alice, '123456'))).name).to.equal('EmailCodeInvalid');
      expect(await x.step.enrolled(x.alice)).to.equal(false);
    });

    it('begin for an enrolled identity fails', async () => {
      const x = await stepSetup();
      await enrol(x);
      expect((await rejection(x.step.beginEnrolment(x.alice))).name).to.equal('EmailCodeAlreadyEnrolled');
    });

    it('disable removes the enrolment', async () => {
      const x = await stepSetup();
      await enrol(x);
      await x.step.disable(x.alice);
      expect(await x.step.enrolled(x.alice)).to.equal(false);
    });
  });
});
