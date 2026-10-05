import { AuthnAudit, AuthnService, AuthnThrottle, IdentityStore, MemoryAuthnThrottle, PrincipalFactory } from '@spinajs/authn';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';
import { FakeIdentityStore, RecordingPrincipalFactory } from '@spinajs/authn-testing';
import { expect } from 'chai';
import 'mocha';

import { DbAuthnAuditSink, DbAuthnThrottle } from '../src/index.js';

/** The app's own config adds nothing about the throttle; every package config is loaded the way an app loads it. */
class StandardAppConfiguration extends FrameworkConfiguration {
  constructor() {
    super();
    this.Env = 'test';
  }

  protected onLoad(): unknown {
    return { authn: { strategies: [] } };
  }
}

function bind(child: IContainer, base: Class<unknown>, name: string, value: unknown): void {
  const factory = { [name]: () => value }[name];
  child.register(factory).as(base);
}

describe('authn-orm with no throttle config (K6)', function () {
  this.timeout(60_000);

  let child: IContainer | undefined;

  // As an app's bootstrap does; the config loader then imports the packages' lib/mjs config files.
  before(() => DI.setESMModuleSupport());

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('boots the core with both throttles registered and no throttle config of the app, on DbAuthnThrottle', async () => {
    child = DI.RootContainer.child();
    expect((child.getRegisteredTypes(Array.chainOf(AuthnThrottle)) ?? []).map((t) => (t as { name?: string }).name)).to.include.members(['MemoryAuthnThrottle', 'DbAuthnThrottle']);
    child.register(StandardAppConfiguration).as(Configuration);
    bind(child, IdentityStore, 'K6IdentityStore', new FakeIdentityStore());
    bind(child, PrincipalFactory, 'K6PrincipalFactory', new RecordingPrincipalFactory());

    const configuration = await child.resolve(Configuration);
    expect(configuration.get('authn.throttle.service'), 'no package ships it').to.eq(undefined);
    expect(configuration.get('authn.audit.sinks'), 'the package configs are loaded').to.include('LogAuthnAuditSink');

    const service = (await child.resolve(AuthnService)) as AuthnService;
    const throttle = (service as unknown as { throttle: unknown }).throttle;
    expect(throttle).to.be.instanceOf(DbAuthnThrottle);
    expect(throttle).to.not.be.instanceOf(MemoryAuthnThrottle);
    const audit = await child.resolve(AuthnAudit);
    expect(audit.sinks().some((s) => s instanceof DbAuthnAuditSink), 'the DB sink gets every event without being listed').to.eq(true);
  });
});
