import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, PerChildInstance } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { AutoinjectNamedService, resolveNamedService } from '../src/decorators.js';
import { configurationOf, NoSource } from './fixtures.js';

abstract class Engine {
  abstract run(): string;
}
class FastEngine extends Engine {
  run() {
    return 'fast';
  }
}
class SlowEngine extends Engine {
  run() {
    return 'slow';
  }
}

@PerChildInstance()
class Car {
  @AutoinjectNamedService('car.engine', Engine)
  public Engine: Engine;
}

describe('config-named service', () => {
  const containers: IContainer[] = [];
  const child = (parent: IContainer, engine?: unknown) => {
    const c = parent.child();
    c.register(NoSource).as(ConfigurationSource);
    c.register(configurationOf({ car: engine === undefined ? {} : { engine } })).as(Configuration);
    containers.push(c);
    return c;
  };
  let root: IContainer;

  beforeEach(async () => {
    root = child(DI.RootContainer, 'FastEngine');
    root.register(FastEngine).as(Engine);
    root.register(SlowEngine).as(Engine);
    root.register(Car).asSelf();
    await root.resolve(Configuration);
  });

  afterEach(async () => {
    for (const c of containers.splice(0).reverse()) await c.dispose();
  });

  const named = async (c: IContainer, options?: Parameters<typeof resolveNamedService<Engine>>[3]) => {
    await c.resolve(Configuration);
    return resolveNamedService(c, 'car.engine', Engine, options);
  };
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as Error);

  it('resolves the registration the config names, across the lineage', async () => {
    expect((await named(child(root, 'SlowEngine'))).run()).to.equal('slow');
  });

  it('the decorator injects the same, per resolving container', async () => {
    const c = child(root, 'SlowEngine');
    await c.resolve(Configuration);
    expect((await (c.resolve(Car) as unknown as Promise<Car>)).Engine.run()).to.equal('slow');
  });

  it('the decorator resolves the Configuration of the container first when it is registered but not resolved yet', async () => {
    const c = child(root, 'SlowEngine');
    expect((await (c.resolve(Car) as unknown as Promise<Car>)).Engine.run()).to.equal('slow');
  });

  it('names path, name and registered names for an unknown name', async () => {
    const e = await failure(named(child(root, 'Jet')));
    expect(e).to.be.instanceOf(InvalidOption);
    expect(e!.message).to.equal('car.engine "Jet": no Engine is registered under that name (registered: "FastEngine", "SlowEngine")');
  });

  it('refuses an unset value without a default', async () => {
    const e = await failure(named(child(root, '')));
    expect(e!.message).to.equal('car.engine is not set (registered: "FastEngine", "SlowEngine")');
  });

  it('takes a default name or class when unset', async () => {
    expect((await named(child(root, ''), { default: 'SlowEngine' })).run()).to.equal('slow');
    expect((await named(child(root), { default: FastEngine })).run()).to.equal('fast');
  });

  it('asks a picker with the registered names, and refuses when it returns none', async () => {
    let seen: readonly string[] = [];
    const pick = (names: readonly string[]) => {
      seen = names;
      return names.find((n) => n.startsWith('Slow'));
    };
    expect((await named(child(root), { default: pick })).run()).to.equal('slow');
    expect(seen).to.deep.equal(['FastEngine', 'SlowEngine']);
    const e = await failure(named(child(root), { default: () => undefined }));
    expect(e!.message).to.equal('car.engine is not set and no Engine is the default among those registered ("FastEngine", "SlowEngine"); name one');
  });

  it('treats a function declaration as a picker, not a class', async () => {
    function pickSlow(names: readonly string[]) {
      return names.find((n) => n.startsWith('Slow'));
    }
    expect((await named(child(root), { default: pickSlow })).run()).to.equal('slow');
  });

  it('refuses an instance the duck check rejects', async () => {
    const e = await failure(named(child(root, 'SlowEngine'), { is: () => false }));
    expect(e!.message).to.equal('car.engine "SlowEngine" is not an Engine');
  });

  it('runs a factory-registered Configuration once per resolve', async () => {
    let runs = 0;
    const Cfg = configurationOf({ car: { engine: 'SlowEngine' } });
    const c = root.child();
    containers.push(c);
    c.register(NoSource).as(ConfigurationSource);
    c.register({ Factory: (self: IContainer) => (runs++, self.resolve(Cfg)) }.Factory).as(Configuration);
    expect((await resolveNamedService(c, 'car.engine', Engine)).run()).to.equal('slow');
    expect(runs).to.equal(1);
  });

  it('refuses a value that is set but not a string', async () => {
    for (const value of [3, true, {}, ['FastEngine']]) {
      const e = await failure(named(child(root, value)));
      expect(e).to.be.instanceOf(InvalidOption);
      expect(e!.message).to.equal('car.engine must be a string');
    }
  });
});
