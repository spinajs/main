import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DI, forgetPendingProperties, Injectable, notePendingProperty, type Class, ClassInfo } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS, registerManifest, registerManifestSettings } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { FrameworkLogger, type Log } from '@spinajs/log';
import { analyzePackage } from '@spinajs/compiler';
import { hashManifest, type Manifest, type ManifestMode, type RouteEntry } from '@spinajs/manifest';
import { testManifest, type TestApp } from '@spinajs/testing';

import { dir, httpApp, req } from './common.js';
import {
  BaseController,
  CONTROLLED_DESCRIPTOR_SYMBOL,
  ControllerSource,
  Controllers,
  FilesystemControllerSource,
  HttpServer,
  ManifestControllerSource,
  type IControllerDescriptor,
  type IRoute,
  type IRouteParameter,
} from '../src/index.js';
import { AppUserController as AppUserWithMetadata, ConcreteCrudController as CrudWithMetadata, RuntimeTypeController as WithMetadata } from './manifest-runtime-type/src/controllers.js';
import { routesWithRuntimeTypes } from '../src/manifest-runtime-types.js';
import { compileWithoutMetadata } from './support/compile-without-metadata.js';

const FIXTURE = dir('manifest-runtime-type');
const MANIFEST_DIR = mkdtempSync(join(tmpdir(), 'manifest-runtime-type-'));

async function fixtureManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: join(FIXTURE, 'tsconfig.json'), packageRoot: FIXTURE });
  return testManifest({
    app: { name: fragment.package.name, version: fragment.package.version, root: FIXTURE, outDir: 'lib' },
    controllers: fragment.controllers,
    controllerBases: fragment.controllerBases,
    // the fixture's rootDir takes in the package's own src, which it imports
    classProperties: fragment.classProperties?.filter((c) => c.source.file.startsWith('src/')),
    schemas: fragment.schemas,
  });
}

let booted = 0;

