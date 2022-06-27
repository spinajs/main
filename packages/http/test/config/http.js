const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');

function dir(p) {
  return path.resolve(path.normalize(path.join(__dirname, p)));
}

module.exports = {
  system: {
    dirs: {
      locales: [dir('./../../src/locales'), dir('./../locales')],
      views: [dir('./../../src/views'), dir('./../views')],
      controllers: [dir('./../controllers')],
    },
  },
  intl: {
    // supported locales
    locales: ['en', 'pl'],

    defaultLocale: 'pl',

    // query parameter to switch locale (ie. /home?lang=ch) - defaults to NULL
    queryParameter: 'lang',
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
        Path: dir('/../../src/static'),
      },
      {
        /**
         * virtual prefix in url eg. http://localhost:3000/static/images/kitten.jpg
         */
        Route: '/public',

        /**
         * full path to folder with static content
         */
        Path: dir('/../public'),
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
