import 'mocha';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'chai';
import { AUTHZ_HTTP_CONFIGURATION_SCHEMA } from '@spinajs/authz-http';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import config from '../src/config/authz-http-admin.js';
import { AuthzAdminController } from '../src/index.js';

describe('shipped configuration', () => {
  const dirs = config.system.dirs.controllers.map((d) => d.replace(/\\/g, '/'));

  it('serves the controllers dir and no longer the 2.x legacy one', () => {
    expect(dirs).to.have.length(1);
    expect(dirs[0]).to.match(/\/authz-http-admin\/lib\/(mjs|cjs)\/controllers$/);
    expect(dirs.filter((d) => d.includes('legacy'))).to.deep.equal([]);
  });

  // http loads every file of a controllers dir; a barrel there would hand it the controller twice.
  it('keeps only controller files in the controllers dir', () => {
    expect(readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controllers'))).to.deep.equal(['AuthzAdminController.ts']);
  });

  it('runs the admin routes on the root domain by default', () => {
    expect(config.authz.http.admin.domain).to.equal('root');
  });

  it('ships no 2.x rbac.* keys', () => {
    expect(config).to.not.have.property('rbac');
  });
});

describe('authz.http.admin.domain through @Config', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(admin: unknown) {
    const booted = await bootConfiguration({ authz: { http: { admin } } }, [AUTHZ_HTTP_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.child;
  }

  const domainOf = (child: IContainer) => (bindConfiguration(new AuthzAdminController(), child) as unknown as { AdminDomain: string }).AdminDomain;

  it('the admin routes read it from the Configuration of the controller container', async () => {
    expect(domainOf(await boot({ domain: 'tenant' }))).to.equal('tenant');
  });

  it('is root when the app names none', async () => {
    expect(domainOf(await boot(undefined))).to.equal('root');
  });

  it('refuses an empty domain name at boot', async () => {
    expect(await violationPaths(boot({ domain: '' }))).to.include('authz.http.admin.domain');
  });
});
