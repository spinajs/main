import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, PerChildInstance } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { Config } from '../src/decorators.js';
import { configurationOf, NoSource } from './fixtures.js';

@PerChildInstance()
class PerChild {
  @Config('feature.value', { defaultValue: 'fallback' })
  public Value: string;
}

class RootSingleton {
  @Config('feature.value')
  public Value: string;
}

const sharedConfiguration = (values: Record<string, unknown>) => {
  const Base = configurationOf(values);
  class SharedConfiguration extends Base {}
  return SharedConfiguration;
};

class Plain {
  @Config('feature.value')
  public Value: string;
}

describe('@Config reads the Configuration of the container that built the instance', () => {
  let root: IContainer | undefined;
  const children: IContainer[] = [];

  const child = (values?: Record<string, unknown>, parent: IContainer = root ?? DI.RootContainer) => {
    const c = parent.child();
    c.register(NoSource).as(ConfigurationSource);
    if (values) c.register(configurationOf(values)).as(Configuration);
    children.push(c);
    return c;
  };

  beforeEach(async () => {
    // The root of the scenarios: a child of the global container, so nothing leaks into other test files.
    const scenario = child({ feature: { value: 'root' } }, DI.RootContainer);
    // Registered in the root scenario container: an unregistered type would be created in the resolving child.
    scenario.register(PerChild).asSelf();
    scenario.register(RootSingleton).asSelf();
    await scenario.resolve(Configuration);
    root = scenario;
  });

  afterEach(async () => {
    root = undefined;
    for (const c of children.splice(0).reverse()) await c.dispose();
  });

  it('a per-child service in a child with its own Configuration reads the child value', async () => {
    const c = child({ feature: { value: 'child' } });
    await c.resolve(Configuration);
    const service = await c.resolve(PerChild);

    expect(service.Value).to.equal('child');
  });

  it('a per-child service in a child without its own Configuration reads the root value', async () => {
    expect((await child().resolve(PerChild)).Value).to.equal('root');
  });

  it('a root singleton reads the root value, also when resolved through a child', async () => {
    const c = child({ feature: { value: 'child' } });
    await c.resolve(Configuration);
    expect((await c.resolve(RootSingleton)).Value).to.equal('root');
  });

  it('an instance built with new falls back to the root Configuration', () => {
    const cache = DI.RootContainer.Cache;
    const saved = cache.get(FrameworkConfiguration, false) as unknown[];
    const global = new (configurationOf({}))();
    global.set('feature.value', 'global');
    cache.remove(FrameworkConfiguration);
    cache.add(FrameworkConfiguration, global);
    try {
      expect(new Plain().Value).to.equal('global');
    } finally {
      cache.remove(FrameworkConfiguration);
      saved.forEach((i) => cache.add(FrameworkConfiguration, i));
    }
  });

  it('the default applies when the path is missing', async () => {
    const c = child({});
    await c.resolve(Configuration);
    expect((await c.resolve(PerChild)).Value).to.equal('fallback');
  });

  it('a class with @Config resolves synchronously before the Configuration boots', async () => {
    const c = child({ feature: { value: 'child' } });
    const result = c.resolve(PerChild);

    expect(result).to.not.be.instanceOf(Promise);

    await c.resolve(Configuration);
    expect((result as PerChild).Value).to.equal('child');
  });

  it('reading the property throws when the Configuration of the container is not resolved', () => {
    const service = child({ feature: { value: 'child' } }).resolve(PerChild) as PerChild;

    expect(() => service.Value).to.throw(InvalidOperation, /feature.value/);
  });

  it('a same-named Configuration class in the root does not leak into a child that has not resolved its own', async () => {
    const scenario = child(undefined, DI.RootContainer);
    scenario.register(sharedConfiguration({ feature: { value: 'root' } })).as(Configuration);
    scenario.register(PerChild).asSelf();
    await scenario.resolve(Configuration);

    const c = child(undefined, scenario);
    c.register(sharedConfiguration({ feature: { value: 'child' } })).as(Configuration);
    const service = c.resolve(PerChild) as PerChild;

    expect(() => service.Value).to.throw(InvalidOperation, /feature.value/);

    await c.resolve(Configuration);
    expect(service.Value).to.equal('child');
  });

  it('reads a Configuration registered through a factory, once it is resolved', async () => {
    const instance = await child({ feature: { value: 'factory' } }).resolve(Configuration);

    const c = child();
    c.register(() => instance).as(Configuration);
    const service = c.resolve(PerChild) as PerChild;

    expect(service.Value).to.equal('factory');
  });

  it('throws for a factory-registered Configuration that is still resolving', () => {
    const c = child();
    c.register(() => Promise.resolve(new (configurationOf({}))())).as(Configuration);
    const service = c.resolve(PerChild) as PerChild;

    expect(() => service.Value).to.throw(InvalidOperation, /feature.value/);
  });
});
