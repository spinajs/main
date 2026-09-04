import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';

import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';

import { EmailSender, IEmail } from '../src/index.js';
import { DefaultEmailService } from '../src/index.js';

/** Captures what the transport was handed, instead of sending it. */
class CapturingSender extends EmailSender {
  public Captured: IEmail | null = null;

  constructor(public Options: any) {
    super();
  }

  public async send(email: IEmail): Promise<void> {
    this.Captured = email;
  }
}

/**
 * Minimal configuration: starts empty, `serviceWith` fills in `configuration.isProduction` and
 * `email.connections` per test via `cfg.set`.
 */
class TestConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { email: { connections: [] } };
  }
}

let cfg: Configuration;

before(async () => {
  DI.register(TestConf).as(Configuration);
  cfg = await DI.resolve(Configuration);
});

/**
 * Builds a service with one connection. `IsProduction` and `Configuration` are `@Config`-decorated
 * fields - the decorator installs a getter-only accessor on the prototype (see
 * `@spinajs/configuration`'s `Config()` in decorators.ts), so poking them via `(service as
 * any).Field = ...` throws instead of taking effect. Going through the real `Configuration`
 * exercises the exact path production uses, including the config path string itself: a typo
 * in `@Config('configuration.isProduction')` would otherwise go undetected and the production
 * guard would silently fail open.
 *
 * `Senders` and `Queue` are NOT `@Config` fields ( `@AutoinjectService` / `@Autoinject` don't
 * install accessors ), so plain assignment on those bypasses DI resolution as intended - no
 * container bootstrap needed for them.
 *
 * `Log` turns out to have the SAME getter-only accessor problem as `Configuration`/`AppEnv`
 * ( `@Logger`, packages/log-common/src/index.ts, installs an identical `configurable: false`
 * accessor ), so plain assignment throws here too. Unlike `Configuration`/`AppEnv`, `Log` is
 * not read through a config path whose correctness this test needs to prove - it's just a
 * logger handle - and letting it resolve for real would print actual log lines into the test
 * run. So it's shadowed with `Object.defineProperty` instead of routed through DI:
 * `Object.defineProperty` defines a new OWN property directly on the instance without going
 * through the prototype's setter lookup, so the prototype accessor's `configurable: false`
 * doesn't block it.
 */
function serviceWith(isProduction: boolean, redirectTo?: string[]) {
  const options = { name: 'test', service: 'CapturingSender', redirectTo };

  cfg.set('configuration.isProduction', isProduction);
  cfg.set('email.connections', [options]);

  const sender = new CapturingSender(options);
  const service = new DefaultEmailService();

  (service as any).Senders = new Map([['test', sender]]);
  Object.defineProperty(service, 'Log', {
    value: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), trace: sinon.stub() },
    configurable: true,
  });
  (service as any).Queue = { emit: sinon.stub().resolves() };

  return { service, sender };
}

const anEmail = (): IEmail => ({ to: ['client@acme.com'], connection: 'test', subject: 'Your invoice' });

describe('DefaultEmailService recipient redirect', () => {
  it('hands the transport the redirected copy on a dev environment', async () => {
    const { service, sender } = serviceWith(false, ['dev-inbox@screennetwork.pl']);

    await service.send(anEmail());

    expect(sender.Captured!.to).to.deep.equal(['dev-inbox@screennetwork.pl']);
    expect(sender.Captured!.subject).to.equal('[DEV->client@acme.com] Your invoice');
  });

  it('sends untouched when the connection configures no redirect', async () => {
    const { service, sender } = serviceWith(false, undefined);

    await service.send(anEmail());

    expect(sender.Captured!.to).to.deep.equal(['client@acme.com']);
    expect(sender.Captured!.subject).to.equal('Your invoice');
  });

  it('refuses to redirect on production, whatever the connection says', async () => {
    // Which environment names count as production is not this package's business - it asks
    // `configuration.isProduction` and believes the answer. The spellings, the APP_ENV over
    // NODE_ENV precedence and the empty-string case are settled in @spinajs/configuration and
    // tested there, in test/environment-flags.test.ts.
    const { service, sender } = serviceWith(true, ['dev-inbox@screennetwork.pl']);

    await service.send(anEmail());

    expect(sender.Captured!.to).to.deep.equal(['client@acme.com']);
    expect(sender.Captured!.subject).to.equal('Your invoice');
  });

  it('logs an error at startup when a production connection configures a redirect', async () => {
    const { service } = serviceWith(true, ['dev-inbox@screennetwork.pl']);

    await service.resolve();

    const error = (service as any).Log.error as sinon.SinonStub;
    expect(error.calledOnce).to.equal(true);
    expect(error.firstCall.args[0]).to.contain('test');
  });

  it('says nothing at startup on a dev environment', async () => {
    const { service } = serviceWith(false, ['dev-inbox@screennetwork.pl']);

    await service.resolve();

    expect(((service as any).Log.error as sinon.SinonStub).called).to.equal(false);
  });

  it('logs the redirect without putting addresses above trace', async () => {
    // Recipient addresses are PII, matching how send() already treats them on failure.
    const { service } = serviceWith(false, ['dev-inbox@screennetwork.pl']);

    await service.send(anEmail());

    const warn = (service as any).Log.warn as sinon.SinonStub;
    expect(warn.calledOnce).to.equal(true);
    expect(warn.firstCall.args[0]).to.not.contain('client@acme.com');
    expect((service as any).Log.trace.calledOnce).to.equal(true);
  });

  it('keeps the original recipients out of the info log on a redirected send', async () => {
    // The redirected subject embeds the real recipient by construction ( "[DEV->client@acme.com] ..." ),
    // so the pre-existing success log - which prints email.subject - must not be handed the
    // redirected copy, or a real customer address leaks at INFO level on every redirected send.
    const { service } = serviceWith(false, ['dev-inbox@screennetwork.pl']);

    await service.send(anEmail());

    const info = (service as any).Log.info as sinon.SinonStub;
    expect(info.calledOnce).to.equal(true);
    expect(info.firstCall.args[0]).to.not.contain('client@acme.com');
  });
});
