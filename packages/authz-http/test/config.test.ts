import 'mocha';
import { expect } from 'chai';
import type { IContainer } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import { bindConfiguration, bootConfiguration, violationPaths } from '@spinajs/authz-testing';

import { AUTHZ_HTTP_CONFIGURATION_SCHEMA, LinkPrincipalSource, ServicePrincipalSource } from '../src/index.js';

const request = (headers: Record<string, string>, query: Record<string, string> = {}) => ({ headers, query, storage: {} }) as unknown as Request;

describe('authz.http through @Config and its schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(http: unknown) {
    const booted = await bootConfiguration({ authz: { http } }, [AUTHZ_HTTP_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted;
  }

  const refused = (http: unknown) => violationPaths(boot(http));

  it('fills every default of an unset authz.http', async () => {
    const { configuration } = await boot(undefined);

    expect(configuration.get('authz.http')).to.deep.equal({
      services: [],
      explainRoute: { enabled: false, permission: 'authz:explain' },
      links: { query: 'link', header: 'X-Authz-Link', cookie: null },
      access: { domain: 'root' },
      admin: { domain: 'root' },
    });
  });

  it('keeps a configured value next to the defaults of its block', async () => {
    const { configuration } = await boot({ links: { cookie: 'share' }, access: { domain: 'fs' } });

    expect(configuration.get('authz.http.links')).to.deep.equal({ query: 'link', header: 'X-Authz-Link', cookie: 'share' });
    expect(configuration.get('authz.http.access.domain')).to.equal('fs');
  });

  it('refuses a malformed value at boot, naming its full path', async () => {
    expect(await refused({ admin: { domain: '' } })).to.include('authz.http.admin.domain');
    expect(await refused({ links: { query: '' } })).to.include('authz.http.links.query');
    expect(await refused({ services: [{ header: 'X', token: 't' }] })).to.include('authz.http.services.0.name');
    expect(await refused({ services: [{ name: 'a', token: 't' }] })).to.include('authz.http.services.0.header');
    expect(await refused({ services: [{ name: 'a', header: 'X', token: '' }] })).to.include('authz.http.services.0.token');
    expect(await refused({ services: [{ name: 'a', header: 'X', token: [] }] })).to.include('authz.http.services.0.token');
    expect(await refused({ services: [{ name: 'a', header: 'X', token: 't', attributes: 1 }] })).to.include('authz.http.services.0.attributes');
    expect(await refused({ services: 'x' })).to.include('authz.http.services');
    expect(await refused({ explainRoute: { enabled: 'yes' } })).to.include('authz.http.explainRoute.enabled');
    expect(await refused({ explainRoute: { permission: '' } })).to.include('authz.http.explainRoute.permission');
    expect(await refused({ access: { domain: '' } })).to.include('authz.http.access.domain');
  });

  it('ServicePrincipalSource reads the services of the Configuration its container resolves', async () => {
    const { child } = await boot({ services: [{ name: 'telemetry', header: 'X-Telemetry-Token', token: 's3cret' }] });
    const source = bindConfiguration(new ServicePrincipalSource(), child);

    expect(await source.authenticate(request({ 'x-telemetry-token': 's3cret' }))).to.deep.include({ type: 'service', id: 'telemetry' });
  });

  it('LinkPrincipalSource reads the link names of the Configuration its container resolves', async () => {
    const { child } = await boot({ links: { query: 'share' } });
    const source = bindConfiguration(new LinkPrincipalSource(), child) as unknown as { token(req: Request): string | undefined };

    expect(source.token(request({}, { share: 't1', link: 't2' }))).to.equal('t1');
  });
});
