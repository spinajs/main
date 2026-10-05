import 'mocha';
import { expect } from 'chai';
import { DI, PerChildInstance } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { Config } from '../src/decorators.js';

function configurationOf(values: Record<string, unknown>) {
  const json = JSON.stringify(values);
  return class extends FrameworkConfiguration {
    public resolve(): Promise<void> {
      this.Config = JSON.parse(json) as Record<string, unknown>;
      return Promise.resolve();
    }
  };
}

@PerChildInstance()
class PerChild {
  @Config('feature.value', { defaultValue: 'fallback' })
  public Value: string;
}

class RootSingleton {
  @Config('feature.value')
  public Value: string;
}

class Plain {
  @Config('feature.value')
  public Value: string;
}

describe('@Config reads the Configuration of the container that built the instance', () => {
  beforeEach(async () => {
    DI.clear();
    DI.register(configurationOf({ feature: { value: 'root' } })).as(Configuration);
    // Registered in root: an unregistered type would be created in the resolving child.
    DI.register(PerChild).asSelf();
    DI.register(RootSingleton).asSelf();
    await DI.resolve(Configuration);
  });

  it('a per-child service in a child with its own Configuration reads the child value', async () => {
    const child = DI.child();
    child.register(configurationOf({ feature: { value: 'child' } })).as(Configuration);

    const service = await child.resolve(PerChild);

    expect(service.Value).to.equal('child');
  });

  it('a per-child service in a child without its own Configuration reads the root value', async () => {
    expect((await DI.child().resolve(PerChild)).Value).to.equal('root');
  });

  it('a root singleton reads the root value, also when resolved through a child', async () => {
    const child = DI.child();
    child.register(configurationOf({ feature: { value: 'child' } })).as(Configuration);

    expect((await child.resolve(RootSingleton)).Value).to.equal('root');
  });

  it('an instance built with new falls back to the root Configuration', () => {
    expect(new Plain().Value).to.equal('root');
  });

  it('the default applies when the path is missing', async () => {
    const child = DI.child();
    child.register(configurationOf({})).as(Configuration);

    expect((await child.resolve(PerChild)).Value).to.equal('fallback');
  });
});
