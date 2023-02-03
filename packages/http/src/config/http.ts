import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { join, normalize, resolve } from 'path';
import { HttpAcceptHeaders } from '../interfaces.js';

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), "node_modules", "@spinajs", "http", "lib", path)));
}

const http = {
  system: {
    dirs: {
      locales: [dir('locales')],
      controllers: [dir('controllers')],
    },
  },
  cookie: {
    secret: '1234adreewD',
    options: {
      maxAge: 900000,
      httpOnly: true,
    },
  },
  fs: {
    providers: [
      {
        service: 'fsNative',
        name: '__fs_http_response_templates__',
        basePath: dir('views/responses'),
      },
    ]
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
    ],

    /**
     * Default file receiving options
     */
    Files: {
      MaxSize: 1024 * 1024, // 1 MB by default

      // default place where incoming files are copied, can be overriden in @File() options
      BasePath: dir('./../../../data/files'),
    },

    /**
     * Static files folder. Feel free to override this per app
     */
    Static: [
      {
        /**
         * virtual prefix in url eg. http://localhost:3000/static/images/kitten.jpg
         */
        Route: '/_static',

        /**
         * full path to folder with static content
         */
        Path: dir('static'),
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

export default http;
