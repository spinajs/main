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

    // Navigate to the enriched property structurally instead of matching a
    // serialized fragment - key order in the JSON output is an implementation
    // detail and must not fail this test.
    const spec = JSON.parse(result.text);
    const prop = spec?.paths?.['/rel/create']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.author;
    expect(prop, 'author property missing from /rel/create post request body schema').to.exist;
    expect(prop['x-relation']).to.deep.equal({ model: 'RefTarget', by: 'Uuid' });
    expect(prop.description).to.contain('Reference to RefTarget by Uuid');
  });
});
