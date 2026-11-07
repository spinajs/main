import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { DI, Injectable, NewInstance } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';
import type { Configuration } from '@spinajs/configuration';

import { httpApp, TestConfiguration } from './common.js';
import { BaseController, BasePath, Controllers, ErrorHandlerService, File, FileInfoMiddleware, FileUploadMiddleware, Get, Ok, Post, resolveConfigErrorHandlers, resolveConfiguredTypes, RouteMiddleware } from '../src/index.js';
import { globalRouteMiddlewareDescriptors } from '../src/global-route-middlewares.js';
import { uploadMiddlewares } from '../src/route-args/FromForm.js';
import type { IUploadedFile } from '../src/index.js';

abstract class Step {
  abstract run(): string;
}

@Injectable(Step)
class StepByBase extends Step {
  run() {
    return 'base';
  }
}

// registered under its own name only, as `@Injectable()` does
@Injectable()
class StepBySelf extends Step {
  constructor(public readonly options?: unknown) {
    super();
  }
  run() {
    return 'self';
  }
}

class StepByClass extends Step {
  run() {
    return 'class';
  }
}

@Injectable()
class NotAStep {}

@Injectable()
class SelfOnlyRouteMiddleware extends RouteMiddleware {}

@Injectable()
@NewInstance()
class UploadWithOptions extends FileUploadMiddleware {
  constructor(public readonly options?: unknown) {
    super();
  }
  public async beforeUpload(file: IUploadedFile): Promise<IUploadedFile> {
    return file;
  }
}

class NamedHandler extends ErrorHandlerService {
  readonly on = Error;
  constructor(public readonly entry: unknown) {
    super();
  }
  handle() {
    return undefined;
  }
}

const KEY = 'test.steps';

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('nothing was thrown');
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('nothing was thrown');
}

const cfgOf = (key: string, entries: unknown[]): Configuration => ({ get: (path: string, fallback?: unknown) => (path === key ? entries : fallback) }) as unknown as Configuration;

describe('resolveConfiguredTypes', () => {
  const resolve = (entries: unknown[]) => resolveConfiguredTypes(KEY, Step, entries, DI.RootContainer);

  it('gives the types in config order: a name registered as the base, a class, and { service, options }', () => {
    const resolved = resolve(['StepByBase', StepByClass, { service: 'StepByBase', options: [1] }, { service: StepByClass }]);
    expect(resolved.map((r) => r.type)).to.deep.eq([StepByBase, StepByClass, StepByBase, StepByClass]);
    expect(resolved.map((r) => r.options)).to.deep.eq([undefined, undefined, [1], undefined]);
    expect(resolved[2].entry).to.deep.eq({ service: 'StepByBase', options: [1] });
  });

  it('finds a name registered only under its own name when that class extends the base', () => {
    expect(resolve(['StepBySelf']).map((r) => r.type)).to.deep.eq([StepBySelf]);
  });

  it('refuses an unknown name with InvalidOption naming the key and the name', () => {
    const err = thrownBy(() => resolve(['StepByBase', 'NoSuchStep']));
    expect(err).to.be.instanceOf(InvalidOption);
    expect(err.message).to.contain(KEY).and.to.contain('NoSuchStep').and.to.contain('Step');
  });

  it('refuses a name or a class that does not extend the base', () => {
    for (const entry of ['NotAStep', NotAStep, { service: NotAStep }]) {
      const err = thrownBy(() => resolve([entry]));
      expect(err, String(entry)).to.be.instanceOf(InvalidOption);
      expect(err.message).to.contain(KEY).and.to.contain('NotAStep');
    }
  });

  it('refuses an entry of another shape, naming it', () => {
    for (const entry of [42, null, ['StepByBase'], { options: [] }, { service: 3 }]) {
      const err = thrownBy(() => resolve([entry]));
      expect(err, JSON.stringify(entry)).to.be.instanceOf(InvalidOption);
      expect(err.message).to.contain(KEY).and.to.contain(JSON.stringify(entry));
    }
  });
});