async function boot(controller: Class<BaseController>, manifest?: Manifest, mode: ManifestMode = 'prefer'): Promise<TestApp> {
  const saved = { SPINAJS_MANIFEST: process.env.SPINAJS_MANIFEST, SPINAJS_MANIFEST_MODE: process.env.SPINAJS_MANIFEST_MODE };
  if (manifest) {
    const file = join(MANIFEST_DIR, `${mode}-${booted++}.json`);
    writeFileSync(file, JSON.stringify({ ...manifest, hash: hashManifest(manifest) }));
    process.env.SPINAJS_MANIFEST = file;
    process.env.SPINAJS_MANIFEST_MODE = mode;
  }

  try {
    const app = await httpApp({
      register: (c) => {
        c.unregister(ControllerSource, FilesystemControllerSource);
        c.unregister(ControllerSource, ManifestControllerSource);
        c.register(controller).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
    return app;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function bootFailure(controller: Class<BaseController>, manifest: Manifest, mode: ManifestMode): Promise<Error | undefined> {
  return boot(controller, manifest, mode).then(
    async (app) => {
      await app.dispose();
      return undefined;
    },
    (e: unknown) => e as Error,
  );
}

async function httpBootWith(source: Class<ControllerSource>, manifest: Manifest): Promise<TestApp> {
  const file = join(MANIFEST_DIR, `late-${booted++}.json`);
  writeFileSync(file, JSON.stringify({ ...manifest, hash: hashManifest(manifest) }));
  const saved = { SPINAJS_MANIFEST: process.env.SPINAJS_MANIFEST, SPINAJS_MANIFEST_MODE: process.env.SPINAJS_MANIFEST_MODE };
  process.env.SPINAJS_MANIFEST = file;
  process.env.SPINAJS_MANIFEST_MODE = 'require';
  try {
    return await httpApp({
      register: (c) => {
        c.unregister(ControllerSource, FilesystemControllerSource);
        c.unregister(ControllerSource, ManifestControllerSource);
        c.register(source).as(ControllerSource);
      },
      resolve: [Intl, Controllers],
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const routesOf = (controller: Class<BaseController>): Map<string | symbol, IRoute> => (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor).Routes;

const paramsOf = (routes: Map<string | symbol, IRoute>): IRouteParameter[] => [...routes.values()].flatMap((r) => [...r.Parameters.values()]);

const routeOf = (manifest: Manifest, handler: string): RouteEntry => manifest.controllers.find((c) => c.className === 'RuntimeTypeController')!.routes.find((r) => r.handler === handler)!;

async function typesServedBy(app: TestApp, controller: Class<BaseController>): Promise<unknown[]> {
  return paramsOf((await app.resolve(controller)).Routes).map((p): unknown => p.RuntimeType);
}

/** Status and body of every request, to compare a build with decorator metadata against one without. */
async function exchange(): Promise<Array<[number, unknown]>> {
  const out: Array<[number, unknown]> = [];
  for (const res of [
    await req().get('runtime-type/5'),
    await req().get('runtime-type/abc'),
    await req().post('runtime-type/create').send({ name: 'a', count: 1 }),
    await req().post('runtime-type/create').send({ name: 'a', count: 'x' }),
    await req().get('runtime-type/paged/list?page=5'),
  ]) {
    out.push([res.status, res.status === 200 ? res.body : (res.body as { status?: unknown }).status]);
  }
  return out;
}

describe('route argument types from the manifest ( no decorator metadata )', function () {
  this.timeout(60000);

  let manifest: Manifest;
  let WithoutMetadata: Class<BaseController>;
  let CrudWithout: Class<BaseController>;
  let AppUserWithout: Class<BaseController>;
  let CreateUserDto: Class<unknown>;
  let withMetadata: Array<[number, unknown]>;
  let controllerNamed: (name: string) => Class<BaseController>;

  before(async () => {
    compileWithoutMetadata(FIXTURE);
    const controllers = (await import(pathToFileURL(join(FIXTURE, 'lib', 'controllers.js')).href)) as Record<string, Class<BaseController>>;
    controllerNamed = (name) => controllers[name];
    WithoutMetadata = controllers.RuntimeTypeController;
    CrudWithout = controllers.ConcreteCrudController;
    AppUserWithout = controllers.AppUserController;
    CreateUserDto = ((await import(pathToFileURL(join(FIXTURE, 'lib', 'dto.js')).href)) as { CreateUserDto: Class<unknown> }).CreateUserDto;
    manifest = await fixtureManifest();

    const twin = await boot(WithMetadata, manifest);
    try {
      withMetadata = await exchange();
    } finally {
      await twin.dispose();
    }
  });

  after(() => {
    rmSync(MANIFEST_DIR, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  it('the fixture build records no parameter types', () => {
    expect(paramsOf(routesOf(WithoutMetadata)).map((p): unknown => p.RuntimeType)).to.deep.equal([undefined, undefined, undefined]);
  });

  describe('without a manifest that answers', () => {
    const silent = (errors: unknown[] = []) => ({ warn: () => undefined, error: (message: unknown) => errors.push(message) }) as unknown as Log;
    const fill = (mode: ManifestMode, log: Log) => {
      const container = DI.child();
      registerManifestSettings(container, { mode, path: 'app.manifest.json' });
      if (mode !== 'off') registerManifest(container, manifest);
      return routesWithRuntimeTypes({ container, controller: 'RuntimeTypeController', lineage: ['RuntimeTypeController'], routes: routesOf(WithoutMetadata), mountPath: () => 'runtime-type', log });
    };

    // A full boot in off mode would read argument names through the TypeScript cache, which needs declaration files.
    it('mode off leaves RuntimeType undefined: a build without decorator metadata needs the manifest', async () => {
      expect(paramsOf(await fill('off', silent())).map((p): unknown => p.RuntimeType)).to.deep.equal([undefined, undefined, undefined]);
    });

    it('logs a named error for each argument at boot', async () => {
      const errors: unknown[] = [];
      await fill('off', silent(errors));
      expect(errors).to.have.length(3);
      expect(errors[0]).to.match(/argument #0 of RuntimeTypeController::get has no runtime type/);
      expect(errors[0]).to.match(/no manifest/);
    });
  });

  describe('in require mode', () => {
    let app: TestApp;

    before(async () => {
      app = await boot(WithoutMetadata, manifest, 'require');
    });

    after(async () => {
      await app.dispose();
    });

    it('fills every argument on this boot', async () => {
      expect(await typesServedBy(app, WithoutMetadata)).to.deep.equal([Number, CreateUserDto, Number]);
    });

    it('answers as a build with decorator metadata', async () => {
      expect(await exchange()).to.deep.equal(withMetadata);
    });
  });

  it('fails the boot in require mode when the manifest cannot type an argument', async () => {
    const untyped = structuredClone(manifest);
    delete routeOf(untyped, 'create').params[0].runtimeType.ref;
    expect((await bootFailure(WithoutMetadata, untyped, 'require'))?.message).to.match(/argument dto of RuntimeTypeController::create has no runtime type/);
  });

  describe('an argument whose class the manifest cannot name', () => {
    it('boots in require mode when the argument kind never reads the type', async () => {
      const app = await boot(controllerNamed('UnnamedTypesController'), manifest, 'require');
      try {
        expect((await req().get('unnamed/request')).body).to.deep.equal({ method: 'GET' });
        expect((await req().post('unnamed/upload').set('Content-Type', 'application/octet-stream').send('x')).body).to.deep.equal({ stream: 'function' });
      } finally {
        await app.dispose();
      }
    });

    it('fails require with the reason, and the way out, when the argument kind reads it', async () => {
      const message = (await bootFailure(controllerNamed('UntypableController'), manifest, 'require'))?.message;
      expect(message).to.match(/argument when of UntypableController::since has no runtime type: DateTime is declared in .*luxon, which ships no manifest fragment/);
      expect(message).to.match(/with @Type\(\)/);
      expect(message).to.not.match(/run spinajs build/);
    });

    it('takes that way out: @Type names the class', async () => {
      const app = await boot(controllerNamed('NamedTypeController'), manifest, 'require');
      try {
        expect((await req().get('named/since?when=0')).status).to.equal(200);
      } finally {
        await app.dispose();
      }
    });
  });

  it('logs a named error for each untyped argument on a real boot with no manifest', async () => {
    const error = sinon.spy(FrameworkLogger.prototype, 'error');
    // Off mode reads argument names from the declaration file a real build emits next to the JavaScript.
    const declarations = join(FIXTURE, 'lib', 'controllers.d.ts');
    writeFileSync(declarations, 'export declare class UntypableController { since(when: unknown): unknown; }\n');
    try {
      const app = await boot(controllerNamed('UntypableController'));
      try {
        const logged = error.getCalls().map((c) => c.args[0] as unknown);
        expect(logged.filter((m) => typeof m === 'string' && /argument #0 of UntypableController::since has no runtime type: .*no manifest answers/.test(m))).to.have.length(1);
        expect((await req().get('since/since?when=0')).status).to.equal(500);
      } finally {
        await app.dispose();
      }
    } finally {
      error.restore();
      rmSync(declarations, { force: true });
    }
  });

  it('checks again once the controllers are loaded: a class that loads after Configuration still fails the boot', async () => {
    @Injectable(ControllerSource)
    class LateSource extends ControllerSource {
      public async getControllers() {
        const late = (await import(`${pathToFileURL(join(FIXTURE, 'lib', 'controllers.js')).href}?late`)) as Record<string, Class<BaseController>>;
        const info = new ClassInfo<BaseController>();
        info.name = 'RuntimeTypeController';
        info.type = late.RuntimeTypeController;
        return [info];
      }
    }

    const lacking = structuredClone(manifest);
    delete lacking.classProperties;
    forgetPendingProperties();
    try {
      const app = await httpBootWith(LateSource, lacking).catch((e: unknown) => e as Error);
      expect(app).to.be.instanceOf(Error);
      expect((app as Error).message).to.match(/does not list RuntimeTypeController\.Counter/);
    } finally {
      forgetPendingProperties();
      notePendingProperty(WithoutMetadata, 'Counter');
      DI.unregister(LateSource);
    }
  });

  it('fails the boot listing every property the manifest lacks, before any controller resolves', async () => {
    const lacking = structuredClone(manifest);
    delete lacking.classProperties;
    const message = (await bootFailure(WithoutMetadata, lacking, 'require'))?.message;
    expect(message).to.match(/does not list RuntimeTypeController\.Counter/);
  });

  it('does not take a type from a stale entry whose kind differs', async () => {
    const stale = structuredClone(manifest);
    routeOf(stale, 'get').params[0].kind = 'FromQuery';
    expect((await bootFailure(WithoutMetadata, stale, 'require'))?.message).to.match(/argument id of RuntimeTypeController::get has no runtime type: the manifest describes another argument/);
  });

  describe('in prefer mode', () => {
    let app: TestApp;

    before(async () => {
      app = await boot(WithoutMetadata, manifest);
    });

    after(async () => {
      await app.dispose();
    });

    it('types the arguments from TypeRef.ref', async () => {
      const [id, dto] = paramsOf((await app.resolve(WithoutMetadata)).Routes);
      expect(id.RuntimeType).to.equal(Number);
      expect(id.RouteParamSchema).to.deep.equal(paramsOf(routesOf(WithMetadata))[0].RouteParamSchema);
      expect(dto.RuntimeType).to.equal(CreateUserDto);
    });

    it('validates @Param() id: number as a number, hydrates @Body() dto and injects @Autoinject() properties as with metadata', async () => {
      const answers = await exchange();
      expect(answers[0]).to.deep.equal([200, { id: 5, type: 'number', injected: 'counter' }]);
      expect(answers[1][0]).to.equal(400);
      expect(answers[2]).to.deep.equal([200, { hydrated: true, name: 'a' }]);
      expect(answers[3][0]).to.equal(400);
      expect(answers).to.deep.equal(withMetadata);
    });

    it('types an argument under a decorator the compiler does not know', async () => {
      expect((await exchange())[4]).to.deep.equal([200, { page: 5, type: 'number' }]);
    });
  });

  describe('each boot fills its own copy', () => {
    const withIdAs = (type: string): Manifest => {
      const changed = structuredClone(manifest);
      routeOf(changed, 'get').params[0].runtimeType.ref = { package: 'global', file: '', export: type };
      return changed;
    };

    it('leaves the class descriptor untouched', async () => {
      const app = await boot(WithoutMetadata, manifest, 'require');
      await app.dispose();
      expect(paramsOf(routesOf(WithoutMetadata)).map((p): unknown => p.RuntimeType)).to.deep.equal([undefined, undefined, undefined]);
    });

    it('answers from the manifest of this boot, whatever booted before it', async () => {
      for (const [type, typed] of [['String', 'string'], ['Number', 'number']]) {
        const app = await boot(WithoutMetadata, withIdAs(type));
        try {
          expect(((await req().get('runtime-type/5')).body as { type: string }).type).to.equal(typed);
        } finally {
          await app.dispose();
        }
      }
    });

    it('a failed boot leaves nothing behind', async () => {
      const failing = structuredClone(manifest);
      delete routeOf(failing, 'create').params[0].runtimeType.ref;
      await bootFailure(WithoutMetadata, failing, 'require');
      expect(paramsOf(routesOf(WithoutMetadata)).map((p): unknown => p.RuntimeType)).to.deep.equal([undefined, undefined, undefined]);
    });
  });

  for (const mode of ['prefer', 'require'] as const) {
    describe(`inherited routes in ${mode} mode`, () => {
      it('types a route inherited from an abstract controller', async () => {
        const app = await boot(CrudWithout, manifest, mode);
        try {
          expect((await req().get('crud/5')).body).to.deep.equal({ id: 5, type: 'number' });
          expect((await req().get('crud/abc')).status).to.equal(400);
          expect((await req().post('crud/create').send({ name: 'a', count: 1 })).body).to.deep.equal({ hydrated: true, name: 'a' });
        } finally {
          await app.dispose();
        }
      });

      it('validates a body the abstract controller declares against its derived schema', async () => {
        const app = await boot(CrudWithout, manifest, mode);
        try {
          expect((await req().post('crud/create').send({ name: 'a', count: 'x' })).status).to.equal(400);
        } finally {
          await app.dispose();
        }
      });

      it('types an inherited route and an overriding one', async () => {
        const app = await boot(AppUserWithout, manifest, mode);
        try {
          expect((await req().get('app-user/refresh/7')).body).to.deep.equal({ from: 'pkg', id: 7, type: 'number' });
          expect((await req().get('app-user/grants/v2/8')).body).to.deep.equal({ from: 'app', page: 8, type: 'number' });
        } finally {
          await app.dispose();
        }
      });
    });
  }

  it('validates an inherited route of a build with decorator metadata too', async () => {
    const app = await boot(CrudWithMetadata, manifest);
    try {
      expect((await req().post('crud/create').send({ name: 'a', count: 'x' })).status).to.equal(400);
    } finally {
      await app.dispose();
    }
  });

  it('serves the override of a build with decorator metadata', async () => {
    const app = await boot(AppUserWithMetadata, manifest);
    try {
      expect((await req().get('app-user/grants/v2/8')).body).to.deep.equal({ from: 'app', page: 8, type: 'number' });
    } finally {
      await app.dispose();
    }
  });
});
