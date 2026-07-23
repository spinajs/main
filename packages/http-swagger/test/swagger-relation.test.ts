import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import './controllers/RelationController.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger @Relation reflection', function () {
  this.timeout(30000);

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
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  it('annotates a relation field with x-relation and a description', async () => {
    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    expect(result).to.have.status(200);

    const raw = result.text;
    expect(raw).to.contain('x-relation');
    expect(raw).to.contain('Reference to RefTarget by Uuid');

    const spec = JSON.parse(raw);
    const flat = JSON.stringify(spec);
    expect(flat).to.contain('"x-relation":{"model":"RefTarget","by":"Uuid"}');
  });
});
