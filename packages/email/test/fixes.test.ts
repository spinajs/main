import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { InvalidOperation } from '@spinajs/exceptions';
import { DI } from '@spinajs/di';

import '../src/transports.js';
import { DefaultEmailService, EmailBootstrapper, EmailSender, LogBotstrapper } from '../src/index.js';

describe('email fixes', () => {
  it('send() rejects with InvalidOperation when no connections are configured', async () => {
    const service = new DefaultEmailService();
    Object.defineProperty(service, 'Log', { value: { error: sinon.stub() }, configurable: true });

    let error: unknown;
    try {
      await service.send({ to: ['a@b.c'], connection: 'x', subject: 's' });
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(InvalidOperation);
  });

  it('BlackHoleEmailTransport can be named as a connection service', async () => {
    const sender = await DI.resolve<EmailSender>(EmailSender, [{ name: 'hole', service: 'BlackHoleEmailTransport' }]);

    expect(sender.ServiceName).to.equal('hole');
  });

  it('keeps the misspelled bootstrapper name as an alias', () => {
    expect(LogBotstrapper).to.equal(EmailBootstrapper);
  });
});
