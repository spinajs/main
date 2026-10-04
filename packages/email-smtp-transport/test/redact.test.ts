import 'mocha';
import { expect } from 'chai';

import { EmailConnectionOptions, IEmail } from '@spinajs/email';

import { EmailSenderSmtp } from '../src/index.js';

const TOKEN = 'tok-3f9a/+=secret';
const LINK = `https://app.example.com/password-reset?token=${encodeURIComponent(TOKEN)}&email=alice%40example.com`;

function senderFailingWith(err: Error) {
  const logged: unknown[][] = [];
  const record = (...args: unknown[]) => void logged.push(args);
  const options: EmailConnectionOptions = { service: 'EmailSenderSmtp', name: 'test', host: 'localhost', port: 25, resilience: { retries: 0, timeout: 1000 } };
  const sender = new EmailSenderSmtp(options);
  // @Logger installs a getter-only `Log` accessor, so redefine it rather than assign
  Object.defineProperty(sender, 'Log', { value: { trace: record, info: record, success: record, warn: record, error: record, debug: record }, configurable: true });
  (sender as any).Transporter = { sendMail: () => Promise.reject(err) };
  (sender as any).SendPipeline = (sender as any).buildSendPipeline();
  return { sender, logged };
}

const mail = (redact?: string[]): IEmail => ({
  to: ['alice@example.com'],
  from: 'no-reply@example.com',
  subject: 'Reset your password',
  connection: 'test',
  text: `Open ${LINK}`,
  model: { Token: TOKEN, ResetUrl: LINK },
  ...(redact ? { redact } : {}),
});

const describeError = (e: any) => JSON.stringify({ name: e?.name, message: e?.message, stack: e?.stack, cause: e?.cause, ...e });
const holds = (text: string) => text.includes(TOKEN) || text.includes(encodeURIComponent(TOKEN));

describe('smtp sender with secret values ( redact )', () => {
  it('logs and throws a send error without the secret values, and without a cause', async () => {
    const original = new Error(`550 rejected ${LINK} (${TOKEN})`, { cause: new Error(TOKEN) });
    const { sender, logged } = senderFailingWith(original);

    const err = await sender.send(mail([TOKEN, LINK])).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).to.not.equal(null);
    expect(err).to.not.equal(original);
    expect(err!.message).to.contain('550 rejected');
    expect((err as any).cause).to.equal(undefined);
    expect(holds(describeError(err))).to.equal(false);
    expect(logged).to.have.length(1);
    expect(holds(logged.map((args) => args.map(describeError).join(' ')).join('\n'))).to.equal(false);
  });

  it('throws the original error for a mail without secret values', async () => {
    const original = new Error('550 rejected');
    const { sender } = senderFailingWith(original);
    const err = await sender.send(mail()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).to.equal(original);
  });
});
