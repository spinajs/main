import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Log, LogLevel, MemoryTarget } from '@spinajs/log';
import type { ILogEntry } from '@spinajs/log';
import '@spinajs/templates-pug';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { answeredAsServerError, BaseController, BasePath, Controllers, Get, Ok, Param, Post, HttpServer } from '../src/index.js';

const MEMORY = 'MalformedPathMemory';
const upstreamError = () => Object.assign(new Error('upstream'), { status: 404 });

@BasePath('malformed-path')
class MalformedPathController extends BaseController {
  @Get('item/:id')
  public item(@Param() id: string) {
    return new Ok({ id });
  }

  @Get()
  public upstream() {
    throw upstreamError();
  }

  @Post()
  public body() {
    return new Ok({});
  }
}

function entriesAt(level: LogLevel): ILogEntry[] {
  return (DI.get(MemoryTarget)?.getRecords() ?? []).filter((r) => r.Level === level);
}

describe('http: a request the server refuses before routing', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(MalformedPathController).as(BaseController);
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();

    // Loggers are cached by name for the whole process: attach the memory target to every live one.
    for (const logger of Log.Loggers.values()) {
      logger.addTarget({ name: MEMORY, type: 'MemoryTarget' }, { level: 'warn' });
    }
  });

  after(async () => {
    for (const logger of Log.Loggers.values()) {
      await logger.removeTarget(MEMORY);
    }
    await releaseHttpServer();
    DI.unregister(MalformedPathController as Class<unknown>);
    DI.uncache(MalformedPathController);
    DI.uncache(BaseController);
    DI.uncache(Configuration);
  });

  beforeEach(() => DI.get(MemoryTarget)?.clear());

  it('answers a malformed percent-encoding in the path with 400, logging no error', async () => {
    const res = await req().get('malformed-path/item/%ZZ').set('Accept', 'application/json');

    expect(res.status).to.eq(400);
    expect(res.type).to.eq('application/json');
    expect(res.body).to.deep.eq({ message: 'request path is not valid percent-encoding' });
    expect(entriesAt(LogLevel.Error), 'ERROR entries').to.be.empty;
    expect(entriesAt(LogLevel.Warn).map((e) => e.Variables.url)).to.include('/malformed-path/item/%ZZ');
  });

  it('renders the 400 page for an html client', async () => {
    const res = await req().get('malformed-path/item/%ZZ').set('Accept', 'text/html');

    expect(res.status).to.eq(400);
    expect(res).to.be.html;
    expect(res.text).to.contain('400 - ');
  });

  it('labels the JSON body as JSON for a client that accepts only text/plain', async () => {
    const res = await req().get('malformed-path/item/%ZZ').set('Accept', 'text/plain');

    expect(res.status).to.eq(400);
    expect(res.type).to.eq('application/json');
    expect(JSON.parse(res.text)).to.deep.eq({ message: 'request path is not valid percent-encoding' });
  });

  it('answers a body-parser refusal with its own status, logging no error', async () => {
    const res = await req()
      .post('malformed-path/body')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}');

    expect(res.status).to.eq(415);
    expect(res.body).to.have.property('message', 'unsupported charset "KLINGON"');
    expect(entriesAt(LogLevel.Error), 'ERROR entries').to.be.empty;
  });

  it('still answers 500 for an error with a client status thrown in an action', async () => {
    const res = await req().get('malformed-path/upstream').set('Accept', 'application/json');

    expect(res.status).to.eq(500);
    expect(entriesAt(LogLevel.Error).filter((e) => e.Variables.error?.message === 'upstream')).to.have.length(1);
  });

  it('tells an @OnError handler which of the two answers 500', () => {
    expect(answeredAsServerError(Object.assign(new URIError('URI malformed'), { status: 400 }))).to.eq(false);
    expect(answeredAsServerError(upstreamError())).to.eq(true);
  });
});
