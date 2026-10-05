import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { EmailPasswordMailer, EmailSend, EmailSent, EmailService, IEmail, IPasswordMail, PasswordMailConfiguration } from '../src/index.js';
import { capturingEmailService, dump, holds, recordPerf } from './capture.js';

const SECRET = 'Zx9-secret_Q7w';
const URL_BASE = 'https://app.example.com/password-reset';
const RESET_URL = `${URL_BASE}?token=${SECRET}&email=alice%40example.com`;

const aMail = (over: Partial<IPasswordMail> = {}): IPasswordMail => ({
  identity: { type: 'user', id: 'u-1' },
  purpose: 'reset',
  to: { email: 'alice@example.com', name: 'Alice' },
  secret: SECRET,
  url: URL_BASE,
  ttlSeconds: 3600,
  ...over,
});

function mailerWith(options?: PasswordMailConfiguration, defaultConnection?: string) {
  const x = capturingEmailService();
  const mailer = new EmailPasswordMailer({ email: x.service, options: options ?? { connection: 'test' }, defaultConnection });
  return { ...x, mailer };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e,
  );
}

describe('EmailPasswordMailer', () => {
  recordPerf();

  it('sends a reset mail at once with the 2.x model names, the link, the tag and the secrets to redact', async () => {
    const { mailer, sender, emitted } = mailerWith();
    await mailer.send(aMail());

    expect(sender.Captured).to.have.length(1);
    const m = sender.Captured[0];
    expect(m.to).to.deep.equal(['alice@example.com']);
    expect(m.connection).to.equal('test');
    expect(m.subject).to.equal('Reset your password');
    expect(m.tag).to.equal('authn-password-reset');
    expect(m.model).to.deep.equal({
      Token: SECRET,
      ResetUrl: RESET_URL,
      ExpiresInMinutes: 60,
      IsInvite: false,
      Name: 'Alice',
      Email: 'alice@example.com',
      Purpose: 'reset',
    });
    expect(m.redact).to.deep.equal([SECRET, RESET_URL]);
    expect(m.template).to.equal(undefined);
    expect(m.text).to.contain(RESET_URL);
    expect(m.text).to.contain('60 minutes');

    expect(emitted.some((e) => e instanceof EmailSend)).to.equal(false);
    expect(emitted.every((e) => e instanceof EmailSent)).to.equal(true);
    expect(holds(dump(emitted), SECRET)).to.equal(false);
  });

  it('sends an invite mail with its own subject, tag and lifetime', async () => {
    const { mailer, sender } = mailerWith();
    await mailer.send(aMail({ purpose: 'invite', ttlSeconds: 900 }));

    const m = sender.Captured[0];
    expect(m.subject).to.equal('Set up your account');
    expect(m.tag).to.equal('authn-password-invite');
    expect(m.model).to.include({ IsInvite: true, ExpiresInMinutes: 15, Purpose: 'invite', Token: SECRET, ResetUrl: RESET_URL });
    expect(m.text).to.contain(RESET_URL);
    expect(m.text).to.contain('15 minutes');
  });

  it('without a url puts the token into the text and leaves ResetUrl empty', async () => {
    const { mailer, sender } = mailerWith();
    await mailer.send(aMail({ url: '' }));

    const m = sender.Captured[0];
    expect(m.model.ResetUrl).to.equal('');
    expect(m.text).to.contain(SECRET);
    expect(m.redact).to.deep.equal([SECRET]);
  });

  it('renders the configured template with from, lang and subject from the configuration', async () => {
    const { mailer, sender } = mailerWith({
      connection: 'test',
      from: 'no-reply@example.com',
      lang: 'pl',
      reset: { subject: 'Zmień hasło', template: 'password-reset.hbs' },
      invite: { subject: 'Witamy', template: { file: 'invite.hbs', fs: 'mail-templates' } },
    });
    await mailer.send(aMail());
    await mailer.send(aMail({ purpose: 'invite' }));

    const [reset, invite] = sender.Captured;
    expect(reset).to.include({ from: 'no-reply@example.com', lang: 'pl', subject: 'Zmień hasło', template: 'password-reset.hbs' });
    expect(reset.text).to.equal(undefined);
    expect(reset.model.Token).to.equal(SECRET);
    expect(invite.subject).to.equal('Witamy');
    expect(invite.template).to.deep.equal({ file: 'invite.hbs', fs: 'mail-templates' });
  });

  it('falls back to email.defaultConnection', async () => {
    const { mailer, sender } = mailerWith({}, 'test');
    await mailer.send(aMail());
    expect(sender.Captured[0].connection).to.equal('test');
  });

  it('fails clearly when neither email.password.connection nor email.defaultConnection is set', async () => {
    const { mailer, sender } = mailerWith({});
    const err = await failure(mailer.send(aMail()));
    expect(err.message).to.contain('reset');
    expect(err.message).to.contain('email.defaultConnection');
    expect(sender.Captured).to.have.length(0);
  });

  it('refuses a recipient without an address, without the secret in the error', async () => {
    const { mailer, sender } = mailerWith();
    const err = await failure(mailer.send(aMail({ to: { name: 'Alice' } })));
    expect(err.message).to.contain('reset');
    expect(holds(dump(err), SECRET)).to.equal(false);
    expect(sender.Captured).to.have.length(0);
  });

  it('rethrows a transport failure naming the purpose, without the secret, the link or a cause', async () => {
    const { mailer, sender, logged, emitted, perf } = mailerWith();
    sender.fail = (e: IEmail) => new Error(`550 rejected ${e.model.ResetUrl} (${e.model.Token})`, { cause: new Error(e.model.Token) });

    const err = await failure(mailer.send(aMail({ purpose: 'invite' })));

    expect(err.message).to.contain('invite');
    expect((err as any).cause).to.equal(undefined);
    expect((err as any).inner).to.equal(undefined);
    const text = dump(err);
    expect(holds(text, SECRET)).to.equal(false);
    expect(text).to.not.contain(URL_BASE);
    expect(holds(dump([logged, perf]), SECRET)).to.equal(false);
    expect(emitted).to.have.length(0);
  });
});

