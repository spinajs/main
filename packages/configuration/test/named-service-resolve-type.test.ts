import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, isPromise, PerChildInstance, ResolvesAsync } from '@spinajs/di';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { AutoinjectNamedService } from '../src/decorators.js';
import { configurationOf, NoSource } from './fixtures.js';

abstract class MailTransport {
  abstract send(): string;
}
class SmtpTransport extends MailTransport {
  send() {
    return 'smtp';
  }
}

@PerChildInstance()
class Mailer {
  declare readonly [ResolvesAsync]: true;

  @AutoinjectNamedService('mail.transport', MailTransport)
  public Transport: MailTransport;

  public send() {
    return this.Transport.send();
  }
}

// Compile-level: ts-node type-checks this file, so the expectation below fails the suite if the type is wrong.
function resolveTypes(c: IContainer): Mailer {
  // @ts-expect-error a class with a config-named service may resolve to a promise, not to the instance
  const mailer: Mailer = c.resolve(Mailer);
  return mailer;
}

describe('the resolve type of a class with a config-named service', () => {
  let container: IContainer;

  beforeEach(async () => {
    container = DI.RootContainer.child();
    container.register(NoSource).as(ConfigurationSource);
    container.register(configurationOf({ mail: { transport: 'SmtpTransport' } })).as(Configuration);
    container.register(SmtpTransport).as(MailTransport);
    await container.resolve(Configuration);
  });

  afterEach(async () => {
    await container.dispose();
  });

  it('may be a promise, as the first resolve is at run time', async () => {
    expect(resolveTypes).to.be.a('function');

    const pending = container.resolve(Mailer);

    expect(isPromise(pending)).to.equal(true);
    expect((await pending).send()).to.equal('smtp');
  });
});
