import { join, normalize, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { ConfigVar, Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';

function cwd(...paths: string[]) {
  return join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), ...paths);
}

function lib(...paths: string[]) {
  return join(cwd(), 'node_modules', '@spinajs', 'http-swagger', 'lib', ...paths);
}

function swaggerUiDist() {
  let dir = cwd();
  // Walk up the directory tree to handle hoisted packages in monorepos
  while (true) {
    const candidate = join(dir, 'node_modules', 'swagger-ui-dist');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not found (e.g. pnpm isolated layout or a bundled deploy). Do NOT throw at
  // config-import time — that aborts the entire application boot over optional
  // docs static assets. Return a best-effort path: the http static handler
  // skips non-existent paths with a warning, and the Swagger UI falls back to
  // its CDN URLs (see SwaggerController.getUI defaults).
  return join(cwd(), 'node_modules', 'swagger-ui-dist');
}

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return resolve(normalize(join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), 'node_modules', '@spinajs', 'http-swagger', 'lib', inCommonJs ? 'cjs' : 'mjs', path)));
}


const httpSwagger = {
  system: {
    dirs: {
      controllers: [dir('controllers')],
      cli: [dir('cli')]
    },
  },
  fs: {
    providers: [
      {
        service: 'fsNative',
        name: '__fs_swagger_views__',
        basePath: lib('views'),
      },
      {
        service: 'fsNative',
        name: '__fs_swagger_cache__',
        basePath: join(process.cwd(), '__cache__', '__swagger__'),
      },
    ],
  },
  http: {
    Static: [
      {
        Route: '/docs/ui',
        Path: swaggerUiDist(),
      },
      {
        Route: '/docs/static',
        Path: lib('views'),
      },
    ],
    swagger: {
      enabled: true,
      title: 'API Documentation',
      version: '1.0.0',
      description: '',
      basePath: '',
      servers: [] as { url: string; description?: string }[],
      ui: {
        cssUrl: '/docs/ui/swagger-ui.css',
        bundleUrl: '/docs/ui/swagger-ui-bundle.js',
        presetUrl: '/docs/ui/swagger-ui-standalone-preset.js',
        specUrl: new ConfigVar(() => {
          const prefix = DI.get<Configuration>(Configuration)?.get<string>('http.controllers.route.prefix', '');
          return prefix ? `/${prefix}/docs/swagger.json` : '/docs/swagger.json';
        }),
        pageTitle: 'API Documentation',
      },
    },
  },
};
 
export default httpSwagger;
