import 'mocha';
import { expect } from 'chai';
import Express from 'express';
import { ClassInfo, DI } from '@spinajs/di';
import { BaseController } from '../src/base-controller.js';
import { Controllers } from '../src/controllers.js';
import { ControllerRegistrationException, RouteRegistrationException } from '../src/exceptions.js';
import type { IControllerDescriptor, IRoute } from '../src/interfaces.js';

const noopLog = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  security: () => {},
  success: () => {},
};

function makeLoader(parameters: Record<string, string[]> = {}) {
  const loader = new Controllers();
  Object.defineProperty(loader, 'Log', { value: noopLog });
  (loader as any).ControllersCache = { getCache: async () => parameters };
  (loader as any).ControllersRouter = Express.Router();
  return loader;
}

function descriptor(routes: Array<[string, Partial<IRoute>]>): IControllerDescriptor {
  return {
    Routes: new Map(routes.map(([name, r]) => [name, { Method: name, Parameters: new Map(), Middlewares: [], Policies: [], ...r } as IRoute])),
    Middlewares: [],
    Policies: [],
    BasePath: 'test',
  } as IControllerDescriptor;
}

function classInfo(name: string, instance: unknown): ClassInfo<BaseController> {
  return Object.assign(new ClassInfo<BaseController>(), {
    name,
    file: `${name}.ts`,
    instance: instance as BaseController,
  });
}

describe('controllers fail-fast registration', () => {
  it('throws when controller instance is not resolved', async () => {
    const loader = makeLoader();
    const ci = classInfo('BrokenController', undefined);

    try {
      await loader.register(ci);
      expect.fail('expected ControllerRegistrationException');
    } catch (err) {
      expect(err).to.be.instanceOf(ControllerRegistrationException);
      expect((err as Error).message).to.contain('BrokenController');
    }
  });

  it('throws when route member does not exist on the controller', async () => {
    const loader = makeLoader({});
    const instance = {
      Descriptor: descriptor([['missingAction', { Path: 'missing' }]]),
      Router: Express.Router(),
    };
    const ci = classInfo('NoMemberController', instance);

    try {
      await loader.register(ci);
      expect.fail('expected RouteRegistrationException');
    } catch (err) {
      expect(err).to.be.instanceOf(RouteRegistrationException);
      expect((err as Error).message).to.contain('missingAction');
    }
  });

  it('falls back to runtime parameter extraction for inherited route members', async () => {
    const loader = makeLoader({});
    const route: Partial<IRoute> = {
      Path: 'inherited',
      Parameters: new Map([[0, { Name: '', Index: 0 } as any]]),
    };
    const instance = {
      Descriptor: descriptor([['inheritedAction', route]]),
      Router: Express.Router(),
      inheritedAction: async function (userId: number) {
        return userId;
      },
    };
    const ci = classInfo('InheritedController', instance);

    await loader.register(ci);
    expect(instance.Descriptor.Routes.get('inheritedAction')!.Parameters.get(0)!.Name).to.eq('userId');
  });

  it('throws when controller has descriptor but no router', async () => {
    const loader = makeLoader({});
    const instance = {
      Descriptor: descriptor([]),
      Router: undefined,
    };
    const ci = classInfo('NoRouterController', instance);

    try {
      await loader.register(ci);
      expect.fail('expected ControllerRegistrationException');
    } catch (err) {
      expect(err).to.be.instanceOf(ControllerRegistrationException);
      expect((err as Error).message).to.contain('NoRouterController');
    }
  });

  it('rolls back DI registration when add() fails', async () => {
    class ExplodingController extends BaseController {
      public async resolve() {
        throw new Error('boom');
      }
    }

    const loader = makeLoader({});

    let thrown: unknown;
    try {
      await loader.add(ExplodingController);
    } catch (err) {
      thrown = err;
    }
    // Whether the failure comes from the controller's own resolve() or from
    // DI dependency resolution, add() must rethrow it...
    expect(thrown, 'add() swallowed the resolve failure').to.exist;

    const registered = (DI.getRegisteredTypes(BaseController) ?? []) as unknown[];
    expect(registered).to.not.include(ExplodingController);

    DI.uncache(ExplodingController);
    DI.uncache(BaseController);
  });
});
