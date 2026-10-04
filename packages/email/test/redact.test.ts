import 'mocha';
import { expect } from 'chai';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidOperation } from '@spinajs/exceptions';

import { EmailSent, IEmail, redactError, redactText, REDACTED } from '../src/index.js';
import { capturingEmailService, dump, holds } from './capture.js';

chai.use(chaiAsPromised);

const TOKEN = 'tok-3f9a/+=secret';
const LINK = `https://app.example.com/password-reset?token=${encodeURIComponent(TOKEN)}&email=alice%40example.com`;

const secretMail = (): IEmail => ({
  to: ['alice@example.com'],
  connection: 'test',
  subject: 'Reset your password',
  model: { Token: TOKEN, ResetUrl: LINK },
  text: `Open ${LINK}`,
  tag: 'authn-password-reset',
  redact: [TOKEN, LINK],
});

const plainMail = (): IEmail => ({ to: ['client@acme.com'], connection: 'test', subject: 'Your invoice', model: { Total: 10 }, text: 'Total 10' });

describe('redaction helpers', () => {
  it('replaces each value raw and URI-encoded, the longer value first', () => {
    const text = `link ${LINK} token ${TOKEN} encoded ${encodeURIComponent(TOKEN)} nested ${encodeURIComponent(LINK)}`;
    const out = redactText(text, [TOKEN, LINK]);
    expect(holds(out, TOKEN)).to.equal(false);
    expect(out).to.not.contain('app.example.com');
    expect(out).to.equal(`link ${REDACTED} token ${REDACTED} encoded ${REDACTED} nested ${REDACTED}`);
  });

  it('ignores empty values and leaves text without them untouched', () => {
    expect(redactText('nothing here', ['', TOKEN])).to.equal('nothing here');
    expect(redactText('nothing here', undefined)).to.equal('nothing here');
  });

  it('returns the original error when there is nothing to redact', () => {
    const err = new Error(`refused ${TOKEN}`);
    expect(redactError(err, undefined)).to.equal(err);
    expect(redactError(err, [])).to.equal(err);
    expect(redactError(err, [''])).to.equal(err);
  });

  it('builds a new error with the same name, a redacted message and no cause', () => {
    const inner = new Error(`inner ${TOKEN}`);
    const err = new TypeError(`refused ${TOKEN}`, { cause: inner });
    (err as any).response = `550 ${LINK}`;
    const out = redactError(err, [TOKEN, LINK]) as Error;
    expect(out).to.not.equal(err);
    expect(out.name).to.equal('TypeError');
    expect(out.message).to.equal(`refused ${REDACTED}`);
    expect((out as any).cause).to.equal(undefined);
    expect(holds(dump(out), TOKEN)).to.equal(false);
  });

  it('redacts a thrown non-error value', () => {
    const out = redactError(`refused ${TOKEN}`, [TOKEN]) as Error;
    expect(out).to.be.instanceOf(Error);
    expect(out.message).to.equal(`refused ${REDACTED}`);
  });
});

describe('DefaultEmailService with secret values ( redact )', () => {
  it('sendDeferred refuses a mail with secret values and emits nothing', async () => {
    const { service, emitted } = capturingEmailService();
    const err = await service.sendDeferred(secretMail()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(InvalidOperation);
    expect(holds(dump(err), TOKEN)).to.equal(false);
    expect(emitted).to.have.length(0);
  });

  it('send hands the transport the model and emits EmailSent without Model and Content', async () => {
    const { service, sender, emitted } = capturingEmailService();
    await service.send(secretMail());

    expect(sender.Captured[0].model.Token).to.equal(TOKEN);
    expect(emitted).to.have.length(1);
    const ev = emitted[0] as EmailSent;
    expect(ev).to.be.instanceOf(EmailSent);
    expect(ev.Model).to.equal(undefined);
    expect(ev.Content).to.equal(undefined);
    expect(ev.To).to.deep.equal(['alice@example.com']);
    expect(ev.Subject).to.equal('Reset your password');
    expect(ev).to.not.have.property('redact');
    expect(holds(dump(emitted), TOKEN)).to.equal(false);
    expect(dump(emitted)).to.not.contain('app.example.com');
  });

  it('send still emits Model and Content for a mail without secret values', async () => {
    const { service, emitted } = capturingEmailService();
    await service.send(plainMail());
    const ev = emitted[0] as EmailSent;
    expect(ev.Model).to.deep.equal({ Total: 10 });
    expect(ev.Content).to.equal('Total 10');
  });

  it('logs and rethrows a sender error redacted, raw and URI-encoded, with no cause', async () => {
    const { service, sender, logged, emitted, perf } = capturingEmailService();
    const original = new Error(`550 refused ${TOKEN} in ${LINK} and ${encodeURIComponent(TOKEN)}`, { cause: new Error(TOKEN) });
    sender.fail = () => original;

    const err = await service.send(secretMail()).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).to.not.equal(null);
    expect(err).to.not.equal(original);
    expect(err!.name).to.equal('Error');
    expect(err!.message).to.contain('550 refused');
    expect((err as any).cause).to.equal(undefined);
    expect(holds(dump(err), TOKEN)).to.equal(false);

    const errors = logged.filter((c) => c[0] === 'error');
    expect(errors).to.have.length(1);
    expect(holds(dump(logged), TOKEN)).to.equal(false);
    expect(dump(logged)).to.not.contain('app.example.com');
    expect(perf.some((m) => m.error !== undefined)).to.equal(true);
    expect(holds(dump(perf), TOKEN)).to.equal(false);
    expect(emitted).to.have.length(0);
  });

  it('rethrows the original error for a mail without secret values', async () => {
    const { service, sender } = capturingEmailService();
    const original = new Error('550 refused');
    sender.fail = () => original;
    await expect(service.send(plainMail())).to.be.rejectedWith(original);
  });
});