class RecordingEmailService extends EmailService {
  public Sent: IEmail[] = [];

  public async send(email: IEmail): Promise<void> {
    this.Sent.push(email);
  }

  public async sendDeferred(): Promise<EmailSend> {
    throw new Error('a password mail must never be deferred');
  }

  public async processDeferredEmails(): Promise<void> {
    /* noop */
  }
}

class PasswordMailConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      email: {
        connections: [],
        defaultConnection: 'main',
        password: { from: 'no-reply@example.com', reset: { subject: 'Zmień hasło' } },
      },
    };
  }
}

describe('EmailPasswordMailer from the container', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(PasswordMailConf).as(Configuration);
    DI.register(RecordingEmailService).as(EmailService);
    DI.uncache(Configuration);
    DI.uncache(EmailService);
    await DI.resolve(Configuration);
  });

  after(async () => {
    DI.unregister(RecordingEmailService);
    DI.unregister(PasswordMailConf);
    DI.uncache(EmailService);
    DI.uncache(Configuration);
    // @Config getters in later suites read whatever Configuration the container holds, so resolve the one registered before.
    if (DI.check(Configuration)) {
      await DI.resolve(Configuration);
    }
  });

  it('reads email.password and email.defaultConnection and sends through the registered EmailService', async () => {
    const mailer = new EmailPasswordMailer();
    await mailer.send(aMail());
    await mailer.send(aMail({ purpose: 'invite' }));

    const service = (await DI.resolve(EmailService)) as RecordingEmailService;
    const [reset, invite] = service.Sent;
    expect(reset).to.include({ connection: 'main', from: 'no-reply@example.com', subject: 'Zmień hasło' });
    expect(invite.subject).to.equal('Set up your account');
  });
});
