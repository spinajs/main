import 'mocha';
import { expect } from 'chai';
import express from 'express';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok, Post, ServerMiddleware } from '../src/index.js';

const hooked: string[] = [];

class RecordingErrorHook extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 0;
  }

  public before(): null {
    return null;
  }

  public after(): express.ErrorRequestHandler {
    return (err: Error, req, _res, next) => {
      hooked.push(`${req.method} ${req.path} ${err.constructor.name}`);
      next(err);
    };
  }
}

@BasePath('hooked')
class HookedController extends BaseController {
  @Get()
  public crash() {
    throw new Error('raised in the action');
  }

  @Post()
  public echo() {
    return new Ok({});
  }
}

// A route answers its own errors, so a server error hook only ever sees errors raised before routing.
describe('Server middleware error hook scope', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(RecordingErrorHook).as(ServerMiddleware);
    DI.register(HookedController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();
  });

  after(async () => {
    await releaseHttpServer();
    for (const c of [HookedController, RecordingErrorHook] as Class<unknown>[]) {
      DI.unregister(c);
      DI.uncache(c);
    }
    DI.uncache(BaseController);
    DI.uncache(ServerMiddleware);
    DI.uncache(Configuration);
  });

  beforeEach(() => {
    hooked.length = 0;
  });

  it('sees a malformed JSON body', async () => {
    const res = await req().post('hooked/echo').set('Content-Type', 'application/json').send('{"broken"');

    expect(res).to.have.status(400);
    expect(hooked).to.have.lengthOf(1);
    expect(hooked[0]).to.match(/^POST \/hooked\/echo /);
  });

  it('does not see an error thrown in a controller action', async () => {
    const res = await req().get('hooked/crash');

    expect(res).to.have.status(500);
    expect(hooked).to.be.empty;
  });
});
