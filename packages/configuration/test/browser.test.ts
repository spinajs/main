/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-floating-promises */
import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration, ConfigurationSource, StaticConfigurationSource } from '@spinajs/configuration-common';

import { BrowserFrameworkConfiguration } from '../src/configuration.browser.js';

function cfg() {
  return DI.resolve<Configuration>(Configuration);
}

/**
 * Track everything we register and unregister it afterwards. We must NOT use
 * DI.clearRegistry() here: it would wipe the import-time @Injectable
 * registrations other suites in this mocha process rely on ( JsFileSource,
 * JsonFileSource, config variables, ... ) — decorators only run once.
 */
const registered: unknown[] = [];

function track<T>(type: T): T {
  registered.push(type);
  return type;
}

describe('Browser configuration tests', () => {
  beforeEach(() => {
    DI.clearCache();
    // @Injectable(Configuration) already registered BrowserFrameworkConfiguration at
    // import time — BEFORE the node FrameworkConfiguration decorator ran — and
    // re-registering is name-deduped. Unregister first so ours is appended LAST
    // ( the container resolves the last registered implementation ).
    DI.unregister(BrowserFrameworkConfiguration);
    DI.register(track(BrowserFrameworkConfiguration)).as(Configuration);
  });

  afterEach(() => {
    DI.clearCache();
    registered.splice(0).forEach((t) => DI.unregister(t as never));
  });

  it('Should resolve with no sources registered', async () => {
    const config = await cfg();
    expect(config).to.be.instanceOf(BrowserFrameworkConfiguration);
    expect(config.get('anything', 'fallback')).to.eq('fallback');
  });

  it('Should load config from a static source', async () => {
    DI.register(track(StaticConfigurationSource({ a: 1, nested: { b: 2 } }))).as(ConfigurationSource);

    const config = await cfg();
    expect(config.get('a')).to.eq(1);
    expect(config.get('nested.b')).to.eq(2);
    expect(config.get(['nested', 'b'])).to.eq(2);
  });

  it('Should support set and merge at runtime', async () => {
    DI.register(track(StaticConfigurationSource({ a: 1, obj: { x: 1 } }))).as(ConfigurationSource);

    const config = await cfg();
    config.set('a', 42);
    expect(config.get('a')).to.eq(42);

    config.merge('obj', { y: 2 });
    expect(config.get('obj.x')).to.eq(1);
    expect(config.get('obj.y')).to.eq(2);
  });

  it('Should merge from the __configuration__ DI seam', async () => {
    DI.register(track(StaticConfigurationSource({ a: 1 }))).as(ConfigurationSource);
    DI.register(track({ seam: { value: 99 } })).asValue('__configuration__');

    const config = await cfg();
    expect(config.get('a')).to.eq(1);
    expect(config.get('seam.value')).to.eq(99);
  });

  it('Should respect source ordering ( higher Order overrides lower )', async () => {
    // lower Order loads first, higher Order merges after and wins scalar keys
    DI.register(track(StaticConfigurationSource({ v: 'low', low: true }, 0))).as(ConfigurationSource);
    DI.register(track(StaticConfigurationSource({ v: 'high', high: true }, 10))).as(ConfigurationSource);

    const config = await cfg();
    expect(config.get('v')).to.eq('high');
    expect(config.get('low')).to.eq(true);
    expect(config.get('high')).to.eq(true);
  });

  it('Should support a lazy factory static source', async () => {
    let called = 0;
    DI.register(
      track(
        StaticConfigurationSource(() => {
          called++;
          return { lazy: 'yes' };
        }),
      ),
    ).as(ConfigurationSource);

    const config = await cfg();
    expect(config.get('lazy')).to.eq('yes');
    expect(called).to.be.greaterThan(0);
  });
});
