import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';

import type { StudioCapabilities } from '../src/contracts/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

// Named like @spinajs/telemetry's store: capabilities look it up by registration name, never by import.
class TelemetryStore {}

describe('GET /_studio/api/capabilities', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;

  const capabilities = async (): Promise<StudioCapabilities> => {
    const res = await app.request().get('/_studio/api/capabilities').set('Accept', 'application/json').set('x-user', 'bob');
    expect(res.status).to.eq(200);
    return res.body as StudioCapabilities;
  };

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp();
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('reports the version, no manifest and the Studio permissions the caller holds', async () => {
    const body = await capabilities();
    expect(body.version).to.match(/^\d+\.\d+\.\d+/);
    expect(body.manifest.loaded).to.eq(false);
    expect(body.permissions.sort()).to.deep.eq(['studio:explain', 'studio:read']);
  });

  it('detects optional packages by DI registration', async () => {
    expect((await capabilities()).features).to.include({ authz: true, telemetry: false, scheduler: false });

    DI.register(TelemetryStore).asSelf();
    try {
      expect((await capabilities()).features.telemetry).to.eq(true);
    } finally {
      DI.unregister(TelemetryStore);
    }
  });
});
