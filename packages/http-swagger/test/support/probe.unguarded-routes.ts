// Runs in a fresh node process (ts-node/esm): boots http-swagger's controllers with the real
// @spinajs/authz-http and `authz.http.unguardedRoutes: 'throw'`, and prints whether the server kept serving.
import 'reflect-metadata';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import '@spinajs/authz-http';
import { TestConfiguration, req, srcDir } from '../common.js';
import '../../src/index.js';

class ThrowOnUnguardedConfiguration extends TestConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config = { ...this.Config, system: { dirs: { controllers: [srcDir('./controllers')] } }, authz: { http: { unguardedRoutes: 'throw' } } };
  }
}

const failures: string[] = [];
DI.RootContainer.on('authz.boot.failed', (err: Error) => failures.push(err.message));

DI.setESMModuleSupport();
DI.register(ThrowOnUnguardedConfiguration).as(Configuration);
DI.resolve(FsBootsrapper).bootstrap();
await DI.resolve(Configuration);
await DI.resolve(fsService);
await DI.resolve(Controllers);

const server = await DI.resolve<HttpServer>(HttpServer);
// The unguarded-routes check runs in a listener of `http.server.listening`, before start() resolves.
await server.start();

// The request waits for the root authz boot that listening starts.
let spec: number | string;
try {
  spec = (await req().get('docs/swagger.json').set('Accept', 'application/json').send()).status;
} catch (err) {
  spec = (err as Error).message;
}

process.stdout.write(`<<JSON\n${JSON.stringify({ failures, spec })}\nJSON>>\n`);
process.exit(0);
