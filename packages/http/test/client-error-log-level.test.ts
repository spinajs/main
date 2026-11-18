import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthenticationFailed, BadRequest, CodedHttpException, Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Log, LogLevel, MemoryTarget } from '@spinajs/log';
import type { ILogEntry } from '@spinajs/log';
import '@spinajs/templates-pug';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer } from '../src/index.js';

const MEMORY = 'ClientErrorLogLevelMemory';

@BasePath('client-error-log')
class ClientErrorLogController extends BaseController {
  @Get()
  public unauthenticated() {
    throw new AuthenticationFailed('no credentials');
  }

  @Get()
  public missing() {
    throw new ResourceNotFound('no such item');
  }

  @Get()
  public forbidden() {
    throw new Forbidden('not yours');
  }

  @Get()
  public invalid() {
    throw new BadRequest('bad input');
  }

  @Get()
  public conflict() {
    throw new CodedHttpException(409, 'item.locked', 'item is locked');
  }

  @Get()
  public unavailable() {
    throw new CodedHttpException(503, 'upstream.down', 'upstream is down');
  }

  @Get()
  public crash() {
    throw new Error('unexpected failure');
  }
}

function entriesFor(path: string): ILogEntry[] {
  return (DI.get(MemoryTarget)?.getRecords() ?? []).filter((r) => r.Variables.url === `/client-error-log/${path}`);
}

function levelsFor(path: string): LogLevel[] {
  return entriesFor(path).map((e) => e.Level);
}

describe('http: the log level of an error answer follows its status', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(ClientErrorLogController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();

    // Loggers are cached by name for the whole process: attach the memory target to every live one.
    for (const logger of Log.Loggers.values()) {
      logger.addTarget({ name: MEMORY, type: 'MemoryTarget' }, { level: 'trace' });
    }
  });

  after(async () => {
    for (const logger of Log.Loggers.values()) {
      await logger.removeTarget(MEMORY);
    }
    await releaseHttpServer();
    DI.unregister(ClientErrorLogController as Class<unknown>);
    DI.uncache(ClientErrorLogController);
    DI.uncache(BaseController);
    DI.uncache(Configuration);
  });

  beforeEach(() => DI.get(MemoryTarget)?.clear());

  async function get(path: string, status: number) {
    const res = await req().get(`client-error-log/${path}`).set('Accept', 'application/json');
    expect(res.status, path).to.eq(status);
  }

  it('logs a 401 at debug', async () => {
    await get('unauthenticated', 401);

    expect(levelsFor('unauthenticated')).to.deep.eq([LogLevel.Debug]);
    expect(entriesFor('unauthenticated')[0].Variables.status).to.eq(401);
  });

  it('logs a 404 at debug', async () => {
    await get('missing', 404);

    expect(levelsFor('missing')).to.deep.eq([LogLevel.Debug]);
  });

  it('logs a request that matches no route at debug', async () => {
    const res = await req().get('wp-login.php').set('Accept', 'application/json');

    expect(res.status).to.eq(404);
    const entries = (DI.get(MemoryTarget)?.getRecords() ?? []).filter((r) => r.Variables.url === '/wp-login.php');
    expect(entries.map((e) => e.Level)).to.deep.eq([LogLevel.Debug]);
  });

  it('logs a 403 at warn', async () => {
    await get('forbidden', 403);

    expect(levelsFor('forbidden')).to.deep.eq([LogLevel.Warn]);
  });

  it('logs a 400 at warn', async () => {
    await get('invalid', 400);

    expect(levelsFor('invalid')).to.deep.eq([LogLevel.Warn]);
  });

  it('logs a coded 4xx at warn, by the status the exception carries', async () => {
    await get('conflict', 409);

    expect(levelsFor('conflict')).to.deep.eq([LogLevel.Warn]);
  });

  it('logs a coded 5xx at error', async () => {
    await get('unavailable', 503);

    expect(levelsFor('unavailable')).to.deep.eq([LogLevel.Error]);
  });

  it('logs an unmapped error at error, with the exception', async () => {
    await get('crash', 500);

    const errors = entriesFor('crash').filter((e) => e.Level === LogLevel.Error);
    expect(errors).to.have.length(1);
    expect(errors[0].Variables.error?.message).to.eq('unexpected failure');
    expect(errors[0].Variables.status).to.eq(500);
  });
});
