import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, PerChildInstance } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';

import { FrameworkConfiguration } from '../src/configuration.js';
import { Config } from '../src/decorators.js';

function configurationOf(values: Record<string, unknown>) {
  const json = JSON.stringify(values);
  return class extends FrameworkConfiguration {
    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  };
}

class NoSource extends ConfigurationSource {
  public get Order() {
    return 0;
  }

  public Load(): Promise<IConfigLike> {
    return Promise.resolve({} as IConfigLike);
  }
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
  let root: IContainer;
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
    root = child({ feature: { value: 'root' } });
    // Registered in the root scenario container: an unregistered type would be created in the resolving child.
    root.register(PerChild).asSelf();
    root.register(RootSingleton).asSelf();
    await root.resolve(Configuration);
  });

  afterEach(async () => {
    for (const c of children.splice(0).reverse()) await c.dispose();
  });

  it('a per-child service in a child with its own Configuration reads the child value', async () => {
    const service = await child({ feature: { value: 'child' } }).resolve(PerChild);

    expect(service.Value).to.equal('child');
  });

  it('a per-child service in a child without its own Configuration reads the root value', async () => {
    expect((await child().resolve(PerChild)).Value).to.equal('root');
  });

  it('a root singleton reads the root value, also when resolved through a child', async () => {
    expect((await child({ feature: { value: 'child' } }).resolve(RootSingleton)).Value).to.equal('root');
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
    expect((await child({}).resolve(PerChild)).Value).to.equal('fallback');
  });
});
