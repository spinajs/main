import 'mocha';
import { expect } from 'chai';
import { IdentityAddressVerifier } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { FakeClock } from '@spinajs/authn-testing';

import type { AuthnMailDelivery } from '../src/mail/contracts.js';
import { InlineAuthnMailDispatcher } from '../src/mail/inline.js';
import { LOGIN, RecordingDispatcher, ctx, setup } from './mail/support.js';

const VERIFY_URL = 'https://app.example.com/verify';

class RecordingVerifier extends IdentityAddressVerifier {
  public readonly calls: { id: IdentityRef; at: Date }[] = [];
  public async markVerified(id: IdentityRef, at: Date): Promise<void> {
    this.calls.push({ id, at });
  }
}

const recording = (deliver: AuthnMailDelivery) => new RecordingDispatcher(new InlineAuthnMailDispatcher(deliver, { warn: () => undefined }));

async function verifying() {
  const verifier = new RecordingVerifier();
  const x = await setup({ verifier, verifyUrl: VERIFY_URL }, recording);
  x.identities.setStatus(x.alice, { addressVerified: false });
  return { ...x, verifier };
}

/** requestVerification for alice, drained: the one verify mail. */
async function requested(x: Awaited<ReturnType<typeof verifying>>) {
  expect(await x.service.requestVerification(x.alice, ctx())).to.deep.equal({ status: 'accepted' });
  await x.service.drain();
  const mails = x.mailer.mails.filter((m) => m.purpose === 'verify');
  expect(mails).to.have.length(1);
  return mails[0];
}

