import 'mocha';
import { expect } from 'chai';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { AccessPolicy, PrincipalMiddleware } from '@spinajs/authz-http';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, Controllers, HttpServer, ServerMiddleware } from '@spinajs/http';
import { Intl } from '@spinajs/intl';
import type { Manifest } from '@spinajs/manifest';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { HealthController } from '../../compiler/test/fixtures/app-basic/src/controllers/HealthController.js';
import { UsersController } from '../../compiler/test/fixtures/app-basic/src/controllers/users.js';
import { createClient, ProblemError } from '../src/runtime/index.js';
import type { ClientDefinition } from '../src/runtime/index.js';
import { generateClient } from '../src/index.js';
import type { AppClient } from './__snapshots__/app-basic.client.js';
import { appBasicManifest } from './support/fixture.js';
import { AllowAccess, E2eConfiguration } from './support/harness.js';

function extractDefinition(generated: string): ClientDefinition {
  const match = /const definition: ClientDefinition = (\{[\s\S]*?\n\});/.exec(generated);
  if (!match) throw new Error('definition not found in generated source');
  return runInNewContext(`(${match[1]})`) as ClientDefinition;
}

async function boot(manifest: Manifest, contractManifest: Manifest = manifest): Promise<{ app: TestApp; client: AppClient; baseUrl: string }> {
  const app = await createTestApp({
    configuration: E2eConfiguration,
    register: (c) => {
      c.unregister(ServerMiddleware, PrincipalMiddleware);
      for (const controller of [HealthController, UsersController]) c.register(controller).as(BaseController);
      c.register(AllowAccess).as(AccessPolicy);
    },
    resolve: [fsService, Intl, Controllers],
    contractTesting: { manifest: contractManifest },
    bootTimeout: 50000,
  });
  await (await app.resolve(HttpServer)).start();
  const { port } = DI.get(HttpServer)!.Server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { app, baseUrl, client: createClient<AppClient>(extractDefinition(await generateClient({ manifest })), { baseUrl }) };
}

describe('contract tests against the app-basic manifest', function () {
  this.timeout(60000);

  describe('responses that match', () => {
    let app: TestApp;
    let client: AppClient;

    before(async () => {
      ({ app, client } = await boot(await appBasicManifest()));
    });

    after(async () => {
      await app.dispose();
    });

    // The fixture keeps its users in module state shared with the other e2e suite, so nothing here creates one.
    it('every derived response schema accepts what the handlers return', async () => {
      expect(await client.health.get()).to.deep.equal({ ok: true });
      expect(await client.users.list({})).to.have.length(1);
      expect(await client.users.get(1)).to.deep.include({ id: 1 });
      expect(await client.users.create({ email: 'nope' })).to.deep.equal({ kind: 'validation', errors: ['email'] });
    });

    it('a problem+json error matches the problem details schema', async () => {
      const error = await client.users.get(404).catch((e: unknown) => e);
      expect(error).to.be.instanceOf(ProblemError);
      expect(app.contractViolations).to.have.length(0);
    });
  });

  describe('a manifest that disagrees with the handlers', () => {
    it('answers 500 for the route and fails dispose', async () => {
      const manifest = await appBasicManifest();
      const stricter = structuredClone(manifest);
      const user = stricter.schemas['spinajs/app-basic/UserDto'] as { required: string[] };
      user.required.push('phone');

      const { app, client, baseUrl } = await boot(manifest, stricter);
      const error = await client.users.get(1).catch((e: unknown) => e);
      expect(error).to.be.instanceOf(ProblemError);
      expect((error as ProblemError).status).to.equal(500);
      expect((await fetch(`${baseUrl}/health/get`)).status).to.equal(200);

      expect(app.contractViolations).to.have.length(1);
      expect(app.contractViolations[0]).to.deep.include({ controller: 'UsersController', handler: 'get', kind: 'response', status: 200 });
      const disposed = await app.dispose().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(disposed?.message).to.match(/broke their contract[\s\S]*UsersController\.get/);
    });
  });
});
