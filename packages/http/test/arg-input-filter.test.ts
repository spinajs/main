import 'mocha';
import { expect } from 'chai';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { Intl } from '@spinajs/intl';
import { Forbidden } from '@spinajs/exceptions';

import { Schema } from '@spinajs/validation';

import { releaseHttpServer, req, TestConfiguration, uncacheControllers } from './common.js';
import { DateTime } from 'luxon';
import { ArgInputFilter, BaseController, BasePath, Body, Controllers, Get, HttpServer, Ok, Post, Query } from '../src/index.js';
import type { IRouteParameter } from '../src/index.js';

@Schema({
  type: 'object',
  properties: { id: { type: 'number' }, name: { type: 'string' } },
  required: ['id', 'name'],
  additionalProperties: false,
})
class StrictInput {
  public id: number;
  public name: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

// Registered by this suite only, so the controller counts of the dir-scanned suites stay as they are.
@BasePath('params/input-filter')
class InputFilterParams extends BaseController {
  @Post()
  public strict(@Body() input: StrictInput) {
    return new Ok({ input });
  }

  @Post()
  public plain(@Body() input: object) {
    return new Ok({ input });
  }

  @Post()
  public primitive(@Query() n: number) {
    return new Ok({ n });
  }

  @Get()
  public queryObject(@Query() a: object) {
    return new Ok({ a });
  }

  @Get()
  public date(@Query() a: DateTime) {
    return new Ok({ date: a.toFormat('dd-MM-yyyy') });
  }
}

const calls: { name: string; input: unknown }[] = [];
const mode = { stripName: false, reject: false, addKey: false };

class FirstFilter extends ArgInputFilter {
  public filter(input: unknown, parameter: IRouteParameter): unknown {
    calls.push({ name: `first:${parameter.Name}`, input: structuredClone(input) });
    if (mode.reject) {
      throw new Forbidden('input rejected');
    }
    if (typeof input !== 'object') {
      return input;
    }
    const { extra: _extra, ...rest } = input as Record<string, unknown>;
    if (mode.stripName) {
      delete rest.name;
    }
    return rest;
  }
}

class SecondFilter extends ArgInputFilter {
  public async filter(input: unknown, parameter: IRouteParameter): Promise<unknown> {
    calls.push({ name: `second:${parameter.Name}`, input: structuredClone(input) });
    return mode.addKey && typeof input === 'object' ? { ...(input as object), added: true } : input;
  }
}

describe('ArgInputFilter', function () {
  this.timeout(15000);

  before(async () => {
    uncacheControllers();

    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }

    DI.register(TestConfiguration).as(Configuration);
    DI.register(FirstFilter).as(ArgInputFilter);
    DI.register(SecondFilter).as(ArgInputFilter);
    DI.register(InputFilterParams).as(BaseController);

    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Intl);
    await DI.resolve(Controllers);
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.start();
  });

  after(async () => {
    await releaseHttpServer();
    DI.unregister(InputFilterParams);
    DI.uncache(InputFilterParams);
    DI.uncache(BaseController);
    DI.unregister(FirstFilter);
    DI.unregister(SecondFilter);
    DI.uncache(FirstFilter);
    DI.uncache(SecondFilter);
    DI.uncache(ArgInputFilter);
  });

  beforeEach(() => {
    calls.length = 0;
    Object.assign(mode, { stripName: false, reject: false, addKey: false });
  });

  it('runs every filter in order on a body object before the action sees it', async () => {
    mode.addKey = true;
    const res = await req().post('params/input-filter/plain').send({ id: 1, name: 'a', extra: 'x' });

    expect(res.status).to.eq(200);
    expect(res.body.input).to.deep.eq({ id: 1, name: 'a', added: true });
    expect(calls.map((c) => c.name)).to.deep.eq(['first:input', 'second:input']);
    expect(calls[1].input).to.deep.eq({ id: 1, name: 'a' });
  });

  it('filters before validation: a key the schema forbids is stripped before the schema sees it', async () => {
    const res = await req().post('params/input-filter/strict').send({ id: 1, name: 'a', extra: 'x' });

    expect(res.status).to.eq(200);
    expect(res.body.input).to.deep.eq({ id: 1, name: 'a' });
  });

  it('validates what the filters return', async () => {
    mode.addKey = true;
    const res = await req().post('params/input-filter/strict').send({ id: 1, name: 'a' });

    expect(res.status).to.eq(400);
  });

  it('a required field the filter removes fails validation with 400', async () => {
    mode.stripName = true;
    const res = await req().post('params/input-filter/strict').send({ id: 1, name: 'a' });

    expect(res.status).to.eq(400);
  });

  it('a filter that throws rejects the request with its status', async () => {
    mode.reject = true;
    const res = await req().post('params/input-filter/plain').send({ id: 1, name: 'a' });

    expect(res.status).to.eq(403);
    expect(calls.map((c) => c.name)).to.deep.eq(['first:input']);
  });

  it('a JSON object in a query string is parsed and filtered', async () => {
    const res = await req().get('params/input-filter/queryObject?a={"id":1,"extra":"x"}');

    expect(res.status).to.eq(200);
    expect(res.body.a).to.deep.eq({ id: 1 });
    expect(calls[0].input).to.deep.eq({ id: 1, extra: 'x' });
  });

  it('a plain string that is not a JSON object reaches its hydrator unchanged', async () => {
    const iso = await req().get('params/input-filter/date?a=2022-06-28T20:59:55Z');
    expect(iso.status).to.eq(200);
    expect(iso.body.date).to.eq('28-06-2022');
    expect(calls[0].input).to.eq('2022-06-28T20:59:55Z');

    const unix = await req().get('params/input-filter/date?a=1656367511');
    expect(unix.status).to.eq(200);
    expect(unix.body.date).to.eq('28-06-2022');
    expect(calls[2].input).to.eq('1656367511');
  });

  it('a primitive argument is not filtered', async () => {
    const res = await req().post('params/input-filter/primitive?n=5').send({});

    expect(res.status).to.eq(200);
    expect(res.body.n).to.eq(5);
    expect(calls).to.deep.eq([]);
  });
});
