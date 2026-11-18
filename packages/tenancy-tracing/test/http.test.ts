import 'mocha';
import { expect } from 'chai';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { SpanKind } from '@opentelemetry/api';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok } from '@spinajs/http';
import { MemoryTenantRegistry, currentTenant, tenantRegistry } from '@spinajs/tenancy';
import '@spinajs/tenancy-http';
import { SpinaAttr } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import '../src/index.js';

@BasePath('t')
class TenantRoutes extends BaseController {
  @Get(':tenant/who')
  public who() {
    return new Ok({ tenant: currentTenant()?.id ?? null });
  }
}

class TracedTenancyConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    const provider = (name: string) => ({ service: 'fsNative', name, basePath: tmpdir() });
    this.Config = {
      system: { dirs: { controllers: [] } },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [provider('fs-temp'), provider('__file_upload_default_provider__'), provider('__fs_http_templates__'), provider('__fs_controller_cache__'), provider('__fs_http_response_templates__')],
      },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
      http: { port: 0, middlewares: [], AcceptHeaders: 1 | 2, routes: { middlewares: ['TenantMiddleware'] } },
      tenancy: { registry: 'MemoryTenantRegistry', http: { baseDomains: ['127.0.0.1'] } },
    };
  }
}

// node:http without keep-alive: an open fetch (undici) socket at --exit trips a libuv assertion on Windows.
const getJson = (url: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    get(url, { agent: false, headers: { accept: 'application/json' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });

// The server span ends on the response's finish event, which may come after the client has read the body.
async function serverSpan(spans: InMemorySpans): Promise<ReturnType<InMemorySpans['spans']>[number]> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const found = spans.spans().find((s) => s.kind === SpanKind.SERVER);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no SERVER span ended within 2 s');
}

describe('the spans of an http request in a tenant', function () {
  this.timeout(60000);

  let app: TestApp;
  let spans: InMemorySpans;
  let port = 0;

  before(async () => {
    await resetTracing();
    app = await createTestApp({
      configuration: TracedTenancyConfiguration,
      register: (c) => c.register(TenantRoutes).as(BaseController),
      resolve: [fsService, Controllers],
      bootTimeout: 50000,
    });
    const registry = (await tenantRegistry()).inner;
    if (!(registry instanceof MemoryTenantRegistry)) throw new Error('expected the memory registry');
    registry.add({ id: 'acme', slug: 'acme-inc' });
    const http = await app.resolve(HttpServer);
    await http.start();
    port = (http.Server.address() as AddressInfo).port;
    spans = useInMemorySpans();
  });

  after(async () => {
    await spans.detach();
    await DI.get(HttpServer)?.stop();
    await app.dispose();
    await resetTracing();
  });

  it('tags the server span, which TenantMiddleware applies the scope under, and the route span', async () => {
    expect(await getJson(`http://127.0.0.1:${port}/t/acme-inc/who`)).to.deep.eq({ tenant: 'acme' });

    expect((await serverSpan(spans)).attributes[SpinaAttr.Tenant]).to.eq('acme');
    expect((await spans.waitFor('route TenantRoutes.who')).attributes[SpinaAttr.Tenant]).to.eq('acme');
  });
});
