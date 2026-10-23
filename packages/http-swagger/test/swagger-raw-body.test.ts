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

describe('Swagger raw-body route args, end to end', function () {
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
  const put = (path: string): SpecNode => {
    const op = Object.entries(spec.paths).find(([p]) => p === path)?.[1]?.put;
    if (!op) {
      throw new Error(`no PUT documented for ${path}`);
    }
    expect(op, `no PUT documented for ${path}`).to.exist;
    return op;
  };

  it('documents @RequestStream() as an octet-stream body and @ContentDigest({ required: true }) as a required header', () => {
    const op = put('/raw-uploads/{upload}/parts/{part}');

    expect(op.parameters).to.deep.equal([
      { name: 'upload', in: 'path', required: true, schema: { type: 'string', maxLength: 512 } },
      { name: 'part', in: 'path', required: true, schema: { anyOf: [{ type: 'number' }, { type: 'string', pattern: '^[0-9]+$' }] } },
      { name: 'content-digest', in: 'header', required: true, description: DIGEST_DESCRIPTION, schema: { type: 'string' } },
    ]);
    expect(op.requestBody).to.deep.equal({ description: 'Raw bytes of the part', required: true, content: OCTET_BODY });
  });

  it('documents @ContentDigest() without options as an optional header', () => {
    const op = put('/raw-uploads/{upload}/content');

    expect(op.parameters).to.deep.equal([
      { name: 'upload', in: 'path', required: true, schema: { type: 'string', maxLength: 512 } },
      { name: 'content-digest', in: 'header', required: false, description: DIGEST_DESCRIPTION, schema: { type: 'string' } },
    ]);
    expect(op.requestBody).to.deep.equal({ required: true, content: OCTET_BODY });
  });
});
