import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, req } from './common.js';
import '../src/index.js';

/**
 * The whole document of the test controllers, without the routes that use `@produces`, against the document the
 * builder made before the tag existed (`UPDATE_SNAPSHOTS=1` rewrites the snapshot).
 */
const SNAPSHOT = resolve(process.cwd(), 'test', '__snapshots__', 'swagger-without-produces.json');

type Document = { paths: Record<string, unknown>; tags?: { name: string }[]; components?: { schemas?: Record<string, unknown> } };

// JSDoc descriptions carry the line endings of the checkout: CRLF on a Windows working tree, LF in the repository.
const lf = (doc: Document): Document => JSON.parse(JSON.stringify(doc).replace(/\\r\\n/g, '\\n')) as Document;

function withoutProduces(doc: Document): Document {
  const paths = Object.fromEntries(Object.entries(doc.paths).filter(([path]) => !path.startsWith('/produces/')));
  const schemas = Object.fromEntries(Object.entries(doc.components?.schemas ?? {}).filter(([name]) => name !== 'ProducesInvoiceDto'));
  return { ...doc, paths, tags: doc.tags?.filter((t) => t.name !== 'Produces'), components: { ...doc.components, schemas } };
}

describe('Swagger document of routes without @produces', function () {
  this.timeout(30000);

  let doc: Document;

  before(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    DI.resolve(FsBootsrapper).bootstrap();
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
    await DI.resolve(Controllers);
    await (await DI.resolve<HttpServer>(HttpServer)).start();

    const result = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
    doc = lf(withoutProduces(JSON.parse(result.text) as Document));
  });

  after(async () => {
    await (await DI.resolve<HttpServer>(HttpServer)).stop();
    DI.clearCache();
  });

  it('is identical to the document built before the tag existed', () => {
    if (process.env.UPDATE_SNAPSHOTS) writeFileSync(SNAPSHOT, `${JSON.stringify(doc, null, 2)}\n`);
    expect(existsSync(SNAPSHOT), 'snapshot file is missing; run with UPDATE_SNAPSHOTS=1').to.equal(true);
    expect(doc, 'the document changed for routes without @produces; if that is intended, rewrite the snapshot with UPDATE_SNAPSHOTS=1').to.deep.equal(
      lf(JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Document),
    );
  });
});
