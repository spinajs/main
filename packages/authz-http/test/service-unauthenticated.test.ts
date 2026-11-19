import 'mocha';
import { expect } from 'chai';
import type { Request } from '@spinajs/http';
import { testHost } from '@spinajs/authz-testing';

import { HasPrincipal, IsAuthenticated, ServicePrincipalSource } from '../src/index.js';

const request = (headers: Record<string, string>) => ({ headers, storage: {} }) as unknown as Request;

describe('a service entry with authenticated: false', () => {
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
    testHost.config().set(['authz', 'http', 'services'], []);
    if (installedHere) await testHost.uninstallHost();
  });

  const principalFor = async (entry: Record<string, unknown>) => {
    testHost.config().set(['authz', 'http', 'services'], [{ name: 'scraper', header: 'X-Scrape', token: 's3cret', ...entry }]);
    return source.authenticate(request({ 'x-scrape': 's3cret' }));
  };

  const withPrincipal = async (entry: Record<string, unknown>) => {
    const req = request({});
    req.storage.Principal = (await principalFor(entry)) ?? undefined;
    return req;
  };

  it('yields an unauthenticated service:<name>', async () => {
    expect(await principalFor({ authenticated: false })).to.deep.eq({ type: 'service', id: 'scraper', authenticated: false, source: 'service', attributes: {} });
  });

  it('yields an authenticated one when the key is unset or true', async () => {
    expect(await principalFor({})).to.deep.include({ authenticated: true });
    expect(await principalFor({ authenticated: true })).to.deep.include({ authenticated: true });
  });

  it('fails IsAuthenticated with 401 and passes HasPrincipal', async () => {
    const req = await withPrincipal({ authenticated: false });
    const refusal = await new IsAuthenticated().execute(req).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).to.include({ error: 'unauthenticated', message: 'this route needs an authenticated principal' });
    await new HasPrincipal().execute(req);
  });

  it('passes IsAuthenticated by default', async () => {
    await new IsAuthenticated().execute(await withPrincipal({}));
  });
});
