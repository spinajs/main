import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';

type SpecNode = { [key: string]: SpecNode };

describe('Swagger @body tag', function () {
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
    spec = JSON.parse(result.text);
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    await server.stop();
    DI.clearCache();
  });

  it('documents the JSON body a route reads from @Req() with the named schema of the tag', () => {
    const op = spec.paths['/body-tag/login'].post;
    expect(op.operationId).to.equal('BodyTagController_login');
    expect(op.requestBody).to.deep.equal({
      description: 'The credentials',
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/BodyTagLoginDto' } } },
    });
    expect(spec.components.schemas.BodyTagLoginDto.required).to.deep.equal(['login', 'password']);
  });

  it('expands the named members of a oneOf into components of their own', () => {
    const ok = spec.paths['/body-tag/login'].post.responses['200'];
    expect(ok.content['application/json'].schema).to.deep.equal({ $ref: '#/components/schemas/BodyTagAnswerDto' });
    expect(spec.components.schemas.BodyTagAnswerDto.oneOf).to.deep.equal([{ $ref: '#/components/schemas/BodyTagPendingDto' }, { $ref: '#/components/schemas/BodyTagLoginDto' }]);
    expect(spec.components.schemas.BodyTagPendingDto.properties.MfaRequired.type).to.equal('array');
  });

  it('documents no body for a tag without a type', () => {
    expect(spec.paths['/body-tag/untyped'].post).to.not.have.property('requestBody');
  });

  it('keeps the body of a body route argument over the tag', () => {
    const schema = spec.paths['/body-tag/declared'].post.requestBody.content['application/json'].schema;
    expect(schema).to.not.deep.equal({ $ref: '#/components/schemas/BodyTagLoginDto' });
    expect(schema.properties).to.have.property('note');
    expect(schema.properties).to.not.have.property('login');
  });
});
