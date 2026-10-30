import 'mocha';
import { expect } from 'chai';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, HttpServer, Ok, Post, Req } from '../src/index.js';
import type { Request } from '../src/index.js';
// The built config, as in shipped-config.test.ts: ts-node's type check rejects the source's default helmet import.
import shipped from '../lib/config/http.js';

interface IReadResult {
  state: { flowing: boolean | null; ended: boolean };
  bytes: number;
  sha256: string;
}

async function drain(body: Readable): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of body) {
    bytes += (chunk as Buffer).length;
    hash.update(chunk as Buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

@BasePath('raw-body-spike')
class RawBodySpikeController extends BaseController {
  @Post()
  public async read(@Req() request: Request) {
    const state = { flowing: request.readableFlowing, ended: request.readableEnded };
    const { bytes, sha256 } = await drain(request);
    // Over the 1 KiB compression threshold, so the response shows that compression ran on this request.
    return new Ok({ state, bytes, sha256, padding: 'x'.repeat(2048) });
  }
}

class ShippedMiddlewaresConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    (this.Config as { http: { middlewares: unknown[] } }).http.middlewares = shipped.http.middlewares;
  }
}

describe('raw request body under the shipped http.middlewares (spec §11.2)', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(ShippedMiddlewaresConfiguration).as(Configuration);
    DI.register(RawBodySpikeController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(RawBodySpikeController as Class<unknown>);
    DI.uncache(RawBodySpikeController);
    DI.uncache(BaseController);
    DI.unregister(ShippedMiddlewaresConfiguration);
    DI.uncache(Configuration);
  });

  it('hands an application/octet-stream body to the action unread and intact, with helmet and compression active', async () => {
    const payload = randomBytes(3 * 1024 * 1024 + 5);
    const res = await req().post('raw-body-spike/read').set('content-type', 'application/octet-stream').send(payload);

    expect(res).to.have.status(200);
    const body = res.body as IReadResult;
    expect(body.state).to.deep.eq({ flowing: null, ended: false });
    expect(body.bytes).to.eq(payload.length);
    expect(body.sha256).to.eq(createHash('sha256').update(payload).digest('hex'));
    expect(res).to.have.header('x-content-type-options', 'nosniff');
    expect(res).to.have.header('content-encoding', 'gzip');
  });

  for (const [type, payload] of [
    ['application/json', '{"a":1}'],
    ['application/x-www-form-urlencoded', 'a=1'],
    ['application/xml', '<a>1</a>'],
  ] as const) {
    it(`gives the action an already consumed stream for ${type}`, async () => {
      const res = await req().post('raw-body-spike/read').set('content-type', type).send(payload);

      expect(res).to.have.status(200);
      const body = res.body as IReadResult;
      expect(body.state).to.deep.eq({ flowing: true, ended: true });
      expect(body.bytes).to.eq(0);
    });
  }
});
