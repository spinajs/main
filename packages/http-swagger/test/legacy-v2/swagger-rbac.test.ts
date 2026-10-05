import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from '../common.js';
import '../../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger RBAC extraction', function () {
  this.timeout(30000);

  let spec: any;

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
    spec = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    DI.clearCache();
  });

  it('should fall back to controller-level permissions when route has none', () => {
    const op = spec.paths['/rbac/inherited'].get;
    expect(op['x-rbac-permissions']).to.deep.equal(['readOwn']);
  });

  it('should override controller permissions with route-level @Permission', () => {
    const op = spec.paths['/rbac/{id}'].get;
    expect(op['x-rbac-permissions']).to.deep.equal(['readAny']);
  });

  it('should preserve all permission alternatives on a single route', () => {
    const op = spec.paths['/rbac/'].post;
    expect(op['x-rbac-permissions']).to.deep.equal(['createOwn', 'createAny']);
  });

  it('should append a human-readable RBAC line to the operation description', () => {
    const op = spec.paths['/rbac/{id}'].delete;
    expect(op.description).to.match(/\*\*RBAC:\*\*/);
    expect(op.description).to.include('`deleteAny`');
    expect(op.description).to.include('`test.resource`');
  });

  it('should join multiple permissions with "or" in the description', () => {
    const op = spec.paths['/rbac/'].post;
    expect(op.description).to.match(/`createOwn`\s+or\s+`createAny`/);
  });
});
