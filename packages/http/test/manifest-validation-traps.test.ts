import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { analyzePackage } from '@spinajs/compiler';
import { hashManifest, type Manifest } from '@spinajs/manifest';
import { testManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { dir, httpApp, req } from './common.js';
import * as httpExports from '../src/index.js';
import { BaseController, ControllerSource, Controllers, FilesystemControllerSource, HttpServer } from '../src/index.js';
import { ManifestValidationController } from './manifest-validation/src/controllers.js';

const FIXTURE = dir('manifest-validation');
const ManifestControllerSource = (httpExports as Record<string, unknown>).ManifestControllerSource as typeof FilesystemControllerSource | undefined;
const MANIFEST_DIR = mkdtempSync(join(tmpdir(), 'manifest-validation-traps-'));

type Json = Record<string, unknown>;

/** The fixture's manifest, with bounds on the search page and comparison keywords on the created item. */
async function trapManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: join(FIXTURE, 'tsconfig.json'), packageRoot: FIXTURE });
  const manifest = testManifest({ app: { name: fragment.package.name, version: fragment.package.version, root: FIXTURE, outDir: 'src' }, controllers: fragment.controllers, schemas: fragment.schemas });
  const schemaOf = (name: string) => manifest.schemas[Object.keys(manifest.schemas).find((id) => id.endsWith(`/${name}`))!] as Json;
  const create = schemaOf('CreateItem').properties as Json;
  create.tags = { type: 'array', uniqueItems: true };
  create.meta = { const: { a: 1 } };
  // The published body of an explicit `@Schema` class nested in the derived CreateItem, with keywords only plugins know.
  const explicitId = 'spinajs/manifest-validation-fixture/Explicit';
  manifest.schemas[explicitId] = {
    $id: explicitId,
    type: 'object',
    properties: {
      min: { type: 'integer' },
      max: { type: 'integer', minimum: { $data: '1/min' } },
      level: { type: 'number', range: [1, 3] },
      code: { type: 'string', regexp: '/^a+$/' },
    },
    prohibited: ['admin'],
  };
  const mergedId = `${explicitId}Merged`;
  manifest.schemas[mergedId] = { $id: mergedId, $merge: { source: { type: 'object', properties: { a: { type: 'string' } } }, with: { required: ['a'] } } };
  create.explicit = { $ref: explicitId };
  create.merged = { $ref: mergedId };
  const search = schemaOf('SearchQuery').properties as Json;
  search.page = { ...(search.page as Json), minimum: 1, maximum: 100 };
  return manifest;
}

describe('request validation from the manifest: non-finite numbers and comparison traps', function () {
  this.timeout(60000);

  let app: TestApp;

  before(async () => {
    const manifest = await trapManifest();
    const file = join(MANIFEST_DIR, 'require.json');
    writeFileSync(file, JSON.stringify({ ...manifest, hash: hashManifest(manifest) }));
    const saved = { SPINAJS_MANIFEST: process.env.SPINAJS_MANIFEST, SPINAJS_MANIFEST_MODE: process.env.SPINAJS_MANIFEST_MODE };
    process.env.SPINAJS_MANIFEST = file;
    process.env.SPINAJS_MANIFEST_MODE = 'require';
    try {
      app = await httpApp({
        register: (c) => {
          c.unregister(ControllerSource, FilesystemControllerSource);
          if (ManifestControllerSource) c.unregister(ControllerSource, ManifestControllerSource);
          c.register(ManifestValidationController).as(BaseController);
        },
        resolve: [Intl, Controllers],
      });
      await (await app.resolve(HttpServer)).start();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  after(async () => {
    await app?.dispose();
    rmSync(MANIFEST_DIR, { recursive: true, force: true });
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  const post = (body: object) => req().post('manifest-validation/create').set('Accept', 'application/json').send(body);
  const get = (query: string) => req().get(`manifest-validation/search?${query}`).set('Accept', 'application/json');
  const fields = (res: { body: { errors?: { instancePath: string; keyword: string }[] } }) => (res.body.errors ?? []).map((e) => [e.instancePath, e.keyword]);

  for (const page of ['-Infinity', 'Infinity', '1e400']) {
    it(`search?page=${page} answers 400 at /page`, async () => {
      const res = await get(`page=${page}`);
      expect(res.status, res.text).to.eq(400);
      expect(fields(res)).to.deep.eq([['/page', 'type']]);
    });
  }

  it('search?page=2 still answers 200 with a coerced page', async () => {
    const res = await get('page=2');
    expect(res.status, res.text).to.eq(200);
    expect((res.body as { page?: unknown }).page).to.eq(2);
  });

  for (const [name, extra, field, keyword] of [
    ['uniqueItems over objects with an own valueOf', { tags: [{ valueOf: 1 }, { valueOf: 1 }] }, '/tags', 'uniqueItems'],
    ['an object const with an own toString', { meta: { toString: false } }, '/meta', 'const'],
    ['an object const with an own valueOf', { meta: { valueOf: 1 } }, '/meta', 'const'],
  ] as const) {
    it(`create answers 400, not 500, for ${name}`, async () => {
      const res = await post({ name: 'a', count: 1, ...extra });
      expect(res.status, res.text).to.eq(400);
      expect(fields(res)).to.deep.eq([[field, keyword]]);
    });
  }

  for (const [rule, extra, field] of [
    ['prohibited', { explicit: { admin: true } }, '/explicit'],
    ['regexp', { explicit: { code: 'b' } }, '/explicit/code'],
    ['range', { explicit: { level: 5 } }, '/explicit/level'],
    ['a $data limit', { explicit: { min: 5, max: 4 } }, '/explicit/max'],
    ['$merge', { merged: {} }, '/merged'],
  ] as const) {
    it(`enforces ${rule} of an explicit schema nested in the derived body`, async () => {
      const res = await post({ name: 'a', count: 1, ...extra });
      expect(res.status, res.text).to.eq(400);
      expect(fields(res).map(([path]) => path)).to.include(field);
    });
  }

  it('accepts the nested explicit schema when its rules hold', async () => {
    const res = await post({ name: 'a', count: 1, explicit: { min: 1, max: 4, level: 2, code: 'aa' }, merged: { a: 'x' } });
    expect(res.status, res.text).to.eq(200);
  });

  it('create accepts distinct items and an equal const', async () => {
    const res = await post({ name: 'a', count: 1, tags: [{ a: 1 }, { valueOf: 1 }], meta: { a: 1 } });
    expect(res.status, res.text).to.eq(200);
  });
});
