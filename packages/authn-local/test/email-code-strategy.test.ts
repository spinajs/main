import 'mocha';
import { expect } from 'chai';
import type { Credentials } from '@spinajs/authn/contracts';
import { RecordingThrottle } from '@spinajs/authn-testing';

import { EmailCodeStrategy } from '../src/email-code/strategy.js';
import type { AuthnMailDelivery } from '../src/mail/contracts.js';
import { InlineAuthnMailDispatcher } from '../src/mail/inline.js';
import { LOGIN, RecordingDispatcher, ctx, setup } from './mail/support.js';

const recording = (deliver: AuthnMailDelivery) => new RecordingDispatcher(new InlineAuthnMailDispatcher(deliver, { warn: () => undefined }));

const code = (login: unknown, value: unknown): Credentials => ({ kind: 'email-code', login, code: value }) as Credentials;
const INVALID = { ok: false, reason: 'invalid_credentials' };

async function strategySetup(over: Parameters<typeof setup>[0] = {}, backoff = false) {
  const x = await setup(backoff ? over : { throttle: new RecordingThrottle(), ...over }, recording);
  x.identities.setStatus(x.alice, { addressVerified: true });
  const strategy = new EmailCodeStrategy({ identities: x.identities, secrets: x.secrets });
  return { ...x, strategy };
}

type Setup = Awaited<ReturnType<typeof strategySetup>>;

/** requestCode for LOGIN, delivered: the code in the mail. */
async function requested(x: Setup, login = LOGIN): Promise<string> {
  expect(await x.service.requestCode!(login, ctx())).to.deep.equal({ status: 'accepted' });
  await x.service.drain();
  const mails = x.mailer.mails.filter((m) => m.purpose === 'code');
  expect(mails).to.have.length(1);
  return mails[0].code!;
}

const otherThan = (value: string) => (value === '000000' ? '111111' : '000000');

