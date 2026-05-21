import { join, normalize, resolve } from 'path';

function cwd(...paths: string[]) {
  return join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), ...paths);
}

function lib(...paths: string[]) {
  return join(cwd(), 'node_modules', '@spinajs', 'http-swagger', 'lib', ...paths);
}

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(lib(), inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}

const httpSwagger = {
  system: {
    dirs: {
      controllers: [...dir('controllers')],
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
    swagger: {
      enabled: true,
      title: 'API Documentation',
      version: '1.0.0',
      description: '',
      basePath: '',
      servers: [] as { url: string; description?: string }[],
      ui: {
        cssUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css',
        bundleUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js',
        presetUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js',
        specUrl: '/docs/swagger.json',
        pageTitle: 'API Documentation',
      },
    },
  },
};

export default httpSwagger;
