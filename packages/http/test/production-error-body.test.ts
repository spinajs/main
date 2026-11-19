import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Log, LogLevel, MemoryTarget } from '@spinajs/log';
import type { ILogEntry } from '@spinajs/log';
import { Forbidden, UnexpectedServerError } from '@spinajs/exceptions';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer } from '../src/index.js';

const MEMORY = 'ProductionErrorBodyMemory';
const SECRET = 'secret detail';
const QUERY = 'SELECT password FROM users WHERE id = 42';

@BasePath('production-error')
class ProductionErrorController extends BaseController {
  @Get()
  public unmapped() {
    throw Object.assign(new Error(SECRET), { query: QUERY });
  }

  @Get()
  public mappedServerError() {
    throw new UnexpectedServerError(SECRET);
  }

  @Get()
  public forbidden() {
    throw new Forbidden('Only the owner can do that');
  }
}

class ProductionConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.configuration = { isProduction: true };
  }
}

async function startWith(configuration: typeof TestConfiguration) {
  uncacheControllers();
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  DI.register(configuration).as(Configuration);
  DI.register(ProductionErrorController).as(BaseController);
  await DI.resolve(Configuration);
  await DI.resolve(fsService);
  await DI.resolve(Intl);
  await DI.resolve(Controllers);
  await (await DI.resolve<HttpServer>(HttpServer)).start();

  // Loggers are cached by name for the whole process: attach the memory target to every live one.
  for (const logger of Log.Loggers.values()) {
    logger.addTarget({ name: MEMORY, type: 'MemoryTarget' }, { level: 'error' });
  }
}

async function stop(configuration: typeof TestConfiguration) {
  for (const logger of Log.Loggers.values()) {
    await logger.removeTarget(MEMORY);
  }
  await releaseHttpServer();
  DI.unregister(ProductionErrorController as Class<unknown>);
  DI.uncache(ProductionErrorController);
  DI.uncache(BaseController);
  DI.unregister(configuration);
  DI.uncache(Configuration);
}

function errorEntriesWith(text: string): ILogEntry[] {
  const records = DI.get(MemoryTarget)?.getRecords() ?? [];
  return records.filter((r) => r.Level === LogLevel.Error && r.Variables.error?.message === text);
}

function expectLoggedOnceWithStack(text: string) {
  const entries = errorEntriesWith(text);
  expect(entries, 'ERROR entries naming the error').to.have.length(1);
  expect(entries[0].Variables.error?.stack).to.be.a('string').and.include(text);
}

describe('http: a production 500 body', function () {
  this.timeout(15000);

  before(() => startWith(ProductionConfiguration));
  after(() => stop(ProductionConfiguration));
  beforeEach(() => DI.get(MemoryTarget)?.clear());

  it('answers an unmapped error with a fixed message and none of its properties, logging the detail', async () => {
    const res = await req().get('production-error/unmapped').set('Accept', 'application/json');

    expect(res.status).to.eq(500);
    expect(res.body).to.deep.eq({ message: 'Internal server error' });
    expect(res.text).to.not.include(SECRET);
    expect(res.text).to.not.include(QUERY);
    expectLoggedOnceWithStack(SECRET);
  });

  it('keeps the detail out of the HTML answer too', async () => {
    const res = await req().get('production-error/unmapped').set('Accept', 'text/html');

    expect(res.status).to.eq(500);
    expect(res.text).to.not.include(SECRET);
    expect(res.text).to.not.include(QUERY);
  });

  it('answers an exception mapped to the server error with the same fixed message', async () => {
    const res = await req().get('production-error/mappedServerError').set('Accept', 'application/json');

    expect(res.status).to.eq(500);
    expect(res.body).to.deep.eq({ message: 'Internal server error' });
    expectLoggedOnceWithStack(SECRET);
  });

  it('keeps the message of an exception mapped to another status', async () => {
    const res = await req().get('production-error/forbidden').set('Accept', 'application/json');

    expect(res.status).to.eq(403);
    expect(res.body).to.have.property('message', 'Only the owner can do that');
  });
});

describe('http: a 500 body outside production', function () {
  this.timeout(15000);

  before(() => startWith(TestConfiguration));
  after(() => stop(TestConfiguration));

  it('still carries the message and the stack', async () => {
    const res = await req().get('production-error/unmapped').set('Accept', 'application/json');

    expect(res.status).to.eq(500);
    expect(res.body).to.include({ message: SECRET, query: QUERY });
    expect(res.body).to.have.property('stack').that.is.a('string');
  });
});
