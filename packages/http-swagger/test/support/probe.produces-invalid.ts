// Runs in a fresh node process (ts-node/esm): boots the swagger controller next to a controller with an invalid
// `@produces`, and prints what /docs/swagger.json and that controller's own route answer.
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, dir, req, srcDir } from '../common.js';

class InvalidProducesConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = { ...this.Config, system: { dirs: { controllers: [srcDir('./controllers'), dir('./controllers-invalid-produces')] } } };
  }
}

DI.setESMModuleSupport();
DI.register(InvalidProducesConfiguration).as(Configuration);
DI.resolve(FsBootsrapper).bootstrap();
await DI.resolve(Configuration);
await DI.resolve(fsService);
await DI.resolve(Controllers);
await (await DI.resolve<HttpServer>(HttpServer)).start();

const spec = await req().get('docs/swagger.json').set('Accept', 'application/json').send();
const route = await req().get('broken/ping').set('Accept', 'application/json').send();

process.stdout.write(`<<JSON\n${JSON.stringify({ spec: { status: spec.status, body: spec.text }, route: route.status })}\nJSON>>\n`);
process.exit(0);
