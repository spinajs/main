import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { existsSync, readdirSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import mjml2html from 'mjml';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { IOFail } from '@spinajs/exceptions';
import { FsBootsrapper, fsService, getFs } from '@spinajs/fs';
import { Templates } from '@spinajs/templates';
import { MjmlRenderer } from '@spinajs/templates-mjml';
import { EmailSenderSmtp } from '@spinajs/email-smtp-transport';

import { DefaultEmailService, EmailPasswordMailer, IEmail, IPasswordMail, PasswordMailConfiguration } from '../src/index.js';
import CONFIGURATION_SCHEMA from '../src/schemas/email.smtp.configuration.js';
import shipped from '../src/config/email.js';
import { dump, holds, recordingLog } from './capture.js';

const SECRET = 'Zx9-secret_Q7w';
const URL_BASE = 'https://app.example.com/password-reset';
const LINK = `${URL_BASE}?token=${SECRET}&email=alice%40example.com`;
const BUILTIN = resolve(process.cwd(), 'src', 'templates');
const PURPOSES = ['reset', 'invite'] as const;

const dir = (path: string) => resolve(normalize(join(process.cwd(), 'test', path)));
/** How the template engine writes a model value into HTML. */
const inHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/=/g, '&#x3D;');
const noopLog = new Proxy({}, { get: () => () => undefined }) as never;

const aMail = (over: Partial<IPasswordMail> = {}): IPasswordMail => ({
  identity: { type: 'user', id: 'u-1' },
  purpose: 'reset',
  to: { email: 'alice@example.com', name: 'Alice' },
  secret: SECRET,
  url: URL_BASE,
  ttlSeconds: 3600,
  ...over,
});

class TemplatesConfiguration extends FrameworkConfiguration {
  protected onLoad() {
    return {
      intl: { defaultLocale: 'en', locales: ['en'] },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      system: { dirs: { locales: [dir('./locales')] } },
      fs: {
        defaultProvider: 'email-templates',
        providers: [
          { service: 'fsNative', name: 'email-templates', basePath: dir('./templates') },
          { service: 'fsNative', name: 'email-builtin-templates', basePath: BUILTIN },
          { service: 'fsNative', name: 'project-templates', basePath: dir('./templates/project') },
        ],
      },
      email: { templateFs: 'email-templates', connections: [], defaultConnection: 'test' },
    };
  }
}

/** The configuration of `values` validated by the email schema, as an app boots it. */
function configurationOf(values: Record<string, unknown>): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SchemaConfiguration extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }
    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

async function violationsOf(template: unknown): Promise<string[]> {
  const child = DI.RootContainer.child();
  try {
    child.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    child.register(configurationOf({ email: { connections: [], defaultConnection: 'test', password: { reset: { template } } } })).as(Configuration);
    await child.resolve(Configuration);
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  } finally {
    await child.dispose();
  }
}

/** EmailPasswordMailer -> DefaultEmailService -> the SMTP sender, whose transport records what it would send. */
async function pipeline(options: PasswordMailConfiguration = { connection: 'test' }) {
  const templates = await DI.resolve(Templates);
  const sent: { html?: string; text?: string; subject: string }[] = [];
  const handed: IEmail[] = [];

  const sender = new EmailSenderSmtp({ service: 'EmailSenderSmtp', name: 'test', host: 'localhost', port: 25, resilience: { retries: 0, timeout: 1000 }, defaults: { mailFrom: 'no-reply@example.com' } });
  Object.defineProperty(sender, 'Log', { value: noopLog, writable: true, configurable: true });
  const s = sender as unknown as Record<string, unknown>;
  s.Templates = templates;
  s.defaultTemplateFs = getFs('email-templates');
  s.Transporter = { sendMail: async (o: { html?: string; text?: string; subject: string }) => (sent.push(o), { messageId: 'ok' }) };
  s.SendPipeline = (sender as unknown as { buildSendPipeline(): unknown }).buildSendPipeline();
  const send = sender.send.bind(sender);
  sender.send = async (email: IEmail) => {
    handed.push(email);
    await send(email);
  };

  const service = new DefaultEmailService();
  const { log } = recordingLog();
  (service as unknown as Record<string, unknown>).Senders = new Map([['test', sender]]);
  (service as unknown as Record<string, unknown>).Queue = { emit: async () => undefined };
  Object.defineProperty(service, 'Log', { value: log, configurable: true });
  Object.defineProperty(service, 'IsProduction', { value: false, configurable: true });
  Object.defineProperty(service, 'Configuration', { value: { connections: [sender.Options], defaultConnection: 'test' }, configurable: true });

  const mailer = new EmailPasswordMailer({ email: service, options, defaultConnection: 'test' });
  return { mailer, templates, sent, handed };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e,
  );
}

