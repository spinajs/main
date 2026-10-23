import 'mocha';
import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok, Param } from '../src/index.js';
import { GetFirstBase, ScopedUploadsBase } from './base-path-params-fixture.js';

@BasePath('projects/:project/uploads')
class ScopedUploadsController extends ScopedUploadsBase {
  @Get('summary/all')
  public async summary(@Param() project: string) {
    return new Ok({ project });
  }
}

@BasePath('get-first')
class GetFirstController extends GetFirstBase {}

class BasePathParamsConfiguration extends TestConfiguration {}

const CONTROLLERS: Class<BaseController>[] = [ScopedUploadsController, GetFirstController];

describe('route params in @BasePath on an inherited controller (spec §11.1)', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(BasePathParamsConfiguration).as(Configuration);
    for (const c of CONTROLLERS) DI.register(c).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    for (const c of CONTROLLERS) {
      DI.unregister(c as Class<unknown>);
      DI.uncache(c);
    }
    DI.uncache(BaseController);
    DI.unregister(BasePathParamsConfiguration);
    DI.uncache(Configuration);
  });

  it('mounts the inherited routes under the subclass path, with the placeholder in req.params', async () => {
    const res = await req().get('projects/p-7/uploads/u-1').set('Accept', 'application/json');

    expect(res).to.have.status(200);
    expect(res.body).to.deep.equal({ route: 'get', project: 'p-7', upload: 'u-1' });
  });

  it('lets @Param() read a placeholder that only @BasePath declares', async () => {
    const res = await req().get('projects/p-7/uploads/summary/all').set('Accept', 'application/json');

    expect(res).to.have.status(200);
    expect(res.body).to.deep.equal({ project: 'p-7' });
  });

  it('runs an inherited raw-body route with its own params, @RequestStream and @ContentDigest', async () => {
    const bytes = Buffer.from('hello');
    const res = await req()
      .put('projects/p-7/uploads/u-1/parts/2')
      .set('Content-Type', 'application/octet-stream')
      .set('Content-Digest', `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`)
      .send(bytes);

    expect(res).to.have.status(200);
    expect(res.body).to.deep.equal({ project: 'p-7', upload: 'u-1', part: 2, bytes: 5, algorithms: ['sha-256'] });
  });

  it('answers HEAD with the HEAD route when it is declared before GET', async () => {
    const res = await req().head('projects/p-7/uploads/u-1');

    expect(res).to.have.status(200);
    expect(res).to.have.header('x-route', 'head');
    expect(res).to.have.header('x-scope', 'p-7/u-1');
  });

  it('answers HEAD with the GET route when GET is declared first (router/lib/route.js:64)', async () => {
    const res = await req().head('get-first/u-1');

    expect(res).to.have.status(200);
    expect(res).to.have.header('x-route', 'get');
  });
});
