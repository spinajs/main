import { DI } from '@spinajs/di';
import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { Controllers } from '@spinajs/http';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');

chai.use(chaiHttp);
chai.use(chaiAsPromised);

chai.use(require('chai-subset'));
chai.use(require('chai-like'));
chai.use(require('chai-things'));

export function req() {
  return chai.request('http://localhost:8888/');
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    this.Config = {
      system: {
        dirs: {
          locales: [dir('./../src/locales'), dir('./locales')],
          templates: [dir('./../src/views'), dir('./views')],
          controllers: [dir('./controllers')],
        },
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
