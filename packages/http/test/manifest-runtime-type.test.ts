import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DI, type Class } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS, registerManifest, registerManifestSettings } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import type { Log } from '@spinajs/log';
import { analyzePackage } from '@spinajs/compiler';
import { hashManifest, type Manifest, type ManifestMode } from '@spinajs/manifest';
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
  type IRouteParameter,
} from '../src/index.js';
import { RuntimeTypeController as WithMetadata } from './manifest-runtime-type/src/controllers.js';
import { runtimeTypesFromManifest } from '../src/manifest-runtime-types.js';
import { compileWithoutMetadata } from './support/compile-without-metadata.js';

const FIXTURE = dir('manifest-runtime-type');
const MANIFEST_DIR = mkdtempSync(join(tmpdir(), 'manifest-runtime-type-'));

async function fixtureManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: join(FIXTURE, 'tsconfig.json'), packageRoot: FIXTURE });
  return testManifest({ app: { name: fragment.package.name, version: fragment.package.version, root: FIXTURE, outDir: 'lib' }, controllers: fragment.controllers, schemas: fragment.schemas });
}

async function boot(controller: Class<BaseController>, manifest?: Manifest, mode: ManifestMode = 'prefer'): Promise<TestApp> {
  const saved = { SPINAJS_MANIFEST: process.env.SPINAJS_MANIFEST, SPINAJS_MANIFEST_MODE: process.env.SPINAJS_MANIFEST_MODE };
  if (manifest) {
    const file = join(MANIFEST_DIR, `${mode}-${Date.now()}.json`);
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

const paramsOf = (controller: Class<BaseController>): IRouteParameter[] =>
  [...(Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.prototype) as IControllerDescriptor).Routes.values()].flatMap((r) => [...r.Parameters.values()]);

/** Status and body of every request, to compare a build with decorator metadata against one without. */
async function exchange(): Promise<Array<[number, unknown]>> {
  const out: Array<[number, unknown]> = [];
  for (const res of [
    await req().get('runtime-type/5'),
    await req().get('runtime-type/abc'),
    await req().post('runtime-type/create').send({ name: 'a', count: 1 }),
    await req().post('runtime-type/create').send({ name: 'a', count: 'x' }),
  ]) {
    out.push([res.status, res.status === 200 ? res.body : (res.body as { status?: unknown }).status]);
  }
  return out;
}

describe('route argument types from the manifest ( no decorator metadata )', function () {
  this.timeout(60000);

  let manifest: Manifest;
  let WithoutMetadata: Class<BaseController>;
  let CreateUserDto: Class<unknown>;

  before(async () => {
    compileWithoutMetadata(FIXTURE);
    WithoutMetadata = ((await import(pathToFileURL(join(FIXTURE, 'lib', 'controllers.js')).href)) as { RuntimeTypeController: Class<BaseController> }).RuntimeTypeController;
    CreateUserDto = ((await import(pathToFileURL(join(FIXTURE, 'lib', 'dto.js')).href)) as { CreateUserDto: Class<unknown> }).CreateUserDto;
    manifest = await fixtureManifest();
  });

  after(() => {
    rmSync(MANIFEST_DIR, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  it('the fixture build records no parameter types', () => {
    expect(paramsOf(WithoutMetadata).map((p): unknown => p.RuntimeType)).to.deep.equal([undefined, undefined]);
  });

  // A full boot in off mode would read argument names through the TypeScript cache, which needs declaration files.
  it('mode off leaves RuntimeType undefined: a build without decorator metadata needs the manifest', async () => {
    const container = DI.child();
    registerManifestSettings(container, { mode: 'off', path: 'app.manifest.json' });
    registerManifest(container, manifest);
    const routes = (Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, WithoutMetadata.prototype) as IControllerDescriptor).Routes.values();
    await runtimeTypesFromManifest({ container, controller: 'RuntimeTypeController', routes, mountPath: () => '/runtime-type', log: { warn: () => undefined } as unknown as Log });
    expect(paramsOf(WithoutMetadata).map((p): unknown => p.RuntimeType)).to.deep.equal([undefined, undefined]);
  });

  it('fails the boot in require mode when the manifest cannot type an argument', async () => {
    const untyped = structuredClone(manifest);
    delete untyped.controllers[0].routes.find((r) => r.handler === 'create')!.params[0].runtimeType.ref;
    const error = await boot(WithoutMetadata, untyped, 'require').then(
      async (app) => {
        await app.dispose();
        return undefined;
      },
      (e: unknown) => e as Error,
    );
    expect(error?.message).to.match(/argument dto of RuntimeTypeController::create has no runtime type/);
  });

  // The first boot that types the arguments fills the class's descriptor for the rest of the process: it runs last.
  describe('mode prefer', () => {
    let withMetadata: Array<[number, unknown]>;
    let app: TestApp;

    before(async () => {
      const twin = await boot(WithMetadata, manifest);
      try {
        withMetadata = await exchange();
      } finally {
        await twin.dispose();
      }
      app = await boot(WithoutMetadata, manifest);
    });

    after(async () => {
      await app.dispose();
    });

    it('types the arguments from TypeRef.ref', () => {
      const [id, dto] = paramsOf(WithoutMetadata);
      expect(id.RuntimeType).to.equal(Number);
      expect(id.RouteParamSchema).to.deep.equal(paramsOf(WithMetadata)[0].RouteParamSchema);
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

    it('answers the same in require mode', async () => {
      await app.dispose();
      app = await boot(WithoutMetadata, manifest, 'require');
      expect(await exchange()).to.deep.equal(withMetadata);
    });
  });
});
