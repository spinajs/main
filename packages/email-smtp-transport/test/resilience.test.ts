import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { EmailConnectionOptions, IEmail } from '@spinajs/email';
import { TimeoutRejectedException } from '@spinajs/util';

import { EmailSenderSmtp } from '../src/index.js';

chai.use(chaiAsPromised);

/**
 * Hermetic tests for the in-process SMTP resilience pipeline ( timeout + retry )
 * built by EmailSenderSmtp.buildSendPipeline() and used around Transporter.sendMail.
 *
 * No network / broker: we instantiate the sender directly, swap in a fake
 * transporter and a no-op logger, and drive send() with a text-only email so the
 * template / attachment code paths are skipped entirely.
 */

// no-op logger so send()'s trace / error calls don't blow up on a bare instance
const noopLog = {
  trace: () => undefined,
  info: () => undefined,
  success: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
} as any;

interface FakeTransporter {
  calls: number;
  sendMail: (options: any) => Promise<any>;
}

/**
 * Builds a fake transporter whose sendMail counts invocations and delegates to `impl`.
 * `impl` receives the 1-based call number so it can fail-then-succeed etc.
 */
function fakeTransporter(impl: (callNumber: number) => Promise<any>): FakeTransporter {
  const t: FakeTransporter = {
    calls: 0,
    sendMail(_options: any) {
      t.calls += 1;
      return impl(t.calls);
    },
  };
  return t;
}

/**
 * Creates a bare EmailSenderSmtp instance wired with the given resilience config
 * and fake transporter, without opening any real SMTP connection ( resolve() is
 * never called ). The send pipeline is built via the same code path resolve() uses.
 */
function makeSender(resilience: EmailConnectionOptions['resilience'], transporter: FakeTransporter): EmailSenderSmtp {
  const options: EmailConnectionOptions = {
    service: 'EmailSenderSmtp',
    name: 'test',
    host: 'localhost',
    port: 25,
    resilience,
  };

  const sender = new EmailSenderSmtp(options);
  // @Logger installs a getter-only `Log` accessor, so redefine it rather than assign
  Object.defineProperty(sender, 'Log', { value: noopLog, writable: true, configurable: true });
  (sender as any).Transporter = transporter;
  (sender as any).SendPipeline = (sender as any).buildSendPipeline();

  return sender;
}

function textEmail(): IEmail {
  return {
    to: ['recipient@spinajs.com'],
    from: 'sender@spinajs.com',
    subject: 'resilience test',
    connection: 'test',
    text: 'hello world',
  };
}

describe('smtp resilience pipeline', function () {
  // generous ceiling: real assertions gate on behavior, this only guards against hangs
  this.timeout(5000);

  it('retries transient failures then succeeds ( retries=2 honored )', async () => {
    const t = fakeTransporter((n) => {
      if (n <= 2) {
        return Promise.reject(new Error('ECONN'));
      }
      return Promise.resolve({ messageId: 'ok-1' });
    });

    const sender = makeSender({ retries: 2, delay: 1, timeout: 1000 }, t);

    await expect(sender.send(textEmail())).to.be.fulfilled;
    expect(t.calls).to.equal(3);
  });

  it('rejects with the original error when retries are exhausted', async () => {
    const t = fakeTransporter(() => Promise.reject(new Error('ECONN persistent')));

    const sender = makeSender({ retries: 2, delay: 1, timeout: 1000 }, t);

    await expect(sender.send(textEmail())).to.be.rejectedWith('ECONN persistent');
    expect(t.calls).to.equal(3); // initial + 2 retries
  });

  it('does not retry when retries=0 ( exactly one attempt )', async () => {
    const t = fakeTransporter(() => Promise.reject(new Error('ECONN once')));

    const sender = makeSender({ retries: 0, delay: 1, timeout: 1000 }, t);

    await expect(sender.send(textEmail())).to.be.rejectedWith('ECONN once');
    expect(t.calls).to.equal(1);
  });

  it('times out a hanging send without retrying or hanging the suite', async () => {
    // never-resolving send: only the timeout strategy can unblock this
    const t = fakeTransporter(() => new Promise<any>(() => undefined));

    const sender = makeSender({ retries: 0, timeout: 100 }, t);

    await expect(sender.send(textEmail())).to.be.rejectedWith(TimeoutRejectedException);
    expect(t.calls).to.equal(1);
  });

  it('emits no retries on immediate success ( exactly one attempt )', async () => {
    const t = fakeTransporter(() => Promise.resolve({ messageId: 'ok-2' }));

    const sender = makeSender({ retries: 2, delay: 1, timeout: 1000 }, t);

    await expect(sender.send(textEmail())).to.be.fulfilled;
    expect(t.calls).to.equal(1);
  });
});
