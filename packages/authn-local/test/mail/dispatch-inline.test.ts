import 'mocha';
import { expect } from 'chai';

import type { PasswordMail } from '../../src/mailer.js';
import type { AuthnMailDelivery } from '../../src/mail/contracts.js';
import { InlineAuthnMailDispatcher } from '../../src/mail/inline.js';
import { LOGIN, RecordingDispatcher, RecordingMailer, RESET_URL, ctx, setup } from './support.js';

const NEW = 'New-Password-2';

/** A mailer whose send waits until `release()`. */
class GatedMailer extends RecordingMailer {
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  public release(): void {
    this.open();
  }
  public async send(mail: PasswordMail): Promise<void> {
    await this.gate;
    await super.send(mail);
  }
}

const recording = (deliver: AuthnMailDelivery) => new RecordingDispatcher(new InlineAuthnMailDispatcher(deliver, { warn: () => undefined }));

describe('authn mail, inline delivery (MAIL-1, D12)', function () {
  this.timeout(60_000);

  it('requestReset for a known login answers accepted before any mail and before any secret exists', async () => {
    const x = await setup();
    expect(await x.service.requestReset(LOGIN, ctx())).to.deep.equal({ status: 'accepted' });
    expect(x.mailer.mails).to.have.length(0);
    expect(x.secrets.rows()).to.have.length(0);
    await x.service.drain();
  });

  it('after drain() exactly one PasswordMailer.send of purpose reset, with a secret that redeems', async () => {
    const x = await setup({}, recording);
    await x.service.requestReset(LOGIN, ctx());
    await x.service.drain();

    expect(x.mailer.mails).to.have.length(1);
    const [mail] = x.mailer.mails;
    expect(mail).to.include({ purpose: 'reset', url: RESET_URL, ttlSeconds: 3600 });
    expect(mail.identity).to.deep.equal(x.alice);
    expect(mail.to).to.deep.equal({ email: LOGIN, name: 'Alice' });
    expect(await x.service.redeemReset(LOGIN, mail.secret, NEW, ctx())).to.deep.equal({ status: 'reset', purpose: 'reset' });

    expect(x.dispatcher!.requests).to.have.length(1);
    const [request] = x.dispatcher!.requests;
    expect(request).to.include({ purpose: 'reset', ttlSeconds: 3600 });
    expect(request.identity).to.deep.equal(x.alice);
    expect(JSON.stringify(x.dispatcher!.requests)).to.not.contain(mail.secret);
  });

  it('an unknown login dispatches nothing', async () => {
    const x = await setup({}, recording);
    expect(await x.service.requestReset('nobody@example.com', ctx())).to.deep.equal({ status: 'accepted' });
    await x.service.drain();
    expect(x.dispatcher!.requests).to.have.length(0);
    expect(x.mailer.mails).to.have.length(0);
    expect(x.secrets.rows()).to.have.length(0);
  });

  it('invite dispatches one invite request and returns without awaiting the send', async () => {
    const mailer = new GatedMailer();
    const x = await setup({ mailer }, recording);
    const dave = x.identities.add({ login: 'dave@example.com', email: 'dave@example.com', status: { active: false, invitePending: true } });

    const outcome = await Promise.race([x.service.invite(dave, ctx()).then(() => 'returned'), new Promise((resolve) => setTimeout(() => resolve('waited for the send'), 5_000))]);
    expect(outcome).to.equal('returned');
    expect(x.dispatcher!.requests).to.have.length(1);
    expect(x.dispatcher!.requests[0]).to.include({ purpose: 'invite', ttlSeconds: 900 });
    expect(x.dispatcher!.requests[0].identity).to.deep.equal(dave);
    expect(mailer.mails).to.have.length(0);

    mailer.release();
    await x.service.drain();
    expect(mailer.mails.map((m) => m.purpose)).to.deep.equal(['invite']);
    expect(await x.service.redeemReset('dave@example.com', mailer.mails[0].secret, NEW, ctx())).to.deep.equal({ status: 'reset', purpose: 'invite' });
  });

  it('the dispatched request carries the time it was made, from the real clock', async () => {
    const x = await setup({}, recording);
    const before = Date.now();
    await x.service.requestReset(LOGIN, ctx({ now: new Date('2026-01-01T00:00:00Z') }));
    await x.service.drain();
    expect(x.dispatcher!.requests[0].requestedAt.getTime()).to.be.within(before, Date.now());
  });

  describe('deliver', () => {
    it('issues the secret and sends at once', async () => {
      const x = await setup();
      expect(await x.service.deliver({ identity: x.alice, purpose: 'reset', ttlSeconds: 3600, requestedAt: new Date() })).to.equal(true);
      expect(x.mailer.mails).to.have.length(1);
      expect(x.secrets.rows()).to.have.length(1);
    });

    it('answers false and issues nothing for a request older than its ttl', async () => {
      const x = await setup();
      expect(await x.service.deliver({ identity: x.alice, purpose: 'reset', ttlSeconds: 60, requestedAt: new Date(Date.now() - 61_000) })).to.equal(false);
      expect(x.mailer.mails).to.have.length(0);
      expect(x.secrets.rows()).to.have.length(0);
    });

    it('answers false and issues nothing without a mailer or without an address', async () => {
      const x = await setup({ mailer: null });
      expect(await x.service.deliver({ identity: x.alice, purpose: 'reset', ttlSeconds: 3600, requestedAt: new Date() })).to.equal(false);
      expect(x.secrets.rows()).to.have.length(0);

      const y = await setup();
      const silent = y.identities.add({ login: 'no-address' });
      expect(await y.service.deliver({ identity: silent, purpose: 'invite', ttlSeconds: 900, requestedAt: new Date() })).to.equal(false);
      expect(y.mailer.mails).to.have.length(0);
      expect(y.secrets.rows()).to.have.length(0);
    });

    it('passes the request language to the mailer', async () => {
      const x = await setup();
      await x.service.deliver({ identity: x.alice, purpose: 'reset', ttlSeconds: 3600, requestedAt: new Date(), lang: 'pl' });
      expect(x.mailer.mails[0].lang).to.equal('pl');
    });
  });
});
