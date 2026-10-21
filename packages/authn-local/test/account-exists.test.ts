import 'mocha';
import { expect } from 'chai';

import type { AuthnMailDelivery } from '../src/mail/contracts.js';
import { InlineAuthnMailDispatcher } from '../src/mail/inline.js';
import { LOGIN, RESET_URL, RecordingDispatcher, ctx, setup } from './mail/support.js';

const recording = (deliver: AuthnMailDelivery) => new RecordingDispatcher(new InlineAuthnMailDispatcher(deliver, { warn: () => undefined }));

describe('LocalPasswordService.notifyAccountExists (FEAT-4)', function () {
  this.timeout(60_000);

  it('dispatches one account-exists request that holds no secret', async () => {
    const x = await setup({}, recording);
    await x.service.notifyAccountExists(x.alice, ctx());

    expect(x.dispatcher!.requests).to.have.length(1);
    const [request] = x.dispatcher!.requests;
    expect(request).to.include({ purpose: 'account-exists' });
    expect(request.identity).to.deep.equal(x.alice);
    expect(Object.keys(request).sort()).to.deep.equal(['identity', 'purpose', 'requestedAt', 'ttlSeconds']);
    expect(x.secrets.rows(), 'nothing is issued').to.have.length(0);
  });

  it('delivering it sends one mail to the stored address with no secret and the reset page as the link', async () => {
    const x = await setup({}, recording);
    await x.service.notifyAccountExists(x.alice, ctx());
    await x.service.drain();

    expect(x.mailer.mails).to.have.length(1);
    const [mail] = x.mailer.mails;
    expect(mail).to.include({ purpose: 'account-exists', secret: '', url: RESET_URL });
    expect(mail.identity).to.deep.equal(x.alice);
    expect(mail.to).to.deep.equal({ email: LOGIN, name: 'Alice' });
    expect(x.secrets.rows(), 'no SecretStore secret').to.have.length(0);
  });

  it('mails nobody for an identity that cannot sign in', async () => {
    const x = await setup({}, recording);
    x.identities.setStatus(x.alice, { banned: true });
    await x.service.notifyAccountExists(x.alice, ctx());
    await x.service.drain();

    expect(x.dispatcher!.requests).to.have.length(0);
    expect(x.mailer.mails).to.have.length(0);
  });

  it('sends nothing, and does not fail, without a mailer', async () => {
    const x = await setup({ mailer: null }, recording);
    await x.service.notifyAccountExists(x.alice, ctx());
    await x.service.drain();

    expect(x.dispatcher!.requests).to.have.length(0);
  });

  it('a request older than its lifetime is dropped at delivery', async () => {
    const x = await setup();
    const stale = new Date(Date.now() - 2 * 3600 * 1000);
    expect(await x.service.deliver({ identity: x.alice, purpose: 'account-exists', ttlSeconds: 60, requestedAt: stale })).to.equal(false);
    expect(x.mailer.mails).to.have.length(0);
  });
});
