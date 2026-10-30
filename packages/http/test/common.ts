import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { createTestApp } from '@spinajs/testing';
import type { TestApp, TestAppOptions } from '@spinajs/testing';
import { Forbidden } from '@spinajs/exceptions';
import chai from 'chai';
import { Controllers, HttpServer } from '../src/index.js';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';

import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';

import os from 'os';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

const TEST_COOKIE_SECRET = 'test-cookie-secret';

// http.port is 0, so every start binds a free port and parallel runs never collide; requests read it back from the running server.
export function appPort(): number {
  const address = DI.get(HttpServer)?.Server?.address() as AddressInfo | null | undefined;
  if (!address) throw new Error('no http server listening: start HttpServer first');
  return address.port;
}

export const appOrigin = (): string => `http://localhost:${appPort()}`;

export function req() {
  return chai.request(`${appOrigin()}/`);
}

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
      system: {
        dirs: {
          locales: [dir('./../src/locales'), dir('./locales')],
          controllers: [dir('./controllers')],
        },
      },
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          {
            service: 'fsNative',
            name: 'test',
            basePath: dir('./test-files'),
          },
          {
            service: 'fsNative',
            name: 'test2',
            basePath: dir('./test2-files'),
          },
          {
            service: 'fsNative',
            name: 'fs-temp',
            basePath: dir('./files'),
          },
          {
            service: 'fsNative',
            name: '__file_upload_default_provider__',
            basePath: os.tmpdir(),
          },
          {
            service: 'fsNative',
            name: '__fs_http_response_templates__',
            basePath: dir('./../src/views/responses'),
          },
          {
            service: 'fsNative',
            name: '__fs_http_templates__',
            basePath: dir('./views'),
          },
          {
            service: 'fsNative',
            name: '__fs_controller_cache__',
            basePath: dir('./fs/__cache__/__controllers__'),
          },
        ],
      },
      intl: {
        // supported locales
        locales: ['en', 'pl'],

        defaultLocale: 'pl',

        // query parameter to switch locale (ie. /home?lang=ch) - defaults to NULL
        queryParameter: 'lang',
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

        /**
        * File upload default middlewares
        */
        upload: {
          middlewares: ['FileInfoMiddleware']

        },

        port: 0,
        cookie: { secret: TEST_COOKIE_SECRET },
        middlewares: [
          (helmet as any)(),
          express.json({
            limit: '5mb',
            verify: (req: any, _res: any, buf: Buffer) => {
              if (req.headers['x-test-refuse-body']) {
                throw new Error('request body refused');
              }
              if (req.headers['x-test-forbid-body']) {
                throw new Forbidden('webhook signature mismatch');
              }
              req.rawBody = buf;
            },
          }),
          express.urlencoded({
            extended: true,
          }),
          express.text({
            type: ['application/xml', 'text/xml', 'application/*+xml'],
            limit: '5mb',
          }),
          cookieParser(TEST_COOKIE_SECRET),
          compression(),
        ],

        /**
         * Default file receiving options
         */
        Files: {
          MaxSize: 1024 * 1024, // 1 MB by default

          // default place where incoming files are copied, can be overriden in @File() options
          BasePath: dir('./../../data/files'),
        },

        /**
         * Static files folder. Feel free to override this per app
         */
        Static: [
          {
            /**
             * virtual prefix in url eg. http://localhost:3000/static/images/kitten.jpg
             */
            Route: '/static',

            /**
             * full path to folder with static content
             */
            Path: dir('/../src/static'),
          },
          {
            /**
             * virtual prefix in url eg. http://localhost:3000/static/images/kitten.jpg
             */
            Route: '/public',

            /**
             * full path to folder with static content
             */
            Path: dir('/public'),
          },
        ],

        /**
         * Whitch accept headers we support (default JSON & HTML)
         */
        AcceptHeaders: 1 | 2,

        /**
         * Last resort fatal error fallback template, embedded in code
         * in case if we cannot render any static files
         */
        FatalTemplate: `<html>
                            <head>
                                <title>Oooops !</title>
                                </head>
                            <body>
                                <h1>HTTP 500 - Internal Server Error</h1>
                                <div>Looks like we're having some server issues.</div>
                                <hr />
                                <div>
                                    Go back to the previous page and try again. If you think something is broken, report a problem with fallowing ticket number:
                                </div>
                                <h3> TickeT no. {ticket}</h3>
                            </body>
                        </html>`,
      },
    };
  }
}

export function ctr() {
  return DI.get(Controllers);
}

/**
 * The http test app: TestConfiguration, every Bootstrapper, then the services a suite names.
 * Dispose it in `after`: that restores the container, and a started HttpServer stops in its own
 * dispose() during the restore.
 */
export function httpApp(options: Omit<TestAppOptions, 'config'> = {}): Promise<TestApp> {
  // The fs bootstrapper's provider factory throws unless fsService was resolved first.
  return createTestApp({ ...options, configuration: options.configuration ?? TestConfiguration, resolve: [fsService, ...(options.resolve ?? [])] });
}
