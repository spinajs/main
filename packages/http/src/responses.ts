import * as express from 'express';
import { HTTP_STATUS_CODE, HttpAcceptHeaders, DataTransformer, IResponseOptions } from './interfaces.js';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import _ from 'lodash';
import * as randomstring from 'randomstring';
import { __translate, __translateH, __translateL, __translateNumber } from '@spinajs/intl';
import { Templates } from '@spinajs/templates';
import { fs } from '@spinajs/fs';
import { ServerError } from './index.js';
import * as cs from 'cookie-signature';

export function _setCoockies(res: express.Response, options?: IResponseOptions) {
  const cfg: Configuration = DI.get(Configuration);

  // default coockie optiosn set in config for all cockies
  const opt = cfg.get<express.CookieOptions>('http.cookie.options', {});

  options?.Coockies?.forEach((c) => {
    let cookieValue = c.Value;

    if (c.Options.signed) {
      const secureKey = cfg.get<string>('http.cookie.secret');
      cookieValue = cs.sign(cookieValue, secureKey);
    }

    res.cookie(c.Name, cookieValue, {
      ...opt,
      ...c.Options,

      // we manage signed coockies by ourself
      ...{
        signed: false,
      },
    });
  });
}

export function _setHeaders(res: express.Response, options?: IResponseOptions) {
  options?.Headers?.forEach((c) => {
    res.setHeader(c.Name, c.Value);
  });
}

/**
 * Sends data & sets proper header as json
 *
 * @param model - data to send
 * @param status - status code
 */
export function jsonResponse(model: any, options?: IResponseOptions) {
  return (_req: express.Request, res: express.Response) => {
    res.status(options?.StatusCode ? options?.StatusCode : HTTP_STATUS_CODE.OK);

    _setCoockies(res, options);
    _setHeaders(res, options);

    if (model) {
      res.json(model);
    } else {
      res.json();
    }
  };
}

/**
 * Sends data & sets proper header as json
 *
 * @param model - data to send
 * @param status - status code
 */
export function textResponse(model: any, options?: IResponseOptions) {
  return (_req: express.Request, res: express.Response) => {
    res.status(options?.StatusCode ? options?.StatusCode : HTTP_STATUS_CODE.OK);

    _setCoockies(res, options);
    _setHeaders(res, options);

    if (model) {
      res.set('Content-Type', 'text/plain');
      res.send(JSON.stringify(model));
    }
  };
}

/**
 * Sends html response & sets proper header. If template is not avaible, handles proper error rendering.
 *
 * @param file - template file path
 * @param model - data passed to template
 * @param status - optional status code
 */
export function htmlResponse(file: string, model: any, options?: IResponseOptions) {
  const cfg: Configuration = DI.get(Configuration);

  return (req: express.Request, res: express.Response) => {
    if (!req.accepts('html')) {
      const f = DI.resolve<fs>('__file_provider__', ['__fs_http_response_templates__']);
      f.download('serverError.pug').then((file) => {
        httpResponse(
          {
            error: {
              message: 'invalid request content type',
              code: 400,
            },
          },
          file,
          {
            ...options,
            StatusCode: HTTP_STATUS_CODE.BAD_REQUEST,
          },
        )(req, res);
      });

      return;
    }

    res.set('Content-Type', 'text/html');

    _setCoockies(res, options);
    _setHeaders(res, options);

    _render(file, model, options?.StatusCode).catch((err) => {
      const log: Log = DI.resolve(Log, ['http']);

      log.warn(`Cannot render html file ${file}, error: ${err.message}:${err.stack}`, err);

      const fs = DI.resolve<fs>('__file_provider__', ['__fs_http_response_templates__']);
      fs.download('serverError.pug').then((file) => {
        // try to render server error response
        _render(file, { error: err }, HTTP_STATUS_CODE.INTERNAL_ERROR).catch((err2) => {
          const log: Log = DI.resolve(Log, ['http']);

          // final fallback rendering error fails, we render embedded html error page
          const ticketNo = randomstring.generate(7);

          log.warn(`Cannot render pug file error: ${err2.message}, ticket: ${ticketNo}`, err);

          res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);
          res.send(cfg.get<string>('http.FatalTemplate').replace('{ticket}', ticketNo));
        });
      });
    });

    function _render(f: string, m: any, c: HTTP_STATUS_CODE) {
      const templateEngine = DI.get(Templates);

      return templateEngine.render(f, m).then((content) => {
        res.status(c ? c : HTTP_STATUS_CODE.OK);
        res.send(content);
      });
    }
  };
}

/**
 * Default response handling. Checks `Accept` header & matches proper response
 * For now its supports html & json responses
 *
 * @param model - data to send
 * @param code - status code
 * @param template - template to render without extension eg. `views/responses/ok`. It will try to match .pug, .xml or whatever to match response
 *                  to `Accept` header
 */
export function httpResponse(model: any, template: string, options?: IResponseOptions) {
  const cfg: Configuration = DI.get(Configuration);
  const acceptedHeaders = cfg.get<HttpAcceptHeaders>('http.AcceptHeaders');
  const transformers = DI.resolve(Array.ofType(DataTransformer));

  const transform = function (req: express.Request, res: express.Response, header: string) {
    const transformer = transformers.find((t) => t.Type === req.headers[header]);
    if (transformer) {
      jsonResponse(transformer.transform(model, req), options)(req, res);
    } else {
      jsonResponse(
        {
          error: {
            message: `invalid data transformer, remove header ${header} to return raw data or set proper data transformer`,
            code: 400,
          },
        },
        {
          ...options,
          StatusCode: HTTP_STATUS_CODE.BAD_REQUEST,
        },
      )(req, res);
    }
  };

  return (req: express.Request, res: express.Response) => {
    if (req.accepts('html') && (acceptedHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
      const fs = DI.resolve<fs>('__file_provider__', ['__fs_http_response_templates__']);

      if (!fs) {
        throw new ServerError('file provider __fs_http_response_templates__ not set. Pleas set response template file provider for html http default responses !');
      }

      fs.download(template)
        .then((file) => {
          htmlResponse(file, model, options)(req, res);
        })
        .catch((err) => {
          const log: Log = DI.resolve(Log, ['http']);

          log.warn(`Cannot render html file ${template}, error: ${err.message}:${err.stack}`, err);
          fs.download('serverError.pug').then((file) => {
            // try to render server error response
            htmlResponse(
              file,
              { error: err },
              {
                ...options,
                StatusCode: HTTP_STATUS_CODE.INTERNAL_ERROR,
              },
            )(req, res);
          });
        });
    } else if (req.accepts('json') && (acceptedHeaders & HttpAcceptHeaders.JSON) === HttpAcceptHeaders.JSON) {
      if (options.StatusCode >= 400) {
        if (req.headers['x-error-transform']) {
          transform(req, res, 'x-error-transform');
        }
      }
      if (req.headers['x-data-transform']) {
        transform(req, res, 'x-data-transform');
      } else {
        jsonResponse(model, options)(req, res);
      }
    } else {
      textResponse(model, options)(req, res);
    }
  };
}