describe('LocalPasswordService address verification (FEAT-2)', function () {
  this.timeout(60_000);

  it('requestVerification dispatches one AuthnMailRequest of purpose verify that holds no secret', async () => {
    const x = await verifying();
    expect(await x.service.requestVerification(x.alice, ctx())).to.deep.equal({ status: 'accepted' });
    expect(x.secrets.rows(), 'nothing is issued before the delivery').to.have.length(0);
    await x.service.drain();

    expect(x.dispatcher!.requests).to.have.length(1);
    const [request] = x.dispatcher!.requests;
    expect(request).to.include({ purpose: 'verify', ttlSeconds: 86400 });
    expect(request.identity).to.deep.equal(x.alice);
    expect(Object.keys(request).sort()).to.deep.equal(['identity', 'purpose', 'requestedAt', 'ttlSeconds']);
    expect(JSON.stringify(request)).to.not.contain(x.mailer.mails[0].secret);
    expect(x.events.all().some((e) => e.type === 'address.verify.request' && e.outcome === 'success')).to.equal(true);
  });

  it('delivering it issues a SecretStore secret of purpose verify and sends one verify mail with authn.local.verify.url', async () => {
    const x = await verifying();
    const mail = await requested(x);

    expect(x.secrets.rows().map((r) => ({ identity: r.identity, purpose: r.purpose }))).to.deep.equal([{ identity: x.alice, purpose: 'verify' }]);
    expect(mail).to.include({ purpose: 'verify', url: VERIFY_URL, ttlSeconds: 86400 });
    expect(mail.identity).to.deep.equal(x.alice);
    expect(mail.to).to.deep.equal({ email: LOGIN, name: 'Alice' });
  });

  it('authn.local.verify.ttlSeconds sets the lifetime of the request and of the secret', async () => {
    const x = await setup({ verifier: new RecordingVerifier(), verifyTtlSeconds: 600 }, recording);
    await x.service.requestVerification(x.alice, ctx());
    await x.service.drain();
    expect(x.dispatcher!.requests[0].ttlSeconds).to.equal(600);
    const row = x.secrets.rows()[0];
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).to.equal(600_000);
  });

  it('redeemVerification marks the address verified once and audits address.verify', async () => {
    const x = await verifying();
    const mail = await requested(x);
    const now = new Date('2026-10-21T12:00:00Z');

    expect(await x.service.redeemVerification(mail.secret, ctx({ now }))).to.deep.equal({ status: 'verified' });
    expect(x.verifier.calls).to.have.length(1);
    expect(x.verifier.calls[0].id).to.deep.equal(x.alice);
    expect(x.verifier.calls[0].at.getTime()).to.equal(now.getTime());
    const audited = x.events.all().filter((e) => e.type === 'address.verify');
    expect(audited.map((e) => [e.outcome, e.identity])).to.deep.equal([['success', x.alice]]);
    expect(JSON.stringify(audited)).to.not.contain(mail.secret);
  });

  it('throttles redeems on the client ip before parsing the secret, and shares an IPv6 /64', async () => {
    const x = await verifying();
    const secrets = x.secrets.rows().length;
    for (let i = 0; i < 5; i++) {
      expect(await x.service.redeemVerification('not-a-secret', ctx({ ip: `2001:db8::${i + 1}` })), `redeem ${i + 1}`).to.deep.equal({ status: 'invalid' });
    }
    expect(await x.service.redeemVerification('not-a-secret', ctx({ ip: '2001:db8::ffff' }))).to.deep.equal({ status: 'throttled', retryAfterSeconds: 10 });
    expect(await x.service.redeemVerification('not-a-secret', ctx({ ip: '2001:db8:0:1::1' }))).to.deep.equal({ status: 'invalid' });
    expect(x.events.all().some((e) => e.type === 'throttle.block' && e.outcome === 'failure')).to.equal(true);
    expect(x.secrets.rows()).to.have.length(secrets);
  });

  it('a second redeem of the same secret answers invalid and marks nothing', async () => {
    const x = await verifying();
    const mail = await requested(x);
    await x.service.redeemVerification(mail.secret, ctx());

    expect(await x.service.redeemVerification(mail.secret, ctx())).to.deep.equal({ status: 'invalid' });
    expect(x.verifier.calls).to.have.length(1);
    expect(x.events.all().some((e) => e.type === 'address.verify' && e.outcome === 'failure')).to.equal(true);
  });

  it('an expired secret answers invalid', async () => {
    const clock = new FakeClock(new Date('2026-10-21T08:00:00Z'));
    clock.install();
    try {
      const x = await verifying();
      const mail = await requested(x);
      clock.tick(86_400_000 + 1000);
      expect(await x.service.redeemVerification(mail.secret, ctx())).to.deep.equal({ status: 'invalid' });
      expect(x.verifier.calls).to.have.length(0);
    } finally {
      clock.uninstall();
    }
  });

  it('a reset secret cannot be redeemed as verify', async () => {
    const x = await verifying();
    await x.service.requestReset(LOGIN, ctx());
    await x.service.drain();
    const reset = x.mailer.mails.find((m) => m.purpose === 'reset')!;
    const verify = await requested(x);

    expect(await x.service.redeemVerification(reset.secret, ctx())).to.deep.equal({ status: 'invalid' });
    // The same identity as a live verify secret, with the reset secret in its place.
    const swapped = verify.secret.replace(/[^.]+$/, reset.secret);
    expect(await x.service.redeemVerification(swapped, ctx())).to.deep.equal({ status: 'invalid' });
    expect(x.verifier.calls).to.have.length(0);
  });

  it('a malformed or unknown secret answers invalid', async () => {
    const x = await verifying();
    for (const secret of ['', 'x', '...', `${'a'.repeat(40)}.${'b'.repeat(43)}`]) {
      expect(await x.service.redeemVerification(secret, ctx()), secret).to.deep.equal({ status: 'invalid' });
    }
    expect(x.verifier.calls).to.have.length(0);
  });

  it('a verify secret of a banned identity answers invalid', async () => {
    const x = await verifying();
    const mail = await requested(x);
    x.identities.setStatus(x.alice, { banned: true });
    expect(await x.service.redeemVerification(mail.secret, ctx())).to.deep.equal({ status: 'invalid' });
    expect(x.verifier.calls).to.have.length(0);
  });

  it('an address already verified dispatches nothing and answers accepted', async () => {
    const x = await verifying();
    x.identities.setStatus(x.alice, { addressVerified: true });
    expect(await x.service.requestVerification(x.alice, ctx())).to.deep.equal({ status: 'accepted' });
    await x.service.drain();
    expect(x.dispatcher!.requests).to.have.length(0);
  });

  it('a second request inside the reset backoff is throttled, keyed on the account', async () => {
    const x = await verifying();
    expect(await x.service.requestVerification(x.alice, ctx())).to.deep.equal({ status: 'accepted' });
    const second = await x.service.requestVerification(x.alice, ctx({ ip: '203.0.113.9' }));
    expect(second.status).to.equal('throttled');
    await x.service.drain();
    expect(x.dispatcher!.requests).to.have.length(1);
  });
});
