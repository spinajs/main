import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

describe('Swagger error response components', function () {
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

  it('should register a shared Error schema in components.schemas', () => {
    expect(spec.components).to.be.an('object');
    expect(spec.components.schemas).to.be.an('object');
    expect(spec.components.schemas).to.have.property('Error');

    const errorSchema = spec.components.schemas.Error;
    expect(errorSchema.type).to.equal('object');
    expect(errorSchema.properties).to.have.property('message');
    expect(errorSchema.properties.message.type).to.equal('string');
  });

  it('should register reusable error response components for documented status codes', () => {
    expect(spec.components.responses).to.be.an('object');
    expect(spec.components.responses).to.include.keys([
      'BadRequest',
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'Conflict',
      'ValidationError',
      'ServerError',
    ]);
  });

  it('each registered component should reference the Error schema', () => {
    for (const name of ['Unauthorized', 'Forbidden', 'NotFound', 'ServerError']) {
      const resp = spec.components.responses[name];
      expect(resp.content['application/json'].schema.$ref).to.equal('#/components/schemas/Error');
    }
  });

  it('should emit $ref responses on operations for documented standard codes', () => {
    const op = spec.paths['/errors/{id}'].get;
    expect(op.responses['401']).to.have.property('$ref', '#/components/responses/Unauthorized');
    expect(op.responses['403']).to.have.property('$ref', '#/components/responses/Forbidden');
    expect(op.responses['404']).to.have.property('$ref', '#/components/responses/NotFound');
    expect(op.responses['409']).to.have.property('$ref', '#/components/responses/Conflict');
    expect(op.responses['422']).to.have.property('$ref', '#/components/responses/ValidationError');
    expect(op.responses['500']).to.have.property('$ref', '#/components/responses/ServerError');
  });

  it('should keep inline responses when JSDoc provides an explicit type annotation', () => {
    const op = spec.paths['/errors/inline-typed/{id}'].get;
    const resp = op.responses['400'];
    expect(resp.$ref).to.be.undefined;
    expect(resp.description).to.include('inline error string');
    expect(resp.content['application/json'].schema.type).to.equal('string');
  });

  it('should not register response components for codes that were never used', () => {
    // 418 was never documented anywhere in the test suite
    expect(spec.components.responses).to.not.have.property('ImATeapot');
  });

  it('should still register the default 200 response on routes with no @response tags', () => {
    const op = spec.paths['/errors/clean'].get;
    expect(op.responses).to.have.property('200');
  });
});
