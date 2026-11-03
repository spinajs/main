import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DI } from '@spinajs/di';
import { MANIFEST, MANIFEST_SETTINGS, registerManifest } from '@spinajs/configuration';
import { hashManifest, type Manifest } from '@spinajs/manifest';

import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';

import './../src/index.js';

const APP_BASIC = join(process.cwd(), '..', 'compiler', 'test', 'fixtures', 'app-basic', 'app.manifest.json');

let app: TestApp;

const health = () => app.request().get('/telemetry/health').set('Accept', 'application/json');

describe('GET /telemetry/health reports the manifest the app booted from', function () {
  this.timeout(15000);

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp();
  });

  it('reports mode off and a null hash for an app that booted without a manifest', async () => {
    const res = await health();

    expect(res).to.have.status(200);
    expect(res.body.manifest).to.deep.equal({ mode: 'off', hash: null });
  });

  describe('with the app-basic manifest', () => {
    let manifest: Manifest;

    // Registered after the boot, as ManifestConfigurationSource would have: before it, http would mount app-basic's controllers.
    before(() => {
      expect(DI.RootContainer.Registry.hasValue(MANIFEST.key), 'no manifest registered before').to.equal(false);
      manifest = JSON.parse(readFileSync(APP_BASIC, 'utf8')) as Manifest;
      registerManifest(DI.RootContainer, manifest);
      DI.RootContainer.register({ mode: 'prefer', path: APP_BASIC }).asValue(MANIFEST_SETTINGS.key, true);
    });

    after(() => {
      DI.RootContainer.Registry.removeValue(MANIFEST.key);
      DI.RootContainer.Registry.removeValue(MANIFEST_SETTINGS.key);
    });

    it('reports the hash hashManifest gives the fixture, and the mode', async () => {
      const res = await health();

      expect(res).to.have.status(200);
      expect(res.body.manifest).to.deep.equal({ mode: 'prefer', hash: hashManifest(manifest) });
    });

    it('keeps the fields it reported before', async () => {
      const res = await health();

      expect(res.body.status).to.eq('up');
      expect(res.body.pid).to.eq(process.pid);
      expect(res.body.node).to.eq(process.version);
      expect(res.body.version).to.eq('9.9.9');
    });
  });
});
