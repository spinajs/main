import 'mocha';
import { expect } from 'chai';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS } from '@spinajs/configuration';
import { Intl } from '@spinajs/intl';
import { analyzePackage } from '@spinajs/compiler';
import { hashManifest, type Manifest, type ManifestMode } from '@spinajs/manifest';
import { testManifest } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { dir, httpApp, req } from './common.js';
import { BaseController, ControllerSource, Controllers, FilesystemControllerSource, HttpServer } from '../src/index.js';
import { ManifestValidationController } from './manifest-validation/src/controllers.js';

const FIXTURE = dir('manifest-validation');
const MANIFEST_DIR = mkdtempSync(join(tmpdir(), 'manifest-validation-'));

async function fixtureManifest(): Promise<Manifest> {
  const fragment = await analyzePackage({ tsconfig: join(FIXTURE, 'tsconfig.json'), packageRoot: FIXTURE });
  return testManifest({ app: { name: fragment.package.name, version: fragment.package.version, root: FIXTURE, outDir: 'src' }, controllers: fragment.controllers, schemas: fragment.schemas });
}

/** The app's configuration source decides the switch from the environment, as in production. */
async function boot(manifest?: Manifest, mode: ManifestMode = 'prefer'): Promise<TestApp> {
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
        // Discovery is not under test: the manifest lists src/controllers.ts, which reflection would import as a .js file.
        c.unregister(ControllerSource, FilesystemControllerSource);
        c.register(ManifestValidationController).as(BaseController);
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

const post = (handler: string, body: object) => req().post(`manifest-validation/${handler}`).send(body);
const get = (path: string) => req().get(`manifest-validation/${path}`);

describe('request validation from the manifest', function () {
  this.timeout(60000);

  let manifest: Manifest;

  before(async () => {
    manifest = await fixtureManifest();
  });

  after(() => {
    rmSync(MANIFEST_DIR, { recursive: true, force: true });
    // A later app built without the configuration source would read this suite's decision from root.
    DI.uncache(MANIFEST.key);
    DI.uncache(MANIFEST_SETTINGS.key);
  });

  describe('prefer mode', () => {
    let app: TestApp;

    before(async () => {
      app = await boot(manifest);
    });

    after(async () => {
      await app.dispose();
    });

    it('accepts a body DTO without @Schema that matches its derived schema', async () => {
      const res = await post('create', { name: 'a', count: 1, tags: ['x'] });
      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.equal({ name: 'a', count: 1 });
    });

    it('answers 400 problem+json for a wrong type and never echoes the input', async () => {
      const res = await post('create', { name: 'a', count: 'hunter2-secret' });
      expect(res.status).to.eq(400);
      expect(res.type).to.eq('application/problem+json');
      expect((res.body as { errors: Array<{ instancePath: string }> }).errors.map((e) => e.instancePath)).to.deep.equal(['/count']);
      expect(res.text).to.not.include('hunter2-secret');
    });

    it('does not coerce a JSON body and rejects undeclared properties', async () => {
      expect((await post('create', { name: 'a', count: '2' })).status).to.eq(400);
      expect((await post('create', { name: 'a', count: 2, admin: true })).status).to.eq(400);
    });

    it('validates an intersection of closed objects as one object', async () => {
      expect((await post('both', { name: 'a', count: 1 })).status).to.eq(200);
      expect((await post('both', { name: 'a' })).status).to.eq(400);
    });

    it('does not reject what a partial explicit schema of a nested class lets through', async () => {
      const res = await post('envelope', { item: { name: 'a', extra: true } });
      expect(res.status, res.text).to.eq(200);
    });

    it('lets the runtime Standard Schema decide over the derived class shape', async () => {
      expect((await post('standard', { name: 'a' })).status).to.eq(200);
      expect((await post('standard', { name: 1 })).status).to.eq(400);
    });

    it('coerces a whole query DTO to its derived types and ignores keys of other arguments', async () => {
      const res = await get('search?page=2&exact=true&debug=1');
      expect(res.status, res.text).to.eq(200);
      expect(res.body).to.deep.equal({ page: 2, pageType: 'number', exact: true });
      expect((await get('search?page=two')).status).to.eq(400);
    });

    it('checks a scalar query value against its derived literal union', async () => {
      expect((await get('sorted?sort=asc&limit=5')).body).to.deep.equal({ sort: 'asc', limit: 5 });
      expect((await get('sorted?sort=up')).status).to.eq(400);
    });
  });

  describe('explicit @Schema precedence', () => {
    let app: TestApp;

    before(async () => {
      // A manifest that disagrees with the runtime @Schema: the runtime one must win.
      const stricter = structuredClone(manifest);
      (stricter.schemas['manifest-validation.loose-item'] as { required: string[] }).required = ['name', 'count', 'phone'];
      app = await boot(stricter);
    });

    after(async () => {
      await app.dispose();
    });

    it('validates with the runtime @Schema, not the manifest schema', async () => {
      expect((await post('loose', { name: 'a' })).status).to.eq(200);
      expect((await post('loose', {})).status).to.eq(400);
    });
  });

  describe('a derived schema that cannot compile', () => {
    const broken = () => {
      const copy = structuredClone(manifest);
      (copy.schemas['spinajs/manifest-validation-fixture/CreateItem'] as { properties: Record<string, unknown> }).properties.name = { $ref: 'spinajs/elsewhere/Missing' };
      return copy;
    };

    it('fails the boot in require mode', async () => {
      const error = await boot(broken(), 'require').then(
        async (app) => {
          await app.dispose();
          return undefined;
        },
        (e: unknown) => e as Error,
      );
      expect(error?.message).to.match(/item of ManifestValidationController::create cannot be validated: schema .*CreateItem has an unresolved \$ref spinajs\/elsewhere\/Missing/);
    });

    it('does not compile it for an argument whose class has an explicit @Schema', async () => {
      const copy = structuredClone(manifest);
      (copy.schemas['manifest-validation.loose-item'] as { properties: Record<string, unknown> }).properties.name = { $ref: 'spinajs/elsewhere/Missing' };
      const app = await boot(copy, 'require');
      try {
        expect((await post('loose', { name: 'a' })).status).to.eq(200);
      } finally {
        await app.dispose();
      }
    });

    it('leaves that argument unchecked in prefer mode', async () => {
      const app = await boot(broken());
      try {
        expect((await post('create', { name: 'a', count: 'x' })).status).to.eq(200);
        expect((await post('both', { name: 'a' })).status).to.eq(400);
      } finally {
        await app.dispose();
      }
    });
  });

  for (const [label, mode] of [
    ['off mode', 'off'],
    ['no manifest', undefined],
  ] as const) {
    describe(label, () => {
      let app: TestApp;

      before(async () => {
        app = await boot(mode ? manifest : undefined, mode);
      });

      after(async () => {
        await app.dispose();
      });

      it('passes a body without @Schema through unvalidated, as before', async () => {
        expect((await post('create', { name: 'a', count: 'x' })).status).to.eq(200);
        expect((await get('search?page=two')).status).to.eq(200);
      });
    });
  }
});
