import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger @Access extraction', function () {
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

  it('should expose x-authz-resource from the controller-level @Access', () => {
    const op = spec.paths['/access/inherited'].get;
    expect(op['x-authz-resource']).to.deep.equal({ type: 'test' });
    expect(op['x-authz-permission']).to.deep.equal(['test:read']);
    expect(op['x-authz-controller-permission']).to.be.undefined;
  });

  it('should let a route @Access replace the permission and keep the class one as controller-permission', () => {
    const op = spec.paths['/access/{id}'].get;
    expect(op['x-authz-permission']).to.deep.equal(['test:update']);
    expect(op['x-authz-controller-permission']).to.deep.equal(['test:read']);
  });

  it('should keep alternatives and a non-root domain', () => {
    const op = spec.paths['/access/'].post;
    expect(op['x-authz-permission']).to.deep.equal(['test:create', 'test:import']);
    expect(op['x-authz-domain']).to.equal('tenant');
    expect(op.description).to.match(/`test:create`\s+or\s+`test:import`/);
  });

  it('should append a readable access line to the description', () => {
    const op = spec.paths['/access/{id}'].delete;
    expect(op.description).to.include('**Access:** requires `test:delete` on `test`');
    expect(op.description).to.include('(anonymous allowed)');
    expect(op['x-authz-anonymous']).to.equal(true);
  });

  it('should add 401 and 403 responses unless the JSDoc documents them', () => {
    const guarded = spec.paths['/access/inherited'].get.responses;
    expect(guarded['401']).to.deep.equal({ $ref: '#/components/responses/Unauthorized' });
    expect(guarded['403']).to.deep.equal({ $ref: '#/components/responses/Forbidden' });
    const documented = spec.paths['/access/{id}'].delete.responses;
    expect(documented['403']).to.deep.equal({ $ref: '#/components/responses/Forbidden' });
  });

  it('should NOT emit x-authz-* on controllers without @Access', () => {
    const op = spec.paths['/pets/'].get;
    expect(Object.keys(op).filter((k) => k.startsWith('x-authz-'))).to.deep.equal([]);
    expect(op.description ?? '').to.not.include('**Access:**');
  });
});
