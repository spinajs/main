import 'mocha';
import { expect } from 'chai';
import { buildRoutePath, CONTROLLED_DESCRIPTOR_SYMBOL, HTTP_CONFIGURATION_SCHEMA } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';
import { AUTHN_CONFIGURATION_SCHEMA } from '@spinajs/authn/schemas';
import { AUTHN_SESSION_CONFIGURATION_SCHEMA } from '@spinajs/authn-session';

import { AUTHN_HTTP_CONFIGURATION_SCHEMA } from '../../src/index.js';
import { AuthnCredentialAdminController } from '../../src/v3/controllers/AuthnCredentialAdminController.js';
import { configurationViolations, createTestApp, disposeTestApps } from '@spinajs/testing';

const SCHEMAS = [AUTHN_CONFIGURATION_SCHEMA, AUTHN_HTTP_CONFIGURATION_SCHEMA, AUTHN_SESSION_CONFIGURATION_SCHEMA, HTTP_CONFIGURATION_SCHEMA];

const SUFFIXES = [':uuid/password-reset', ':uuid/mfa-reset', ':uuid/sessions', ':uuid/tokens'];

/** The paths the controller mounts under the given configuration, as BaseController.resolve builds them. */
async function mountedPaths(values: Record<string, unknown>): Promise<string[]> {
  const { config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: values });
  const controller = new AuthnCredentialAdminController();
  Object.defineProperty(controller, '_cfg', { value: configuration });
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller) as IControllerDescriptor;
  const prefix = configuration.get<string | undefined>('http.controllers.route.prefix');
  return [...descriptor.Routes.values()].map((route) => buildRoutePath(controller.BasePath, route, prefix)).sort();
}

const under = (base: string) => SUFFIXES.map((s) => `${base}/${s}`).sort();

describe('authn.http.admin.basePath', function () {
  this.timeout(20000);
  afterEach(disposeTestApps);

  it('keeps the credential admin routes under /authn/admin/users by default', async () => {
    expect(await mountedPaths({})).to.deep.eq(under('/authn/admin/users'));
  });

  it('moves every credential admin route together', async () => {
    expect(await mountedPaths({ authn: { http: { admin: { basePath: 'internal/authn/users' } } } })).to.deep.eq(under('/internal/authn/users'));
  });

  it('puts the global route prefix in front of the moved path', async () => {
    const values = { http: { controllers: { route: { prefix: 'api' } } }, authn: { http: { admin: { basePath: 'internal/authn/users' } } } };
    expect(await mountedPaths(values)).to.deep.eq(under('/api/internal/authn/users'));
  });

  it('leaves the effective authn.http.admin unset when the app names nothing', async () => {
    const { config: configuration } = await createTestApp({ scope: 'child', bootstrap: false, schemas: SCHEMAS, config: {} });
    expect(configuration.get('authn.http.admin')).to.eq(undefined);
  });

  it('refuses an empty basePath at boot, naming its full path', async () => {
    expect(await configurationViolations({ schemas: SCHEMAS, config: { authn: { http: { admin: { basePath: '' } } } } })).to.include('authn.http.admin.basePath');
  });
});
