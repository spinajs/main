import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';

type SpecNode = { [key: string]: SpecNode };

const DIGEST_DESCRIPTION = 'RFC 9530 digest of the request body, e.g. `sha-256=:<base64>:`';
const OCTET_BODY = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
const PROJECT_FROM_BASE_PATH = { name: 'project', in: 'path', required: true, schema: { type: 'string' } };
const UPLOAD = { name: 'upload', in: 'path', required: true, schema: { type: 'string', maxLength: 512 } };

describe('Swagger @BasePath placeholders of an inherited controller (spec §11.1)', function () {
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

  const operation = (path: string, method: string): SpecNode => {
    const op = spec.paths[path]?.[method];
    if (!op) {
      throw new Error(`no ${method.toUpperCase()} documented for ${path}`);
    }
    return op;
  };

  it('documents a placeholder that only @BasePath declares as a required string path parameter, in template order', () => {
    expect(operation('/projects/{project}/uploads/{upload}', 'get').parameters).to.deep.equal([PROJECT_FROM_BASE_PATH, UPLOAD]);
    expect(operation('/projects/{project}/uploads/{upload}', 'head').parameters).to.deep.equal([PROJECT_FROM_BASE_PATH, UPLOAD]);
  });

  it('keeps the inherited raw-body route parameters and its octet-stream body after the placeholder', () => {
    const op = operation('/projects/{project}/uploads/{upload}/parts/{part}', 'put');

    expect(op.parameters).to.deep.equal([
      PROJECT_FROM_BASE_PATH,
      UPLOAD,
      { name: 'part', in: 'path', required: true, schema: { anyOf: [{ type: 'number' }, { type: 'string', pattern: '^[0-9]+$' }] } },
      { name: 'content-digest', in: 'header', required: false, description: DIGEST_DESCRIPTION, schema: { type: 'string' } },
    ]);
    expect(op.requestBody).to.deep.equal({ required: true, content: OCTET_BODY });
  });

  it('documents @Param() project on the subclass route from the argument, and never the abstract base', () => {
    expect(operation('/projects/{project}/uploads/summary/all', 'get').parameters).to.deep.equal([{ name: 'project', in: 'path', required: true, schema: { type: 'string', maxLength: 512 } }]);
    expect(Object.keys(spec.paths).filter((p) => p.toLowerCase().includes('scopeduploadsbase'))).to.deep.equal([]);
  });
});
