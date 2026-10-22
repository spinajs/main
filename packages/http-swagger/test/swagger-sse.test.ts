import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';

type SpecNode = { [key: string]: SpecNode };

describe('Swagger Server-Sent Events responses', function () {
  this.timeout(30000);

  let spec: SpecNode;

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
    await server.start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    spec = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.stop();
    DI.clearCache();
  });

  it('documents an SseResponse as a text/event-stream string body', () => {
    const content = spec.paths['/streams/ticks'].get.responses['200'].content;

    expect(content).to.deep.equal({ 'text/event-stream': { schema: { type: 'string' } } });
  });
});
