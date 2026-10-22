import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { InvalidOperation } from '@spinajs/exceptions';
import { Class, DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import '../src/transports.js';
import { DefaultEmailService, EmailBootstrapper, EmailSender, LogBotstrapper } from '../src/index.js';

class FixesConf extends FrameworkConfiguration {
  protected onLoad() {
    return { email: { connections: [] } };
  }
}

describe('email fixes', function () {
  this.timeout(15000);

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
    DI.clearCache();
    DI.register(FixesConf).as(Configuration);
    await DI.resolve(Configuration);

    // Resolved by class name like @AutoinjectService does; several EmailSender implementations may be registered
    const type = DI.getRegisteredTypes(EmailSender).find((t) => t.name === 'BlackHoleEmailTransport') as Class<EmailSender>;
    const sender = await DI.resolve<EmailSender>(type, [{ name: 'hole', service: 'BlackHoleEmailTransport' }]);

    expect(sender.ServiceName).to.equal('hole');
  });

  it('keeps the misspelled bootstrapper name as an alias', () => {
    expect(LogBotstrapper).to.equal(EmailBootstrapper);
  });
});
