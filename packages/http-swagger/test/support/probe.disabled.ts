// Runs in a fresh node process (ts-node/esm): boots http-swagger with its own package config and
// `http.swagger.enabled` from argv, and prints what the docs paths answer.
import 'reflect-metadata';
import { resolve } from 'node:path';
import { DI } from '@spinajs/di';
import { req } from '../common.js';
import { SwaggerController, SwaggerService } from '../../src/index.js';
import { bootWithPackageConfig } from './package-config-boot.js';

// 'override' keeps the key on and switches the docs off through a SwaggerService subclass.
const mode = process.argv[2];
const enabled = mode !== 'disabled';

// The package config resolves its folders under <root>/node_modules, as in an installed app.
process.env.WORKSPACE_ROOT_PATH = resolve(process.cwd(), '..', '..');

class DocsOffSwaggerService extends SwaggerService {
  public get IsEnabled(): boolean {
    return false;
  }
}

await bootWithPackageConfig(
  (pkg, http) => ({ ...pkg, ...http, swagger: { ...pkg.swagger, ...http.swagger, enabled } }),
  () => {
    if (mode === 'override') DI.register(DocsOffSwaggerService).as(SwaggerService);
  },
);

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
