import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { EmailService, IEmail } from '../src/interfaces.js';
import { _emailSend, _emailDeferred } from '../src/fp.js';
import { EmailSend } from '../src/jobs/EmailSend.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class FakeEmailService extends EmailService {
  public Sent: IEmail[] = [];
  public Deferred: IEmail[] = [];

  public async send(email: IEmail): Promise<void> {
    this.Sent.push(email);
  }

  public async sendDeferred(email: IEmail): Promise<EmailSend> {
    this.Deferred.push(email);
    return new EmailSend();
  }

  public async processDeferredEmails(): Promise<void> {
    /* noop */
  }
}

class FpEmailConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      email: {
        connections: [],
      },
    };
  }
}

const email: IEmail = {
  to: ['test@spinajs.pl'],
  connection: 'test',
  subject: 'fp test',
};

describe('email fp', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(FpEmailConf).as(Configuration);
    DI.register(FakeEmailService).as(EmailService);
    await DI.resolve(Configuration);
  });

  it('_emailSend resolves the email service and sends immediately', async () => {
    await _emailSend(email);

    const svc = (await DI.resolve(EmailService)) as FakeEmailService;
    expect(svc.Sent.length).to.eq(1);
    expect(svc.Sent[0].subject).to.eq('fp test');
    expect(svc.Deferred.length).to.eq(0);
  });

  it('_emailDeferred resolves the email service and defers', async () => {
    const result = await _emailDeferred(email);

    const svc = (await DI.resolve(EmailService)) as FakeEmailService;
    expect(svc.Deferred.length).to.eq(1);
    expect(svc.Deferred[0].to).to.deep.eq(['test@spinajs.pl']);
    expect(svc.Sent.length).to.eq(0);
    expect(result).to.be.instanceOf(EmailSend);
  });
});
