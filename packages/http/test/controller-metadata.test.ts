import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { join } from 'node:path';
import { ClassInfo } from '@spinajs/di';
import { analyzePackage } from '@spinajs/compiler';
import type { ControllerEntry, Manifest, ManifestMode } from '@spinajs/manifest';
import { sourceRef, testManifest, withManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { DefaultControllerCache } from '../src/cache.js';
import { BaseController, CacheControllerMetadata, CONTROLLED_DESCRIPTOR_SYMBOL, ControllerMetadataProvider, Controllers, HttpServer, ManifestControllerMetadata, NoControllerMetadata } from '../src/index.js';
import type { IControllerDescriptor } from '../src/index.js';
import { MetadataParamsController } from './controller-metadata/MetadataParamsController.js';
import { MetadataUnlistedController } from './controller-metadata/MetadataUnlistedController.js';
import { MetadataMixedController } from './controller-metadata/MetadataMixedController.js';
import { dir, httpApp, req } from './common.js';

// The source names the arguments `a` and `b`; the manifest says `first` and `second`, so a request bound by the
// manifest's names proves the manifest answered and not the TypeScript cache.
const entry: ControllerEntry = {
  id: 'test-app:MetadataParamsController',
  className: 'MetadataParamsController',
  basePath: 'metadata-params',
  mountPath: 'metadata-params',
  policies: [],
  middlewares: [],
  routes: [
    {
      method: 'get',
      path: 'query',
      handler: 'query',
      fullPath: '/metadata-params/query',
      params: [
        { index: 1, name: 'second', kind: 'FromQuery', runtimeType: { text: 'number' }, required: true },
        { index: 0, name: 'first', kind: 'FromQuery', runtimeType: { text: 'string' }, required: true },
      ],
      returnType: { text: 'Ok' },
      policies: [],
      middlewares: [],
      doc: { summary: 'Query test', description: 'Binds two query values', tags: ['metadata'], deprecated: true, responses: [{ status: 404, description: 'not here' }] },
      source: sourceRef('test/controller-metadata/MetadataParamsController.ts'),
    },
  ],
  source: sourceRef('test/controller-metadata/MetadataParamsController.ts'),
};

const manifest: Manifest = testManifest({ root: process.cwd(), controllers: [entry] });

function classInfo(type: typeof BaseController, name = type.name, file = 'MetadataParamsController'): ClassInfo<BaseController> {
  return Object.assign(new ClassInfo<BaseController>(), { name, type, file: dir(`controller-metadata/${file}.ts`) });
}

const FIXTURE = dir('controller-metadata');

/** The fixture controllers as the compiler records them: arguments under an unknown decorator get no entry. */
async function compiledManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: join(FIXTURE, 'tsconfig.json'), packageRoot: FIXTURE, schemaDerivation: false });
  return testManifest({ app: { name: fragment.package.name, version: fragment.package.version, root: FIXTURE, outDir: '.' }, controllers: fragment.controllers });
}

