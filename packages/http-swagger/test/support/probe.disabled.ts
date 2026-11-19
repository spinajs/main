// Runs in a fresh node process (ts-node/esm): boots http-swagger with its own package config and
// `http.swagger.enabled` from argv, and prints what the docs paths answer.
import 'reflect-metadata';
import { resolve } from 'node:path';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { IConfigLike } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { FsBootsrapper, fsService } from '@spinajs/fs';
import { TestConfiguration, req, srcDir } from '../common.js';
import { SwaggerController, SwaggerService } from '../../src/index.js';

// 'override' keeps the key on and switches the docs off through a SwaggerService subclass.
const mode = process.argv[2];
const enabled = mode !== 'disabled';

// The package config resolves its folders under <root>/node_modules, as in an installed app.
process.env.WORKSPACE_ROOT_PATH = resolve(process.cwd(), '..', '..');
const { default: packageConfig } = await import('../../src/config/http-swagger.js');

/** The test config plus the package config, reloaded through `load()` so their ConfigVars are wrapped as in an app. */
class PackageConfiguration extends TestConfiguration {
  private loaded: IConfigLike = {};

  public async resolve(): Promise<void> {
    await super.resolve();
    const http = this.Config.http as { swagger: Record<string, unknown> };
    this.loaded = {
      ...this.Config,
      system: { dirs: { controllers: [srcDir('./controllers')] } },
      http: { ...packageConfig.http, ...http, swagger: { ...packageConfig.http.swagger, ...http.swagger, enabled } },
    };
    // Only onLoad(): the file sources would bring in the config of every installed package.
    this.Sources = [];
    await this.load();
  }

  protected onLoad(): IConfigLike {
    return this.loaded;
  }
}

class DocsOffSwaggerService extends SwaggerService {
  public get IsEnabled(): boolean {
    return false;
  }
}

DI.setESMModuleSupport();
DI.register(PackageConfiguration).as(Configuration);
if (mode === 'override') DI.register(DocsOffSwaggerService).as(SwaggerService);
DI.resolve(FsBootsrapper).bootstrap();
await DI.resolve(Configuration);
await DI.resolve(fsService);
await DI.resolve(Controllers);
const server = await DI.resolve<HttpServer>(HttpServer);
await server.start();

async function get(path: string, accept: string) {
  const res = await req().get(path).set('Accept', accept).send();
  return { status: res.status, body: res.text };
}

const out = {
  routes: DI.get(SwaggerController)?.Router?.stack.length ?? null,
  spec: await get('docs/swagger.json', 'application/json'),
  ui: await get('docs/', 'text/html'),
  // What a browser sends for a stylesheet and a script; a bare text/css would make the 404 answer a 406.
  uiDist: (await get('docs/ui/swagger-ui.css', 'text/css,*/*;q=0.1')).status,
  uiInit: (await get('docs/static/swagger-ui-init.js', '*/*')).status,
};

process.stdout.write(`<<JSON\n${JSON.stringify(out)}\nJSON>>\n`);
process.exit(0);
