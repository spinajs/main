import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { join, normalize, resolve } from 'path';
import os from 'os';

function cwd(...path : string[]) { 
  return join(process.env.WORKSPACE_ROOT_PATH ?? process.cwd(), ...path);
}

function lib(...path: string[]) { 
  return join(cwd(), 'node_modules', '@spinajs', 'http', 'lib', ...path);
}

function dir(path: string) {
  const inCommonJs = typeof module !== 'undefined';
  return [
    resolve(normalize(join(lib(), inCommonJs ? 'cjs' : 'mjs', path))),

    // one up if we run from app or build folder
    resolve(normalize(join(lib(), inCommonJs ? 'cjs' : 'mjs', path))),
  ];
}


const http = {
  system: {
    dirs: {
      locales: [...dir('locales')],
      cli: [...dir('cli')],
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
      // formidable default file provider, incoming
      // files via  form are stored in os.tmpdir()
      {
        service: 'fsNative',
        name: '__file_upload_default_provider__',
        basePath: os.tmpdir(),
      },
      {
        service: 'fsNative',
        name: '__fs_http_response_templates__',
        basePath: lib('views', 'responses'),
      },
      {
        service: 'fsNative',
        name: '__fs_controller_cache__',

        // controllers cache alwas in running process cwd
        basePath: join(process.cwd(), '__cache__', '__controllers__'),
      },
    ],
  },

  http: {
    /**
     * File upload default middlewares
     */
    upload: {
      middlewares: ['FileInfoMiddleware']

    },
    
    ssl: {
      key: '',
      cert: '',
    },
    controllers: {
      route: {
        // added to all routes prefix to route path
        prefix: '',
      },
    },
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
        Path: lib('static'),
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
                        <h3> Ticket no. {ticket}</h3>
                      </body>
                    </html>`,
  },
};

export default http;
