import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { resolve } from 'node:path';
import { ClassInfo, DI } from '@spinajs/di';
import { Configuration, MANIFEST, MANIFEST_SETTINGS, registerManifest, registerManifestSettings } from '@spinajs/configuration';
import { analyzePackage } from '@spinajs/compiler';
import { BaseController, Controllers } from '@spinajs/http';
import { DefaultControllerCache } from '@spinajs/http/cache';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { testManifest } from '@spinajs/testing';
import type { Manifest } from '@spinajs/manifest';
import { OpenApiBuilder } from '../src/openapi-builder.js';
import { SwaggerDocCache } from '../src/swagger-cache.js';
import { SwaggerCacheCommand } from '../src/cli/GenerateSwaggerCache.js';
import type { IOpenApiDocument, ISwaggerCacheEntry, ISwaggerConfig } from '../src/interfaces.js';
import { TestConfiguration } from './common.js';
import '../src/index.js';

type Docs = Map<ClassInfo<BaseController>, ISwaggerCacheEntry>;

interface StrippedOperation {
  operationId?: string;
  summary?: string;
  parameters: string[];
}

/**
 * The same controllers documented twice: by the TypeScript cache, and from the manifest the compiler builds for them.
 * Operations, summaries and parameters must agree. Class-level JSDoc ( `@tags`, the class description ) is not in the
 * manifest, so operation tags are compared at the method level only.
 */
describe('swagger: cache vs manifest documentation', function () {
  this.timeout(120000);

  let manifest: Manifest;
  let controllers: Array<ClassInfo<BaseController>>;

  async function docsOf(): Promise<Docs> {
    const cache = await DI.resolve(SwaggerDocCache);
    const docs: Docs = new Map();
    for (const controller of controllers) {
      docs.set(controller, await cache.getCache(controller));
    }
    return docs;
  }

  async function build(docs: Docs): Promise<Record<string, Record<string, StrippedOperation>>> {
    const builder = await DI.resolve(OpenApiBuilder, [DI.get(Configuration)!.get<ISwaggerConfig>('http.swagger')]);
    for (const [controller, doc] of docs) {
      builder.addController(controller, doc);
    }
    const spec: IOpenApiDocument = builder.build();

    const out: Record<string, Record<string, StrippedOperation>> = {};
    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      out[path] = Object.fromEntries(
        Object.entries(operations as Record<string, { operationId?: string; summary?: string; parameters?: Array<{ in: string; name: string; required?: boolean }> }>).map(([method, op]) => [
          method,
          { operationId: op.operationId, summary: op.summary, parameters: (op.parameters ?? []).map((p) => `${p.in}:${p.name}:${p.required ? 'req' : 'opt'}`) },
        ]),
      );
    }
    return out;
  }

  const methodTags = (docs: Docs) => Object.fromEntries([...docs].map(([c, d]) => [c.name, Object.fromEntries(Object.entries(d.methods).map(([m, doc]) => [m, doc.tags ?? null]))]));

  before(async () => {
    const fragment = await analyzePackage({ tsconfig: resolve(process.cwd(), 'tsconfig.json'), packageRoot: process.cwd(), schemaDerivation: false });
    manifest = testManifest({ root: process.cwd(), controllers: fragment.controllers });

    DI.clearCache();
    DI.register(TestConfiguration).as(Configuration);
    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    controllers = await (await DI.resolve(Controllers)).Controllers;
  });

  function decideManifest(): void {
    registerManifestSettings(DI.RootContainer, { mode: 'prefer', path: 'app.manifest.json' });
    registerManifest(DI.RootContainer, manifest);
  }

  afterEach(() => {
    sinon.restore();
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  after(() => DI.clearCache());

  it('documents the same operations, summaries, parameters and method tags from both providers', async () => {
    const fromCache = await docsOf();

    decideManifest();
    const getDocumentation = sinon.spy(DefaultControllerCache.prototype, 'getDocumentation');
    const fromManifest = await docsOf();

    expect(getDocumentation.called, 'the TypeScript cache was asked').to.equal(false);
    expect(controllers.length).to.be.greaterThan(5);
    expect(methodTags(fromManifest)).to.deep.equal(methodTags(fromCache));
    expect(await build(fromManifest)).to.deep.equal(await build(fromCache));
  });

  it('http:swagger:cache does nothing when the manifest carries the documentation', async () => {
    decideManifest();
    const getCache = sinon.spy(SwaggerDocCache.prototype, 'getCache');
    const command = await DI.resolve(SwaggerCacheCommand);
    const warn = sinon.spy((command as unknown as { Log: { warn: (message: string) => void } }).Log, 'warn');

    await command.execute();

    expect(getCache.called).to.equal(false);
    expect(warn.calledWithMatch(sinon.match(/no-op/))).to.equal(true);
  });
});
