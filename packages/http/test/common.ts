import { DI } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { Controllers } from '../src/index.js';
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

import os from "os";

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export function req() {
  return chai.request('http://localhost:8888/');
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
        defaultProvider: 'test',
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
            name: '__formidable_default_file_provider__',
            basePath: os.tmpdir()
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

          }
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
            type: 'BlackHoleTarget',
          },
        ],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      http: {
        port: 8888,
        middlewares: [
          helmet(),
          express.json({
            limit: '5mb',
          }),
          express.urlencoded({
            extended: true,
          }),
          cookieParser(),
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