describe('EmailCodeStrategy and code requests (FEAT-3)', function () {
  this.timeout(60_000);

  describe('the strategy', () => {
    it('is an interactive strategy named email-code for the kind email-code', async () => {
      const x = await strategySetup();
      expect(x.strategy.name).to.equal('email-code');
      expect(x.strategy.kinds).to.deep.equal(['email-code']);
      expect(x.strategy.interactive).to.equal(true);
    });

    it('the right code logs in with method email-code and assurance aal1, once', async () => {
      const x = await strategySetup();
      const value = await requested(x);
      expect(await x.strategy.verify(code(LOGIN, value), ctx())).to.deep.equal({ ok: true, identity: x.alice, method: 'email-code', assurance: 'aal1' });
      expect(await x.strategy.verify(code(LOGIN, value), ctx()), 'the same code a second time').to.deep.equal(INVALID);
    });

    it('a wrong code, an unknown login and a code nobody asked for answer invalid_credentials', async () => {
      const x = await strategySetup();
      const value = await requested(x);
      expect(await x.strategy.verify(code(LOGIN, otherThan(value)), ctx())).to.deep.equal(INVALID);
      expect(await x.strategy.verify(code('nobody@example.com', value), ctx())).to.deep.equal(INVALID);
      x.identities.add({ login: 'bob@example.com', email: 'bob@example.com' });
      expect(await x.strategy.verify(code('bob@example.com', value), ctx()), "alice's code on bob").to.deep.equal(INVALID);
    });

    it('five wrong codes void the code', async () => {
      const x = await strategySetup();
      const value = await requested(x);
      for (let i = 0; i < 5; i++) {
        await x.strategy.verify(code(LOGIN, otherThan(value)), ctx());
      }
      expect(await x.strategy.verify(code(LOGIN, value), ctx())).to.deep.equal(INVALID);
    });

    it('spends the same number of secret-store redeems for a known and an unknown login', async () => {
      const x = await strategySetup();
      const value = await requested(x);
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
      const counts = [await count(() => x.strategy.verify(code(LOGIN, otherThan(value)), ctx())), await count(() => x.strategy.verify(code('nobody@example.com', value), ctx())), await count(() => x.strategy.verify(code(LOGIN, value), ctx()))];
      expect(new Set(counts).size, counts.join(',')).to.equal(1);
    });

    it('other credential kinds are unsupported and malformed ones are invalid', async () => {
      const x = await strategySetup();
      expect(await x.strategy.verify({ kind: 'password', login: LOGIN, password: 'x' }, ctx())).to.deep.equal({ ok: false, reason: 'unsupported_credentials' });
      for (const bad of [code(LOGIN, undefined), code(LOGIN, 123456), code(undefined, '123456'), code(LOGIN, 'abcdef'), code(LOGIN, '12345'), code(LOGIN, '')]) {
        expect(await x.strategy.verify(bad, ctx()), JSON.stringify(bad)).to.deep.equal(INVALID);
      }
    });

    it('counts in an account key of its own, from the normalised login', async () => {
      const x = await strategySetup();
      expect(x.strategy.throttleKeys(code('  Alice@Example.COM ', '123456'), ctx())).to.deep.equal([{ kind: 'account', value: 'code:alice@example.com' }]);
      expect(x.strategy.throttleKeys(code(undefined, '123456'), ctx())).to.deep.equal([]);
    });
  });

  describe('requestCode', () => {
    it('dispatches one code request without the code, then delivers a 6-digit code to the address', async () => {
      const x = await strategySetup();
      expect(await x.service.requestCode!(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      expect(x.secrets.rows(), 'nothing is issued before the delivery').to.have.length(0);
      await x.service.drain();

      expect(x.dispatcher!.requests).to.have.length(1);
      expect(Object.keys(x.dispatcher!.requests[0]).sort()).to.deep.equal(['identity', 'purpose', 'requestedAt', 'ttlSeconds']);
      expect(x.dispatcher!.requests[0]).to.include({ purpose: 'code' });
      expect(x.mailer.mails).to.have.length(1);
      expect(x.mailer.mails[0].code).to.match(/^\d{6}$/);
      expect(x.mailer.mails[0].to.email).to.equal(LOGIN);
      expect(JSON.stringify(x.dispatcher!.requests[0])).to.not.contain(x.mailer.mails[0].code!);
    });

    it('answers accepted for an unknown login and sends nothing, with the same throttle count as a known one', async () => {
      const x = await strategySetup({}, true);
      expect(await x.service.requestCode!('nobody@example.com', ctx())).to.deep.equal({ status: 'accepted' });
      await x.service.drain();
      expect(x.dispatcher!.requests).to.have.length(0);
      expect(x.mailer.mails).to.have.length(0);
      expect(x.events.all().filter((e) => e.type === 'code.request').map((e) => [e.outcome, e.reason])).to.deep.equal([['failure', 'unknown_login']]);
    });

    it('answers before the lookup and the delivery run', async () => {
      const x = await strategySetup();
      const pending = x.service.requestCode!(LOGIN, ctx());
      expect(await pending).to.deep.equal({ status: 'accepted' });
      expect(x.mailer.mails, 'not yet delivered').to.have.length(0);
      await x.service.drain();
      expect(x.mailer.mails).to.have.length(1);
    });

    it('sends nothing to a banned identity or to an address the store reports unverified', async () => {
      const x = await strategySetup();
      x.identities.setStatus(x.alice, { banned: true });
      await x.service.requestCode!(LOGIN, ctx());
      await x.service.drain();
      expect(x.mailer.mails).to.have.length(0);

      const y = await strategySetup();
      y.identities.setStatus(y.alice, { addressVerified: false });
      expect(await y.service.requestCode!(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      await y.service.drain();
      expect(y.mailer.mails).to.have.length(0);
      expect(y.events.all().some((e) => e.type === 'code.request' && e.reason === 'unverified_address')).to.equal(true);
    });

    it('sends to an address the store does not track', async () => {
      const x = await strategySetup();
      x.identities.setStatus(x.alice, { addressVerified: undefined });
      await x.service.requestCode!(LOGIN, ctx());
      await x.service.drain();
      expect(x.mailer.mails).to.have.length(1);
    });

    it('a second request inside the reset backoff is throttled, keyed on the login and the ip', async () => {
      const x = await strategySetup({}, true);
      expect(await x.service.requestCode!(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
      const second = await x.service.requestCode!(LOGIN, ctx({ ip: '203.0.113.9' }));
      expect(second.status).to.equal('throttled');
      await x.service.drain();
      expect(x.dispatcher!.requests).to.have.length(1);
    });

    it('does not use up the reset request of the same account', async () => {
      const x = await strategySetup({}, true);
      await x.service.requestCode!(LOGIN, ctx());
      expect(await x.service.requestReset(LOGIN, ctx({ ip: '203.0.113.9' }))).to.deep.equal({ status: 'accepted' });
    });

    it('audits code.request without the code', async () => {
      const x = await strategySetup();
      const value = await requested(x);
      const audited = x.events.all().filter((e) => e.type === 'code.request');
      expect(audited.map((e) => [e.outcome, e.identity])).to.deep.equal([['success', x.alice]]);
      expect(JSON.stringify(audited)).to.not.contain(value);
    });

    it('a request older than its lifetime is dropped at delivery', async () => {
      const x = await strategySetup();
      const stale = { identity: x.alice, purpose: 'code' as const, ttlSeconds: 600, requestedAt: new Date(Date.now() - 601_000) };
      expect(await x.service.deliver(stale)).to.equal(false);
      expect(x.secrets.rows()).to.have.length(0);
    });
  });
});
