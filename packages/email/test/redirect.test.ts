import 'mocha';
import { expect } from 'chai';

import { redirectRecipients } from '../src/redirect.js';
import { IEmail } from '../src/interfaces.js';

const anEmail = (over: Partial<IEmail> = {}): IEmail => ({
  to: ['client@acme.com'],
  connection: 'test',
  subject: 'Your invoice',
  ...over,
});

describe('redirectRecipients', () => {
  const TEST_ACCOUNT = ['dev-inbox@screennetwork.pl'];

  it('is inert when no redirect is configured', () => {
    expect(redirectRecipients(anEmail(), undefined)).to.equal(null);
    expect(redirectRecipients(anEmail(), [])).to.equal(null);
  });

  it('replaces the recipients with the test account', () => {
    const result = redirectRecipients(anEmail({ to: ['a@x.com', 'b@x.com'] }), TEST_ACCOUNT);
    expect(result!.to).to.deep.equal(['dev-inbox@screennetwork.pl']);
  });

  it('drops cc and bcc', () => {
    // Dropped rather than redirected: the tester gets exactly one copy, and no address
    // outside redirectTo can receive anything.
    const result = redirectRecipients(anEmail({ cc: ['boss@acme.com'], bcc: ['audit@acme.com'] }), TEST_ACCOUNT);
    expect(result!.cc).to.equal(undefined);
    expect(result!.bcc).to.equal(undefined);
  });

  it('names the real recipients in the subject', () => {
    const result = redirectRecipients(anEmail({ to: ['a@x.com', 'b@x.com'] }), TEST_ACCOUNT);
    expect(result!.subject).to.equal('[DEV->a@x.com,b@x.com] Your invoice');
  });

  it('summarises past three recipients', () => {
    // A send to a large distribution list must not produce an unreadable subject line.
    const to = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'];
    const result = redirectRecipients(anEmail({ to }), TEST_ACCOUNT);
    expect(result!.subject).to.equal('[DEV->a@x.com,b@x.com,c@x.com +2 more] Your invoice');
  });

  it('marks a send that had no recipients', () => {
    const result = redirectRecipients(anEmail({ to: [] }), TEST_ACCOUNT);
    expect(result!.subject).to.equal('[DEV] Your invoice');
  });

  it('never mutates the email it was given', () => {
    // The queue retries a deferred send on the same job instance. Mutating would stack a
    // second prefix on every retry and corrupt the persisted job.
    const original = anEmail({ to: ['a@x.com'], cc: ['b@x.com'] });
    const result = redirectRecipients(original, TEST_ACCOUNT);

    expect(original.to).to.deep.equal(['a@x.com']);
    expect(original.cc).to.deep.equal(['b@x.com']);
    expect(original.subject).to.equal('Your invoice');
    expect(result).to.not.equal(original);
  });

  it('carries through every field the transports read', () => {
    // EmailSenderSmtp reads exactly these off the email; losing any of them would send a
    // blank or misaddressed message.
    const original = anEmail({
      from: 'noreply@x.com',
      replyTo: 'support@x.com',
      template: 'invoice.pug',
      model: { total: 42 },
      lang: 'pl',
      text: 'plain body',
      attachements: [{ name: 'a.pdf', path: '/tmp/a.pdf' }],
      tag: 'invoices',
      emailId: 'abc-123',
      connection: 'notifications',
    });

    const result = redirectRecipients(original, TEST_ACCOUNT)!;

    expect(result.from).to.equal('noreply@x.com');
    expect(result.replyTo).to.equal('support@x.com');
    expect(result.template).to.equal('invoice.pug');
    expect(result.model).to.deep.equal({ total: 42 });
    expect(result.lang).to.equal('pl');
    expect(result.text).to.equal('plain body');
    expect(result.attachements).to.deep.equal([{ name: 'a.pdf', path: '/tmp/a.pdf' }]);
    expect(result.tag).to.equal('invoices');
    expect(result.emailId).to.equal('abc-123');
    expect(result.connection).to.equal('notifications');
  });
});
