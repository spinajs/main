// tslint:disable: no-var-requires
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const cors = require('cors');

import { join, normalize, resolve } from 'path';
import { HttpAcceptHeaders } from '../interfaces.js';

function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

const corsPath = resolve(normalize(join(process.cwd(), 'cors.json')));
const cOptions = require(corsPath);

const corsOptions = {
  origin(origin: any, callback: any) {
    if (!cOptions || cOptions.origins.length === 0 || cOptions.origins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('cors not allowed'));
    }
  },
  exposedHeaders: cOptions.exposedHeaders,
  allowedHeaders: cOptions.allowedHeaders,
  credentials: true,
};

module.exports = {
  system: {
    dirs: {
      locales: [dir('./../locales')],
      templates: [dir('./../views')],
      controllers: [dir('./../controllers')],
    },
  },
  cookie: {
    secret: '1234adreewD',
    options: {
      maxAge: 900000,
      httpOnly: true,
    },
  },
  http: {
    port: 1337,
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
      cors(corsOptions),
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
        Path: dir('/../static'),
      },
    ],

    /**
     * Whitch accept headers we support (default JSON & HTML)
     */
    AcceptHeaders: HttpAcceptHeaders.HTML | HttpAcceptHeaders.JSON,

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
                        <h3> Ticket no. {ticket}</h3>
                      </body>
                    </html>`,
  },
};
