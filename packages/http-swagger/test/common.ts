import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';
import express from 'express';
import os from 'os';

chai.use(chaiHttp);
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export function srcDir(path: string) {
  return resolve(normalize(join(process.cwd(), 'src', path)));
}

export function req() {
  return chai.request('http://localhost:4557/');
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      system: {
        dirs: {
          controllers: [dir('./controllers'), srcDir('./controllers')],
        },
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          {
            service: 'fsNative',
            name: 'fs-temp',
            basePath: dir('./cache'),
          },
          {
            service: 'fsNative',
            name: '__file_upload_default_provider__',
            basePath: os.tmpdir(),
          },
          {
            service: 'fsNative',
            name: '__fs_swagger_views__',
            basePath: resolve(normalize(join(process.cwd(), 'src', 'views'))),
          },
          {
            service: 'fsNative',
            name: '__fs_swagger_cache__',
            basePath: dir('./cache'),
          },
          {
            service: 'fsNative',
            name: '__fs_controller_cache__',
            basePath: dir('./cache'),
          },
          {
            service: 'fsNative',
            name: '__fs_http_response_templates__',
            basePath: resolve(normalize(join(process.cwd(), '..', 'http', 'src', 'views', 'responses'))),
          },
        ],
      },
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'ConsoleTarget',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      http: {
        port: 4557,
        middlewares: [
          express.json({
            limit: '5mb',
          }),
          express.urlencoded({
            extended: true,
          }),
        ],
        AcceptHeaders: 1 | 2,
        swagger: {
          enabled: true,
          title: 'Test Pet Store API',
          version: '2.0.0',
          description: 'A test API for swagger generation',
          servers: [{ url: 'http://localhost:4557', description: 'Test server' }],
          securitySchemes: {
            cookieAuth: {
              type: 'apiKey',
              in: 'cookie',
              name: 'ssid',
              description: 'Session cookie set after login',
            },
          },
          security: [{ cookieAuth: [] }],
          ui: {
            cssUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css',
            bundleUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js',
            presetUrl: 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js',
            specUrl: '/docs/swagger.json',
            pageTitle: 'Test API Docs',
          },
        },
      },
    };
  }
}
