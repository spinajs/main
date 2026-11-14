import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger @Sort and @Include parameters', function () {
  this.timeout(30000);

  let parameters: any[];

  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);

    const server = await DI.resolve<HttpServer>(HttpServer);
    server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    parameters = JSON.parse(result.text).paths['/sort-include/pets'].get.parameters;
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  it('documents @Sort as the JSON `order` query parameter over the sortable columns', () => {
    const sort = parameters.find((p) => p.name === 'order');

    expect(sort, 'no `order` parameter').to.include({ in: 'query', required: false });
    expect(sort.content['application/json'].schema).to.deep.eq({
      type: 'object',
      properties: {
        column: { type: 'string', enum: ['Name', 'CreatedAt'], default: 'CreatedAt' },
        order: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' },
      },
    });
  });

  it('documents @Include as a repeated `include` query parameter over the listed relations', () => {
    const include = parameters.find((p) => p.name === 'include');

    expect(include, 'no `include` parameter').to.include({ in: 'query', required: false, style: 'form', explode: true });
    expect(include.schema).to.deep.eq({ type: 'array', items: { type: 'string', enum: ['Owner', 'Tags'] } });
  });

  it('does not document the argument names', () => {
    expect(parameters.map((p) => p.name)).to.have.members(['order', 'include']);
  });
});
