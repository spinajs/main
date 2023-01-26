import * as express from 'express';
import { HTTP_STATUS_CODE, HttpAcceptHeaders, DataTransformer } from './interfaces.js';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ILog, Log } from '@spinajs/log';
import _ from 'lodash';
import * as randomstring from 'randomstring';
import { __translate, __translateH, __translateL, __translateNumber } from '@spinajs/intl';
import { Templates } from '@spinajs/templates';

/**
 * Sends data & sets proper header as json
 *
 * @param model - data to send
 * @param status - status code
 */
export function jsonResponse(model: any, status?: HTTP_STATUS_CODE) {
  return (_req: express.Request, res: express.Response) => {
    res.status(status ? status : HTTP_STATUS_CODE.OK);

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
export function textResponse(model: any, status?: HTTP_STATUS_CODE) {
  return (_req: express.Request, res: express.Response) => {
    res.status(status ? status : HTTP_STATUS_CODE.OK);

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
export function htmlResponse(file: string, model: any, status?: HTTP_STATUS_CODE) {
  const cfg: Configuration = DI.get(Configuration);

  return (req: express.Request, res: express.Response) => {
    if (!req.accepts('html')) {
      httpResponse(
        {
          error: {
            message: 'invalid request content type',
            code: 400,
          },
        },
        HTTP_STATUS_CODE.BAD_REQUEST,
        'responses/serverError.pug',
      )(req, res);
      return;
    }

    res.set('Content-Type', 'text/html');

    _render(file, model, status).catch((err) => {
      const log: ILog = DI.resolve(Log, ['http']);

      log.warn(`Cannot render html file ${file}, error: ${err.message}:${err.stack}`, err);

      // try to render server error response
      _render('responses/serverError.pug', { error: err }, HTTP_STATUS_CODE.INTERNAL_ERROR).catch((err2) => {
        const log: ILog = DI.resolve(Log, ['http']);

        // final fallback rendering error fails, we render embedded html error page
        const ticketNo = randomstring.generate(7);

        log.warn(`Cannot render pug file error: ${err2.message}, ticket: ${ticketNo}`, err);

        res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);
        res.send(cfg.get<string>('http.FatalTemplate').replace('{ticket}', ticketNo));
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
export function httpResponse(model: any, code: HTTP_STATUS_CODE, template: string) {
  const cfg: Configuration = DI.get(Configuration);
  const acceptedHeaders = cfg.get<HttpAcceptHeaders>('http.AcceptHeaders');
  const transformers = DI.resolve(Array.ofType(DataTransformer));
  return (req: express.Request, res: express.Response) => {
    if (req.accepts('html') && (acceptedHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
      htmlResponse(`${template}.pug`, model, code)(req, res);
    } else if (req.accepts('json') && (acceptedHeaders & HttpAcceptHeaders.JSON) === HttpAcceptHeaders.JSON) {
      if (req.headers['x-data-transform']) {
        const transformer = transformers.find((t) => t.Type === req.headers['x-data-transform']);
        if (transformer) {
          jsonResponse(transformer.transform(model, req), code)(req, res);
        } else {
          jsonResponse(
            {
              error: {
                message: "invalid data transformer, remove header 'x-data-transform' to return raw data or set proper data transformer",
                code: 400,
              },
            },
            HTTP_STATUS_CODE.BAD_REQUEST,
          )(req, res);
        }
      } else {
        jsonResponse(model, code)(req, res);
      }
    } else {
      textResponse(model, code)(req, res);
    }
  };
}