describe('ControllerMetadataProvider', function () {
  this.timeout(60000);

  let app: TestApp | undefined;

  async function boot(mode: ManifestMode, resolve: Array<typeof Controllers> = []): Promise<TestApp> {
    app = await httpApp({ register: withManifest(manifest, mode), resolve });
    return app;
  }

  afterEach(async () => {
    sinon.restore();
    await app?.dispose();
    app = undefined;
  });

  it('the manifest provider answers parameter names in argument order and docs from the manifest', async () => {
    const booted = await boot('require');
    const provider = await booted.resolve(ManifestControllerMetadata);
    const ci = classInfo(MetadataParamsController);

    expect(provider.supports(ci)).to.equal(true);
    expect(await provider.parameters(ci, 'query')).to.deep.equal(['first', 'second']);
    expect(await provider.parameters(ci, 'missing')).to.deep.equal([]);

    const doc = await provider.documentation(ci);
    expect(doc.className).to.equal('MetadataParamsController');
    expect(doc.methods.query).to.deep.include({ summary: 'Query test', description: 'Binds two query values', tags: ['metadata'], deprecated: true });
    expect(doc.methods.query.params).to.deep.equal({ first: { name: 'first' }, second: { name: 'second' } });
    expect(doc.methods.query.responses).to.deep.equal({ '404': { description: 'not here' } });
  });

  it('the manifest provider does not support a controller the manifest lacks', async () => {
    const booted = await boot('prefer');
    const provider = await booted.resolve(ManifestControllerMetadata);
    expect(provider.supports(classInfo(MetadataUnlistedController))).to.equal(false);
  });

  it('the manifest provider supports nothing in off mode', async () => {
    const booted = await boot('off');
    const provider = await booted.resolve(ManifestControllerMetadata);
    expect(provider.supports(classInfo(MetadataParamsController))).to.equal(false);
  });

  it('providers are registered in priority order: manifest before cache', async () => {
    const booted = await boot('prefer');
    const providers = await booted.container.resolve(Array.ofType(ControllerMetadataProvider));
    const sorted = [...providers].sort((a, b) => a.Priority - b.Priority);
    expect(sorted[0]).to.be.instanceOf(ManifestControllerMetadata);
    expect(sorted[sorted.length - 1]).to.be.instanceOf(CacheControllerMetadata);
  });

  it('the loader binds arguments by the manifest names in require mode without the TypeScript cache', async () => {
    const getCache = sinon.spy(DefaultControllerCache.prototype, 'getCache');
    const booted = await boot('require', [Controllers]);
    await (await booted.resolve(HttpServer)).start();

    const res = await req().get('metadata-params/query?first=x&second=2');
    expect(res.status, res.text).to.equal(200);
    expect(res.body).to.deep.equal({ a: 'x', b: 2 });
    expect(getCache.called).to.equal(false);
  });

  it('throws NoControllerMetadata for a controller outside the manifest in require mode', async () => {
    const booted = await boot('require', [Controllers]);
    const loader = await booted.resolve(Controllers);

    let error: unknown;
    try {
      await loader.add(MetadataUnlistedController);
    } catch (err) {
      error = err;
    }
    expect(error).to.be.instanceOf(NoControllerMetadata);
    expect((error as Error).message).to.include('MetadataUnlistedController');
  });

  it('falls back to the TypeScript cache for a controller outside the manifest in prefer mode', async () => {
    const booted = await boot('prefer', [Controllers]);
    await (await booted.resolve(HttpServer)).start();
    await (await booted.resolve(Controllers)).add(MetadataUnlistedController);

    const res = await req().get('metadata-unlisted/ping?value=v');
    expect(res.status, res.text).to.equal(200);
    expect(res.body).to.deep.equal({ value: 'v' });
  });

  describe('with a compiler-built manifest', () => {
    let compiled: Manifest;

    before(async () => {
      compiled = await compiledManifest();
    });

    it('answers the same parameter names as the TypeScript cache, argument by argument', async () => {
      app = await httpApp({ register: withManifest(compiled, 'prefer') });
      const provider = await app.resolve(ManifestControllerMetadata);
      const cache = await app.resolve(DefaultControllerCache);

      const fixtures: Array<[typeof BaseController, string]> = [
        [MetadataParamsController, 'MetadataParamsController'],
        [MetadataUnlistedController, 'MetadataUnlistedController'],
        [MetadataMixedController, 'MetadataMixedController'],
      ];
      for (const [type, file] of fixtures) {
        const ci = classInfo(type, type.name, file);
        const fromCache = await cache.getCache(ci);
        const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, type.prototype) as IControllerDescriptor;
        for (const [method, route] of descriptor.Routes) {
          const fromManifest = await provider.parameters(ci, String(method));
          for (const index of route.Parameters.keys()) {
            expect(fromManifest[index], `${type.name}.${String(method)}[${index}]`).to.equal(fromCache[String(method)][index]);
          }
        }
      }
    });

    it('binds every argument of a route that mixes recorded and unrecorded decorators in require mode', async () => {
      app = await httpApp({ register: withManifest(compiled, 'require'), resolve: [Controllers] });
      await (await app.resolve(HttpServer)).start();

      const res = await req().get('metadata-mixed/args?first=a&second=b&third=3');
      expect(res.status, res.text).to.equal(200);
      expect(res.body).to.deep.equal({ first: 'a', second: 'b', third: 3 });
    });
  });
});