describe('configured services per key', () => {
  describe('http.routes.middlewares', () => {
    it('names a RouteMiddleware registered under its own name', () => {
      expect(globalRouteMiddlewareDescriptors(cfgOf('http.routes.middlewares', ['SelfOnlyRouteMiddleware']), DI.RootContainer)).to.deep.eq([{ Type: SelfOnlyRouteMiddleware, Options: [] }]);
    });

    it('keeps options an array of constructor arguments', () => {
      const err = thrownBy(() => globalRouteMiddlewareDescriptors(cfgOf('http.routes.middlewares', [{ service: 'SelfOnlyRouteMiddleware', options: { a: 1 } }]), DI.RootContainer));
      expect(err).to.be.instanceOf(InvalidOption);
      expect(err.message).to.contain('http.routes.middlewares');
    });
  });

  describe('http.errors.handlers', () => {
    it('passes the whole entry to the service', async () => {
      DI.register(NamedHandler).as(ErrorHandlerService);
      const [descriptor] = await resolveConfigErrorHandlers(cfgOf('http.errors.handlers', [{ service: 'NamedHandler', extra: 1 }]), DI.RootContainer);
      expect(descriptor.On).to.deep.eq([Error]);
    });

    it('refuses an unknown name with InvalidOption naming the key and the name', async () => {
      const err = await rejectionOf(() => resolveConfigErrorHandlers(cfgOf('http.errors.handlers', [{ service: 'NoSuchHandler' }]), DI.RootContainer));
      expect(err).to.be.instanceOf(InvalidOption);
      expect(err.message).to.contain('http.errors.handlers').and.to.contain('NoSuchHandler');
    });

    it('keeps the { service } shape: a bare name or a class is refused', async () => {
      for (const entry of ['NamedHandler', NamedHandler, { service: NamedHandler }]) {
        const err = await rejectionOf(() => resolveConfigErrorHandlers(cfgOf('http.errors.handlers', [entry]), DI.RootContainer));
        expect(err, String(entry)).to.be.instanceOf(InvalidOption);
        expect(err.message).to.contain('http.errors.handlers');
      }
    });
  });

  describe('http.upload.middlewares', () => {
    it('resolves names, classes and { service, options } with options as the one constructor argument', () => {
      const middlewares = uploadMiddlewares(['FileInfoMiddleware', UploadWithOptions, { service: 'UploadWithOptions', options: { level: 9 } }], DI.RootContainer);
      expect(middlewares[0]).to.be.instanceOf(FileInfoMiddleware);
      expect((middlewares[1] as UploadWithOptions).options).to.eq(undefined);
      expect((middlewares[2] as UploadWithOptions).options).to.deep.eq({ level: 9 });
    });

    it('refuses an unknown name with InvalidOption naming the key and the name', () => {
      const err = thrownBy(() => uploadMiddlewares(['FileInfoMiddleware', 'NoSuchUploadMiddleware'], DI.RootContainer));
      expect(err).to.be.instanceOf(InvalidOption);
      expect(err.message).to.contain('http.upload.middlewares').and.to.contain('NoSuchUploadMiddleware');
    });

    @BasePath('configured-upload')
    class UploadController extends BaseController {
      @Post()
      public upload(@File() file: IUploadedFile) {
        return new Ok({ name: file.Name });
      }
    }

    @BasePath('configured-no-upload')
    class NoUploadController extends BaseController {
      @Get()
      public plain() {
        return new Ok();
      }
    }

    const uploadConfig = (middlewares: unknown[]) =>
      class extends TestConfiguration {
        public async resolve(): Promise<void> {
          await super.resolve();
          const config = this.Config as { http: Record<string, unknown>; system: { dirs: Record<string, unknown> } };
          config.http.upload = { middlewares };
          // only the controller a test registers, not the upload routes of test/controllers
          config.system.dirs.controllers = [];
        }
      };

    it('fails the boot of a controller with an upload route, naming the key and the name', async () => {
      const err = await rejectionOf(async () => {
        const app = await httpApp({
          configuration: uploadConfig(['NoSuchUploadMiddleware']),
          register: (c) => c.register(UploadController).as(BaseController),
          resolve: [Intl, Controllers],
        });
        await app.dispose();
      });
      expect(err).to.be.instanceOf(InvalidOption);
      expect(err.message).to.contain('http.upload.middlewares').and.to.contain('NoSuchUploadMiddleware');
    });

    it('is not read by a controller without upload routes', async () => {
      const app = await httpApp({
        configuration: uploadConfig(['NoSuchUploadMiddleware']),
        register: (c) => c.register(NoUploadController).as(BaseController),
        resolve: [Intl, Controllers],
      });
      await app.dispose();
    });
  });
});
