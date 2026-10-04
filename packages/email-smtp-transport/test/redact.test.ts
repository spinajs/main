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

/** The template downloads, then `Templates.render` rejects with `err`; the render options it got are kept. */
function senderWithFailingTemplate(err: Error) {
  const x = senderFailingWith(new Error('sendMail must not be reached'));
  const renderOptions: unknown[] = [];
  (x.sender as any).defaultTemplateFs = { Name: 'templates', download: async (path: string) => `/tmp/${path}` };
  (x.sender as any).Templates = {
    render: async (_file: string, _model: unknown, _lang?: string, options?: unknown) => {
      renderOptions.push(options);
      throw err;
    },
  };
  return { ...x, renderOptions };
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

  it('passes redact to the template engine, then logs and throws a render error without the secret values', async () => {
    const original = new Error(`helper failed on ${LINK} (${TOKEN})`, { cause: new Error(TOKEN) });
    const { sender, logged, renderOptions } = senderWithFailingTemplate(original);

    const err = await sender.send({ ...mail([TOKEN, LINK]), template: 'reset.hbs' }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(renderOptions).to.deep.equal([{ redact: [TOKEN, LINK] }]);
    expect(err).to.not.equal(null);
    expect(err).to.not.equal(original);
    expect(err!.message).to.contain('helper failed on');
    expect((err as any).cause).to.equal(undefined);
    expect(holds(describeError(err))).to.equal(false);
    expect(logged.filter((args) => args[0] instanceof Error)).to.have.length(1);
    expect(holds(logged.map((args) => args.map(describeError).join(' ')).join('\n'))).to.equal(false);
  });

  it('throws the original render error for a mail without secret values', async () => {
    const original = new Error('helper failed');
    const { sender, renderOptions } = senderWithFailingTemplate(original);
    const err = await sender.send({ ...mail(), template: 'reset.hbs' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(renderOptions).to.deep.equal([undefined]);
    expect(err).to.equal(original);
  });
});
