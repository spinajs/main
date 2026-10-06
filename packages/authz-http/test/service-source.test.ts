import 'mocha';
import { expect } from 'chai';
import type { Request } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';

import { AUTHZ_HTTP_CONFIGURATION_SCHEMA, ServicePrincipalSource } from '../src/index.js';

const request = (headers: Record<string, string | string[] | undefined>) => ({ headers, storage: {} }) as unknown as Request;

describe('ServicePrincipalSource', () => {
  const source = new ServicePrincipalSource();
  let installedHere = false;

  before(async () => {
    try {
      testHost.config();
    } catch {
      installedHere = true;
      await testHost.installHost();
    }
  });

  after(async () => {
    if (installedHere) await testHost.uninstallHost();
  });

  const configure = (services: unknown) => testHost.config().set(['authz', 'http', 'services'], services);

  beforeEach(() => configure([]));

  it('is the service source at order 40, before the authn principal (50)', () => {
    expect(source).to.include({ name: 'service', order: 40 });
  });

  it('yields service:<name> for a configured header holding the token', async () => {
    configure([{ name: 'telemetry', header: 'X-Telemetry-Token', token: 's3cret', attributes: { area: 'ops' } }]);

    const p = await source.authenticate(request({ 'x-telemetry-token': 's3cret' }));

    expect(p).to.deep.eq({ type: 'service', id: 'telemetry', authenticated: true, source: 'service', attributes: { area: 'ops' } });
    expect(Object.isFrozen(p)).to.eq(true);
  });

  it('accepts any token of a rotation list', async () => {
    configure([{ name: 'api-v2', header: 'X-Api-Token', token: ['old', 'new'] }]);

    expect(await source.authenticate(request({ 'x-api-token': 'old' }))).to.deep.include({ id: 'api-v2' });
    expect(await source.authenticate(request({ 'x-api-token': 'new' }))).to.deep.include({ id: 'api-v2' });
  });

  it('yields nothing for a wrong, empty, repeated or missing header, or a token prefix', async () => {
    configure([{ name: 'telemetry', header: 'X-Telemetry-Token', token: 's3cret' }]);

    for (const headers of [{ 'x-telemetry-token': 'wrong' }, { 'x-telemetry-token': '' }, { 'x-telemetry-token': ['s3cret', 's3cret'] }, {}, { 'x-telemetry-token': 's3cre' }, { 'x-telemetry-token': 's3cret ' }]) {
      expect(await source.authenticate(request(headers))).to.eq(null, JSON.stringify(headers));
    }
  });

  it('picks the service whose header matched when several are configured', async () => {
    configure([
      { name: 'legacy-v1', header: 'X-Token', token: 'one' },
      { name: 'api-v2', header: 'X-Api-Token', token: 'two' },
    ]);

    expect(await source.authenticate(request({ 'x-token': 'two', 'x-api-token': 'two' }))).to.deep.include({ id: 'api-v2' });
  });

  it('yields nothing while no service is configured', async () => {
    expect(await source.authenticate(request({ 'x-telemetry-token': 's3cret' }))).to.eq(null);
  });


  it('has a configuration schema for authz.http', () => {
    expect(AUTHZ_HTTP_CONFIGURATION_SCHEMA.$configurationModule).to.eq('authz.http');
  });
});
