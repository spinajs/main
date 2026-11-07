import 'mocha';
import * as http from 'node:http';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';

import { appPort, httpApp } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, NoCompression, Ok } from '../src/index.js';

// Above compression's 1 KiB threshold, so a compressed answer would show.
const BIG = { items: Array.from({ length: 200 }, (_, i) => `item-${i}`) };

@BasePath('no-compression')
class NoCompressionController extends BaseController {
  @Get()
  public compressed() {
    return new Ok(BIG);
  }

  @Get()
  @NoCompression()
  public plain() {
    return new Ok(BIG);
  }
}

@BasePath('no-compression-controller')
@NoCompression()
class NoCompressionWholeController extends BaseController {
  @Get()
  public any() {
    return new Ok(BIG);
  }
}

/** A GET without decompression: the headers as sent. */
function rawGet(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: 'localhost', port: appPort(), path, method: 'GET', headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, br' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (c: Buffer) => chunks.push(c));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('@NoCompression ( NoCompressionMiddleware )', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => {
        c.register(NoCompressionController).as(BaseController);
        c.register(NoCompressionWholeController).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('leaves compression on for a route without it', async () => {
    const res = await rawGet('/no-compression/compressed');
    expect(res.status).to.eq(200);
    expect(res.headers['content-encoding']).to.be.oneOf(['gzip', 'br']);
  });

  it('sends the route uncompressed', async () => {
    const res = await rawGet('/no-compression/plain');
    expect(res.status).to.eq(200);
    expect(res.headers['content-encoding']).to.be.undefined;
    expect(JSON.parse(res.body)).to.deep.eq(BIG);
  });

  it('sends every route of a decorated controller uncompressed', async () => {
    const res = await rawGet('/no-compression-controller/any');
    expect(res.headers['content-encoding']).to.be.undefined;
  });
});
