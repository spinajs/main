import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { IOFail } from '@spinajs/exceptions';
import { IEmail } from '@spinajs/email';

import { EmailSenderSmtp } from '../src/index.js';

chai.use(chaiAsPromised);

const noopLog = new Proxy({}, { get: () => () => undefined }) as any;

/**
 * A bare sender as in resilience.test.ts: no SMTP connection, a fake transporter recording the options, and an
 * unregistered default filesystem, so any read through getFs fails with IOFail.
 */
function makeSender() {
  const sent: any[] = [];
  const sender = new EmailSenderSmtp({ service: 'EmailSenderSmtp', name: 'test', host: 'localhost', port: 25, resilience: { retries: 0, timeout: 1000 } });
  Object.defineProperty(sender, 'Log', { value: noopLog, writable: true, configurable: true });
  Object.defineProperty(sender, 'DefaultFileProvider', { value: 'not-registered', configurable: true });
  (sender as any).Transporter = { sendMail: async (options: any) => (sent.push(options), { messageId: 'ok' }) };
  (sender as any).SendPipeline = (sender as any).buildSendPipeline();
  return { sender, sent };
}

const mailWith = (attachements: IEmail['attachements']): IEmail => ({ to: ['recipient@spinajs.com'], from: 'sender@spinajs.com', subject: 'attachments', connection: 'test', text: 'hello', attachements });

describe('smtp attachments', () => {
  it('sends the file the email service already read and does not read the path again', async () => {
    const { sender, sent } = makeSender();

    await sender.send(mailWith([{ name: 'a.txt', path: 'docs/a.txt', provider: 'not-registered', cid: 'img', file: '/local/uploads/docs/a.txt' }]));

    expect(sent).to.have.length(1);
    expect(sent[0].attachments).to.deep.equal([{ cid: 'img', filename: 'a.txt', path: '/local/uploads/docs/a.txt' }]);
  });

  it('reads an attachment without file through its filesystem', async () => {
    const { sender, sent } = makeSender();

    await expect(sender.send(mailWith([{ name: 'a.txt', path: 'docs/a.txt' }]))).to.be.rejectedWith(IOFail);
    expect(sent).to.have.length(0);
  });
});
