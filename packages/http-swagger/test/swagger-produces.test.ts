import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ClassInfo, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, req } from './common.js';
import { OpenApiBuilder } from '../src/index.js';
import type { IMethodDocumentation, ISwaggerConfig } from '../src/index.js';

type SpecNode = { [key: string]: SpecNode };

describe('Swagger @produces tag', function () {
  this.timeout(30000);

  let spec: SpecNode;

  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    spec = JSON.parse(result.text) as SpecNode;
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.stop();
    DI.clearCache();
  });

  const responses = (path: string, verb = 'get') => spec.paths[`/produces/${path}`][verb].responses;

  it('documents a text media type, parameters included, as a string body', () => {
    expect(responses('metrics')['200']).to.deep.equal({
      description: 'Metric families of this process',
      content: { 'text/plain; version=0.0.4': { schema: { type: 'string' } } },
    });
  });

  it('lists every media type of a repeated tag; JSON keeps the documented schema', () => {
    expect(responses('invoices/{month}')['200'].content).to.deep.equal({
      'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ProducesInvoiceDto' } } },
      'text/csv': { schema: { type: 'string' } },
    });
    expect(responses('invoices/{month}')['404']).to.deep.equal({ $ref: '#/components/responses/NotFound' });
  });

  it('gives an XML media type the documented schema', () => {
    expect(responses('xml')['200'].content).to.deep.equal({ 'application/xml': { schema: { $ref: '#/components/schemas/ProducesInvoiceDto' } } });
  });

  it('names the real media type of a file response and keeps its binary schema', () => {
    expect(responses('pdf')['200'].content).to.deep.equal({ 'application/pdf': { schema: { type: 'string', format: 'binary' } } });
  });

  it('documents any other media type as a binary body', () => {
    expect(responses('chart')['200'].content).to.deep.equal({ 'image/png': { schema: { type: 'string', format: 'binary' } } });
  });

  it('applies to 2xx responses only; an error response stays JSON', () => {
    expect(responses('import', 'post')['201']).to.deep.equal({ description: 'The rows that were imported', content: { 'text/csv': { schema: { type: 'string' } } } });
    expect(responses('import', 'post')['409'].content).to.deep.equal({ 'application/json': { schema: { $ref: '#/components/schemas/ProducesInvoiceDto' } } });
  });

  it('gives a 2xx without a type the produced content', () => {
    expect(responses('rows')['200']).to.deep.equal({ description: 'Rows of the month', content: { 'text/csv': { schema: { type: 'string' } } } });
    expect(responses('export', 'post')['201']).to.deep.equal({ description: 'The export', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } });
  });

  it('gives a 204 no content', () => {
    expect(responses('rows', 'delete')['204']).to.deep.equal({ description: 'Deleted' });
  });
});

describe('Swagger @produces with an invalid value, as served', function () {
  this.timeout(120000);

  let probed: { spec: { status: number; body: string }; route: number };

  // In a fresh process: the broken controller must not reach the controllers every other suite documents.
  before(() => {
    const run = spawnSync(process.execPath, ['--loader', 'ts-node/esm', '--experimental-specifier-resolution=node', resolve(process.cwd(), 'test', 'support', 'probe.produces-invalid.ts')], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json') },
      timeout: 110000,
    });
    const match = /<<JSON\n([\s\S]*?)\nJSON>>/.exec(run.stdout);
    if (!match) throw new Error(`probe failed (${run.status}${run.error ? `, ${run.error.message}` : ''}):\n${run.stdout}\n${run.stderr}`);
    probed = JSON.parse(match[1]) as typeof probed;
  });

  it('answers 500 on /docs/swagger.json, naming the controller, the route and the value', () => {
    expect(probed.spec.status).to.equal(500);
    expect(probed.spec.body).to.contain('BrokenProducesController.ping (GET /broken/ping): @produces `csv` is not a media type');
  });

  it('keeps serving the application', () => {
    expect(probed.route).to.equal(200);
  });
});

describe('Swagger @produces in the builder', function () {
  @BasePath('reports')
  class ReportController extends BaseController {
    @Get('daily')
    public daily() {
      return new Ok({});
    }
  }

  const config: ISwaggerConfig = { enabled: true, title: 'test', version: '1.0.0' };
  const controller = Object.assign(new ClassInfo<BaseController>(), { name: 'ReportController', instance: new ReportController() });
  const build = (method: IMethodDocumentation) => {
    const builder = new OpenApiBuilder(config);
    builder.addController(controller, { className: 'ReportController', methods: { daily: method } });
    return builder.build().paths['/reports/daily'].get;
  };

  it('fails the build on a value that is not a media type, naming the controller, the route and the value', () => {
    expect(() => build({ params: {}, produces: ['csv'] })).to.throw(InvalidArgument, 'ReportController.daily (GET /reports/daily): @produces `csv` is not a media type');
  });

  it('fails the build on an empty tag', () => {
    expect(() => build({ params: {}, produces: [''] })).to.throw(InvalidArgument, '@produces `` is not a media type');
  });

  for (const value of ['text/csv; charset=utf-8 the rows', 'text/csv;;;', 'text/csv; charset', 'text/csv the rows', 'text/*']) {
    it(`fails the build on \`${value}\``, () => {
      expect(() => build({ params: {}, produces: [value] })).to.throw(InvalidArgument, `@produces \`${value}\` is not a media type`);
    });
  }

  it('accepts parameters as name=value, token or quoted string, and keeps the value as written', () => {
    const op = build({ params: {}, produces: ['Text/CSV; charset=utf-8; header="present; quoted"'], returns: { description: 'Rows' } });
    expect(Object.keys(op.responses['200'].content ?? {})).to.deep.equal(['Text/CSV; charset=utf-8; header="present; quoted"']);
  });

  it('puts the examples of a bodyless route under the produced media type', () => {
    const op = build({ params: {}, produces: ['text/csv'], returns: { description: 'Rows' }, examples: [{ name: 'two rows', value: 'a,b' }] });
    expect(Object.keys(op.responses['200'].content ?? {})).to.deep.equal(['text/csv']);
    expect(op.responses['200'].content?.['text/csv'].examples).to.deep.equal({ 'two rows': { summary: 'two rows', description: undefined, value: 'a,b' } });
  });

  it('changes nothing without the tag', () => {
    expect(build({ params: {}, returns: { description: 'Rows' } }).responses['200'].content).to.deep.equal({ 'application/json': { schema: { type: 'object' } } });
  });
});