describe('EmailPasswordMailer MJML templates (MAIL-1, D14)', function () {
  this.timeout(60_000);

  before(async () => {
    DI.clearCache();
    DI.resolve(FsBootsrapper).bootstrap();
    DI.register(TemplatesConfiguration).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
  });

  after(() => {
    sinon.restore();
    DI.unregister(TemplatesConfiguration);
    DI.clearCache();
  });

  afterEach(() => sinon.restore());

  it('without template config, reset and invite render HTML with the subject, the ActionUrl and the expiry, and the mail redacts the secret and the link', async () => {
    const x = await pipeline();
    await x.mailer.send(aMail());
    await x.mailer.send(aMail({ purpose: 'invite', ttlSeconds: 900 }));

    const [reset, invite] = x.sent;
    expect(reset.html).to.match(/^<!doctype html>/i);
    expect(reset.html).to.contain('Reset your password');
    expect(reset.html).to.contain(inHtml(LINK));
    expect(reset.html).to.contain('60 minutes');
    expect(invite.html).to.contain('Set up your account');
    expect(invite.html).to.contain(inHtml(LINK));
    expect(invite.html).to.contain('15 minutes');

    for (const email of x.handed) {
      expect(email.redact).to.deep.equal([SECRET, LINK]);
    }
    expect(x.handed.map((e) => e.template)).to.deep.equal([
      { file: 'authn/reset.mjml', fs: 'email-builtin-templates' },
      { file: 'authn/invite.mjml', fs: 'email-builtin-templates' },
    ]);
  });

  it('without a reset url the built-in template shows the token instead of the button', async () => {
    const x = await pipeline();
    await x.mailer.send(aMail({ url: '' }));
    expect(x.sent[0].html).to.contain(SECRET);
    expect(x.sent[0].html).to.not.contain(URL_BASE);
  });

  it('renders email.password.appName into the header', async () => {
    const x = await pipeline({ connection: 'test', appName: 'Example Shop' });
    await x.mailer.send(aMail());
    expect(x.sent[0].html).to.contain('Example Shop');
  });

  it("a template path renders the project's file from email.templateFs instead", async () => {
    const x = await pipeline({ connection: 'test', reset: { template: 'custom/reset.mjml' } });
    await x.mailer.send(aMail());
    await x.mailer.send(aMail({ purpose: 'invite' }));
    expect(x.sent[0].html).to.contain('project-custom-reset');
    expect(x.sent[0].html).to.contain(inHtml(LINK));
    expect(x.sent[1].html).to.not.contain('project-custom-reset');
    expect(x.sent[1].html).to.contain('Set up your account');
  });

  it('{ file, fs } renders the file from that filesystem', async () => {
    const x = await pipeline({ connection: 'test', reset: { template: { file: 'reset.mjml', fs: 'project-templates' } } });
    await x.mailer.send(aMail());
    expect(x.sent[0].html).to.contain('project-fs-reset');
  });

  it('never sets text; Templates.render renders the .mjml file with MjmlRenderer', async () => {
    const x = await pipeline();
    const render = sinon.spy(x.templates, 'render');
    await x.mailer.send(aMail());

    expect(x.handed[0].text).to.equal(undefined);
    expect(x.sent[0].text).to.equal(undefined);
    expect(render.calledOnce).to.equal(true);
    const file = render.firstCall.args[0];
    expect(file.endsWith('.mjml'), file).to.equal(true);
    expect(x.templates.getRendererFor('.mjml')).to.be.instanceOf(MjmlRenderer);
    expect(render.firstCall.args[1]).to.include({ ActionUrl: LINK, ResetUrl: LINK, Token: SECRET, ExpiresInMinutes: 60, Purpose: 'reset', IsInvite: false, Name: 'Alice', Email: 'alice@example.com' });
  });

  it('a rendering error is an IOFail that holds neither the secret nor the link', async () => {
    const x = await pipeline();
    sinon.stub(x.templates, 'render').rejects(new Error(`cannot render ${LINK} for ${SECRET}`));

    const err = await failure(x.mailer.send(aMail()));
    expect(err).to.be.instanceOf(IOFail);
    const text = dump(err);
    expect(holds(text, SECRET)).to.equal(false);
    expect(text).to.not.contain(`${URL_BASE}?`);
    expect(x.sent).to.have.length(0);
  });

  it('every built-in template compiles with zero MJML errors, with and without a link', async () => {
    const templates = await DI.resolve(Templates);
    const files = readdirSync(join(BUILTIN, 'authn')).filter((f) => f.endsWith('.mjml'));
    expect(files.sort()).to.deep.equal(PURPOSES.map((p) => `${p}.mjml`).sort());
    for (const file of files) {
      for (const ActionUrl of [LINK, '']) {
        const model = { Purpose: file.replace('.mjml', ''), Name: 'Alice', Email: 'alice@example.com', ActionUrl, ResetUrl: ActionUrl, Token: SECRET, ExpiresInMinutes: 60, AppName: 'Example', IsInvite: file === 'invite.mjml', Subject: 'Subject' };
        const source = await templates.compile(join(BUILTIN, 'authn', file), 'handlebars', model);
        const { errors } = await mjml2html(source, { validationLevel: 'soft' });
        expect(errors, `${file} ${ActionUrl ? 'with' : 'without'} a link`).to.deep.equal([]);
      }
    }
  });

  it('ships every purpose with its built-in template in email-builtin-templates, under lib/templates', () => {
    for (const purpose of PURPOSES) {
      expect(shipped.email.password[purpose].template).to.deep.equal({ file: `authn/${purpose}.mjml`, fs: 'email-builtin-templates' });
      expect(existsSync(join(BUILTIN, 'authn', `${purpose}.mjml`)), purpose).to.equal(true);
    }
    const provider = shipped.fs.providers.find((p) => p.name === 'email-builtin-templates');
    expect(provider?.service).to.equal('fsNative');
    expect(normalize(provider!.basePath).endsWith(join('@spinajs', 'email', 'lib', 'templates'))).to.equal(true);
  });

  describe('config validation of email.password.<purpose>.template', () => {
    for (const template of [null, '', 'reset.hbs', 'reset.mjml.txt', { file: 'reset.hbs', fs: 'mail' }, { file: '', fs: 'mail' }, { file: 'reset.mjml', fs: '' }, { file: 'reset.mjml' }]) {
      it(`refuses ${JSON.stringify(template)} at boot`, async () => {
        const paths = await violationsOf(template);
        expect(
          paths.some((p) => p.startsWith('email.password.reset.template')),
          paths.join(', '),
        ).to.equal(true);
      });
    }

    for (const template of ['my/reset.mjml', { file: 'reset.mjml', fs: 'mail' }]) {
      it(`accepts ${JSON.stringify(template)}`, async () => {
        expect(await violationsOf(template)).to.deep.equal([]);
      });
    }
  });
});
