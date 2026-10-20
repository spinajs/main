import 'mocha';
import { expect } from 'chai';
import { DI, IContainer, PerChildInstance, ServiceNotFound } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import { Configuration, ConfigurationSource } from '@spinajs/configuration-common';

import { AutoinjectNamedServices, resolveNamedServices } from '../src/decorators.js';
import { configurationOf, NoSource } from './fixtures.js';

abstract class Step {
  public abstract readonly name: string;
}

class RootStep extends Step {
  public readonly name = 'root';
}

class OtherStep extends Step {
  public readonly name = 'other';
}

function factory(name: string, value: unknown) {
  const f = () => value;
  Object.defineProperty(f, 'name', { value: name });
  return f;
}

@PerChildInstance()
class Flow {
  @AutoinjectNamedServices('flow.steps', Step, { lineage: true, keyBy: 'name' })
  public Steps: Map<string, Step>;
}

describe('config-listed services', () => {
  const containers: IContainer[] = [];

  const child = (parent: IContainer, steps?: unknown) => {
    const c = parent.child();
    c.register(NoSource).as(ConfigurationSource);
    if (steps !== undefined) c.register(configurationOf({ flow: { steps } })).as(Configuration);
    containers.push(c);
    return c;
  };

  let root: IContainer;

  beforeEach(async () => {
    root = child(DI.RootContainer, [{ name: 'root', service: 'RootStep' }]);
    root.register(RootStep).as(Step);
    root.register(Flow).asSelf();
    await root.resolve(Configuration);
  });

  afterEach(async () => {
    for (const c of containers.splice(0).reverse()) await c.dispose();
  });

  describe('resolveNamedServices', () => {
    const flowIn = async (c: IContainer) => {
      await c.resolve(Configuration);
      return resolveNamedServices(c, 'flow.steps', Step, { lineage: true, keyBy: 'name' });
    };

    it('injects a Map keyed by the entry name, in list order', async () => {
      const c = child(root, [
        { name: 'other', service: 'OtherStep' },
        { name: 'root', service: 'RootStep' },
      ]);
      c.register(OtherStep).as(Step);

      const steps = await flowIn(c);

      expect([...steps.keys()]).to.deep.equal(['other', 'root']);
      expect(steps.get('other')).to.be.instanceOf(OtherStep);
      expect(steps.get('root')).to.be.instanceOf(RootStep);
    });

    it('takes the registration nearest to the resolving container', async () => {
      const c = child(root, [{ name: 'fake', service: 'Fake' }]);
      root.register(factory('Fake', { name: 'fake', from: 'root' })).as(Step);
      c.register(factory('Fake', { name: 'fake', from: 'child' })).as(Step);

      expect((await flowIn(c)).get('fake')).to.deep.equal({ name: 'fake', from: 'child' });
      expect((await flowIn(child(root, [{ name: 'fake', service: 'Fake' }]))).get('fake')).to.deep.equal({ name: 'fake', from: 'root' });
    });

    it('injects an empty Map when the path is not set', async () => {
      const c = child(root, null);
      expect([...(await flowIn(c))]).to.deep.equal([]);
    });

    it('throws ServiceNotFound naming the entry and the service when no registration has that name', async () => {
      const c = child(root, [{ name: 'totp', service: 'TotpStep' }]);
      await c.resolve(Configuration);

      const error = await flowIn(c).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(ServiceNotFound);
      expect((error as Error).message).to.equal('flow.steps entry "totp": no Step is registered as service "TotpStep"');
    });

    it('throws InvalidOption when the instance names itself differently from the entry', async () => {
      const c = child(root, [{ name: 'renamed', service: 'RootStep' }]);
      await c.resolve(Configuration);

      const error = await flowIn(c).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.equal('flow.steps entry "renamed" (service "RootStep"): the service has name "root"; the entry must match it');
    });

    it('throws InvalidOption, not ServiceNotFound, for a registered factory that returns undefined', async () => {
      const c = child(root, [{ name: 'void', service: 'Void' }]);
      c.register(factory('Void', undefined)).as(Step);
      await c.resolve(Configuration);

      const error = await resolveNamedServices(c, 'flow.steps', Step, { lineage: true, keyBy: 'name' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.equal('flow.steps entry "void" (service "Void"): the service has no name; the entry must match it');
    });

    it('throws InvalidOption when a name is listed twice', async () => {
      const c = child(root, [
        { name: 'root', service: 'RootStep' },
        { name: 'root', service: 'RootStep' },
      ]);
      await c.resolve(Configuration);

      const error = await resolveNamedServices(c, 'flow.steps', Step, { lineage: true, keyBy: 'name' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.equal('flow.steps lists name "root" twice');
    });

    it('throws InvalidOption when the value is not a list', async () => {
      const c = child(root, 'RootStep');
      await c.resolve(Configuration);

      const error = await resolveNamedServices(c, 'flow.steps', Step, { lineage: true, keyBy: 'name' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(InvalidOption);
      expect((error as Error).message).to.equal('flow.steps must be a list');
    });
  });

  describe('@AutoinjectNamedServices', () => {
    const flowOf = async (c: IContainer) => {
      await c.resolve(Configuration);
      return (await (c.resolve(Flow) as unknown as Promise<Flow>)).Steps;
    };

    it('injects what resolveNamedServices gives for the resolving container', async () => {
      const c = child(root, [
        { name: 'other', service: 'OtherStep' },
        { name: 'root', service: 'RootStep' },
      ]);
      c.register(OtherStep).as(Step);

      const injected = await flowOf(c);
      const listed = await resolveNamedServices(c, 'flow.steps', Step, { lineage: true, keyBy: 'name' });

      expect([...injected.keys()]).to.deep.equal(['other', 'root']);
      expect([...injected.keys()]).to.deep.equal([...listed.keys()]);
      expect(injected.get('other')).to.be.instanceOf(OtherStep);
    });

    it('resolves the Configuration of the container first when it is registered but not resolved yet', async () => {
      const c = child(root, [{ name: 'other', service: 'OtherStep' }]);
      c.register(OtherStep).as(Step);

      const flow = await (c.resolve(Flow) as unknown as Promise<Flow>);

      expect([...flow.Steps.keys()]).to.deep.equal(['other']);
    });

    it('lists per container: each child injects its own list', async () => {
      const a = child(root, [{ name: 'root', service: 'RootStep' }]);
      const b = child(root, null);

      expect([...(await flowOf(a)).keys()]).to.deep.equal(['root']);
      expect([...(await flowOf(b)).keys()]).to.deep.equal([]);
    });

    it('rejects the resolve with what resolveNamedServices throws', async () => {
      const c = child(root, [{ name: 'totp', service: 'TotpStep' }]);

      const error = await flowOf(c).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).to.be.instanceOf(ServiceNotFound);
      expect((error as Error).message).to.equal('flow.steps entry "totp": no Step is registered as service "TotpStep"');
    });

    it('needs the element type, which reflection of a Map cannot give', () => {
      // @ts-expect-error the type is required
      AutoinjectNamedServices('flow.steps', undefined, { lineage: true, keyBy: 'name' });
    });
  });
});
