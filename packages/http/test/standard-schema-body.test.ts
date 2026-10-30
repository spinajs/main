import 'mocha';
import { expect } from 'chai';
import { Intl } from '@spinajs/intl';
import { Schema, type StandardSchemaV1 } from '@spinajs/validation';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, Body, Controllers, HttpServer, Ok, Post } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

const asyncName: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'hand',
    validate: async (value) => {
      await new Promise((resolve) => setImmediate(resolve));
      const v = value as { name?: unknown; password?: unknown };
      return typeof v?.name === 'string' ? { value: v } : { issues: [{ message: `bad name, got ${String(v?.password)}`, path: ['name'] }] };
    },
  },
};

@Schema(asyncName)
class AsyncStandardInput {
  public name: string;

  constructor(data: Partial<AsyncStandardInput>) {
    Object.assign(this, data);
  }
}

@BasePath('params/standard-schema')
class StandardSchemaParams extends BaseController {
  @Post()
  public create(@Body() input: AsyncStandardInput) {
    return new Ok({ input });
  }
}

describe('Standard Schema on the http argument path', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => {
        c.register(StandardSchemaParams).as(BaseController);
      },
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('awaits an asynchronous validator', async () => {
    const res = await req().post('params/standard-schema/create').send({ name: 'a' });
    expect(res.status).to.eq(200);
  });

  it('answers 400 for an invalid body and never echoes the input in the problem body', async () => {
    const res = await req().post('params/standard-schema/create').send({ name: 1, password: 'hunter2-secret' });
    expect(res.status).to.eq(400);
    expect(JSON.stringify(res.body)).not.to.include('hunter2-secret');
  });
});
