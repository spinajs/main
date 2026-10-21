import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { PasswordService } from '@spinajs/authn/contracts';
import type { AuthnContext } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, FakeIdentityStore, MemoryPasswordCredentialStore, MemorySecretStore, MemorySessionIssuer } from '@spinajs/authn-testing';
import { AUTHN_LOCAL_CONFIGURATION_SCHEMA, Argon2PasswordHasher, AuthnMailDispatcher, InlineAuthnMailDispatcher, LocalPasswordPolicy, LocalPasswordService } from '@spinajs/authn-local';
import { AuthnMailJob, QueueAuthnMailDispatcher } from '@spinajs/authn-local/queue';
import { EmailPasswordMailer, EmailSend, EmailService } from '@spinajs/email';
import type { IEmail } from '@spinajs/email';
import type { IQueueMessage } from '@spinajs/queue';

import { RbacBootstrapper, checkAuthnMailRouting } from '../src/index.js';

const ROUTE = 'queue.routing.AuthnMailJob';

function configurationOf(values: Record<string, unknown>, env: string): Class<Configuration> {
  const json = JSON.stringify(values);
  return class MailWiringConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }
    protected loadSources(): void {
      this.Sources = [];
    }
    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

const children: IContainer[] = [];

async function boot(values: Record<string, unknown>, env = 'test'): Promise<IContainer> {
  const child = DI.RootContainer.child();
  children.push(child);
  child.register(AUTHN_LOCAL_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  child.register(configurationOf(values, env)).as(Configuration);
  await child.resolve(Configuration);
  return child;
}

const delivery = (mode: 'queue' | 'inline') => ({ authn: { local: { mail: { delivery: mode } } } });

/** AuthnMailJob routed to `connection`, which `service` implements (none: the connection is missing). */
const routedTo = (service: string | null, mode: 'queue' | 'inline' = 'queue') => ({
  ...delivery(mode),
  queue: {
    default: 'app-queue',
    routing: { AuthnMailJob: { connection: 'authn-mail' } },
    connections: [{ name: 'app-queue', service: 'StompQueueClient' }, ...(service ? [{ name: 'authn-mail', service }] : [])],
  },
});

async function bootError(values: Record<string, unknown>, env: string): Promise<unknown> {
  const child = await boot(values, env);
  try {
    await child.resolve(AuthnMailDispatcher);
  } catch (e) {
    return e;
  }
  return null;
}

class RecordingEmailService extends EmailService {
  public readonly Sent: IEmail[] = [];
  public deferred = 0;
  public async send(email: IEmail): Promise<void> {
    this.Sent.push(email);
  }
  public async sendDeferred(): Promise<EmailSend> {
    this.deferred++;
    throw new Error('an authn mail must never be deferred');
  }
  public async processDeferredEmails(): Promise<void> {
    /* noop */
  }
}

describe('authn mail wiring (MAIL-1, D12)', function () {
  this.timeout(60_000);

  before(() => {
    new RbacBootstrapper().bootstrap();
  });

  afterEach(async () => {
    for (const c of children.splice(0).reverse()) await c.dispose();
  });

  it('the users bootstrapper registers the authn mail dispatcher', () => {
    expect(DI.RootContainer.hasRegistered(AuthnMailDispatcher)).to.equal(true);
  });

  it("delivery 'queue' registers QueueAuthnMailDispatcher, 'inline' the inline one", async () => {
    expect(await (await boot(delivery('queue'))).resolve(AuthnMailDispatcher)).to.be.instanceOf(QueueAuthnMailDispatcher);
    expect(await (await boot(delivery('inline'))).resolve(AuthnMailDispatcher)).to.be.instanceOf(InlineAuthnMailDispatcher);
    expect(await (await boot({})).resolve(AuthnMailDispatcher), 'the default').to.be.instanceOf(QueueAuthnMailDispatcher);
  });

  for (const [label, service] of [
    ['a BlackHoleQueueClient', 'BlackHoleQueueClient'],
    ['a missing connection', null],
  ] as const) {
    it(`in production, AuthnMailJob routed to ${label} fails the boot with InvalidOption naming ${ROUTE}`, async () => {
      const err = await bootError(routedTo(service), 'production');
      expect(err).to.be.instanceOf(InvalidOption);
      expect((err as Error).message).to.contain(ROUTE);
    });

    it(`in test env, AuthnMailJob routed to ${label} boots`, async () => {
      expect(await bootError(routedTo(service), 'test')).to.equal(null);
    });
  }

  it('in production, AuthnMailJob routed to a real connection boots', async () => {
    expect(await bootError(routedTo('StompQueueClient'), 'production')).to.equal(null);
  });

  it('without a route, AuthnMailJob goes to queue.default, which the check follows', async () => {
    const values = { ...delivery('queue'), queue: { default: 'app-queue', connections: [{ name: 'app-queue', service: 'BlackHoleQueueClient' }] } };
    const err = await bootError(values, 'production');
    expect(err).to.be.instanceOf(InvalidOption);
    expect((err as Error).message).to.contain(ROUTE);
  });

  it("delivery 'inline' needs no queue connection in production", async () => {
    expect(await bootError(routedTo('BlackHoleQueueClient', 'inline'), 'production')).to.equal(null);
  });

  it('checkAuthnMailRouting reads a booted configuration', async () => {
    const child = await boot(routedTo('BlackHoleQueueClient'), 'production');
    expect(() => checkAuthnMailRouting(child.get(Configuration)!)).to.throw(InvalidOption, ROUTE);
  });

  it('a queued mail runs AuthnMailJob -> LocalPasswordService.deliver -> EmailPasswordMailer -> EmailService.send, never sendDeferred', async () => {
    const email = new RecordingEmailService();
    const emitted: IQueueMessage[] = [];
    const identities = new FakeIdentityStore();
    const hasher = new Argon2PasswordHasher({});
    await hasher.resolve();
    const service = new LocalPasswordService({
      identities,
      passwords: new MemoryPasswordCredentialStore(),
      sessions: new MemorySessionIssuer(),
      throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
      tokens: null,
      secrets: new MemorySecretStore(),
      mailer: new EmailPasswordMailer({ email, options: { connection: 'test' } }),
      sinks: [],
      hasher,
      policy: new LocalPasswordPolicy({}),
      resetUrl: 'https://app.test/password-reset',
      dispatcher: new QueueAuthnMailDispatcher({ emit: async (m: IQueueMessage) => (emitted.push(m), undefined) }),
    });
    identities.add({ login: 'queued@spinajs.pl', email: 'queued@spinajs.pl' });
    const ctx: AuthnContext = { now: new Date(), purpose: 'request', ip: '198.51.100.4' };

    await service.requestReset('queued@spinajs.pl', ctx);
    await service.drain();
    expect(emitted).to.have.length(1);
    expect(email.Sent).to.have.length(0);

    const factory = () => service;
    DI.register(factory).as(PasswordService);
    DI.uncache(PasswordService);
    try {
      const job = new AuthnMailJob();
      job.hydrate(JSON.parse(JSON.stringify(emitted[0])));
      expect(await job.execute()).to.deep.equal({ result: true });
    } finally {
      // By identity: unregister(factory) alone drops a factory under every other token too.
      DI.unregister(PasswordService, factory);
      DI.uncache(PasswordService);
    }

    expect(email.deferred).to.equal(0);
    expect(email.Sent).to.have.length(1);
    const [mail] = email.Sent;
    expect(mail.to).to.deep.equal(['queued@spinajs.pl']);
    expect(mail.text).to.equal(undefined);
    expect(String((mail.template as { file: string }).file)).to.match(/\.mjml$/);
    const token = String((mail.model as { Token: unknown }).Token);
    expect(mail.redact).to.include(token);
    expect(JSON.stringify(emitted)).to.not.contain(token);
  });
});
