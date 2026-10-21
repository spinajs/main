import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import { AUTHZ_HTTP_CONFIGURATION_SCHEMA } from '@spinajs/authz-http';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { buildRoutePath, CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor } from '@spinajs/http';

import { AuthzAdminController } from '../src/controllers/AuthzAdminController.js';

const SUFFIXES = ['commands', 'assignments', 'holders', 'links', 'rules', 'policies', 'assignments/:id', 'links/:id', 'rules/:id', 'policies/:id', 'scopes/:type/:id/attributes'];

describe('authz.http.admin.basePath', function () {
  this.timeout(20000);
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(http: unknown) {
    const booted = await bootConfiguration({ authz: { http } }, [AUTHZ_HTTP_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  /** The distinct paths the controller mounts, as BaseController.resolve builds them. */
  async function mountedPaths(http: unknown, globalPrefix?: string): Promise<string[]> {
    const configuration = await boot(http);
    const controller = new AuthzAdminController();
    Object.defineProperty(controller, '_cfg', { value: configuration });
    const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller) as IControllerDescriptor;
    return [...new Set([...descriptor.Routes.values()].map((route) => buildRoutePath(controller.BasePath, route, globalPrefix)))].sort();
  }

  const under = (base: string) => SUFFIXES.map((s) => `${base}/${s}`).sort();

  it('keeps every admin route under /authz by default', async () => {
    expect(await mountedPaths(undefined)).to.deep.eq(under('/authz'));
  });

  it('moves commands, assignments, holders, links, rules, policies and attributes together', async () => {
    expect(await mountedPaths({ admin: { basePath: 'internal/authz' } })).to.deep.eq(under('/internal/authz'));
  });

  it('puts the global route prefix in front of the moved path', async () => {
    expect(await mountedPaths({ admin: { basePath: 'internal/authz' } }, 'api')).to.deep.eq(under('/api/internal/authz'));
  });

  it('adds no default to the effective authz.http.admin', async () => {
    expect((await boot(undefined)).get('authz.http.admin')).to.deep.eq({ domain: 'root' });
  });

  it('refuses an empty basePath at boot, naming its full path', async () => {
    expect(await violationPaths(boot({ admin: { basePath: '' } }))).to.include('authz.http.admin.basePath');
  });
});
