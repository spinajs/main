import * as express from 'express';
import { HTTP_STATUS_CODE, HttpAcceptHeaders, DataTransformer } from './interfaces';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { ILog, Log } from '@spinajs/log';
import * as pugTemplate from 'pug';
import { join, normalize } from 'path';
import * as fs from 'fs';
import * as _ from 'lodash';
import { IOFail } from '@spinajs/exceptions';
import * as randomstring from 'randomstring';
import { Intl, IPhraseWithOptions } from '@spinajs/intl';

export type ResponseFunction = (req: express.Request, res: express.Response) => void;

export abstract class Response {
  protected responseData: any;

  constructor(responseData: any) {
    this.responseData = responseData;
  }

  public abstract execute(req: express.Request, res: express.Response, next?: express.NextFunction): Promise<ResponseFunction | void>;
}

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

const __translate = (lang: string) => {
  return (text: string | IPhraseWithOptions, ...args: any[]) => {
    const intl = DI.get<Intl>(Intl);
    if (typeof text === 'string') {
      return intl.__(
        {
          phrase: text,
          locale: lang,
        },
        ...args,
      );
    }

    return intl.__(text, ...args);
  };
};

const __translateNumber = (lang: string) => {
  return (text: string | IPhraseWithOptions, count: number) => {
    const intl = DI.get<Intl>(Intl);
    if (typeof text === 'string') {
      return intl.__n(
        {
          phrase: text,
          locale: lang,
        },
        count,
      );
    }

    return intl.__n(text, count);
  };
};

const __translateL = (text: string) => {
  const intl = DI.get<Intl>(Intl);
  return intl.__l(text);
};
const __translateH = (text: string) => {
  const intl = DI.get<Intl>(Intl);
  return intl.__h(text);
};

/**
 * Sends html response & sets proper header. If template is not avaible, handles proper error rendering.
 *
 * @param file - template file path
 * @param model - data passed to template
 * @param status - optional status code
 */
export function pugResponse(file: string, model: any, status?: HTTP_STATUS_CODE) {
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

    try {
      try {
        _render(file, model, status);
      } catch (err) {
        const log: ILog = DI.resolve(Log, ['http']);

        log.warn(`Cannot render pug file ${file}, error: ${err.message}:${err.stack}`, err);

        // try to render server error response
        _render('responses/serverError.pug', { error: err }, HTTP_STATUS_CODE.INTERNAL_ERROR);
      }
    } catch (err) {
      const log: ILog = DI.resolve(Log, ['http']);

      // final fallback rendering error fails, we render embedded html error page
      const ticketNo = randomstring.generate(7);

      log.warn(`Cannot render pug file error: ${err.message}, ticket: ${ticketNo}`, err);

      res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);
      res.send(cfg.get<string>('http.FatalTemplate').replace('{ticket}', ticketNo));
    }

    function _render(f: string, m: any, c: HTTP_STATUS_CODE) {
      const view = getView(f);
      const language: string = req.query[cfg.get<string>('intl.queryParameter')] as any;

      const content = pugTemplate.renderFile(
        view,
        _.merge(m, {
          // add i18n functions as globals
          __: __translate(language),
          __n: __translateNumber(language),
          __l: __translateL,
          __h: __translateH,
        }),
      );

      res.status(c ? c : HTTP_STATUS_CODE.OK);
      res.send(content);
    }

    function getView(viewFile: string) {
      const views = cfg
        .get<string[]>('system.dirs.views')
        .map((p) => normalize(join(p, viewFile)))
        .filter((f) => fs.existsSync(f));

      if (_.isEmpty(views)) {
        throw new IOFail(`View file ${viewFile} not exists.`);
      }

      // return last merged path, eg. if application have own view files (override standard views)
      return views[views.length - 1];
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

  return (req: express.Request, res: express.Response) => {
    if (req.accepts('html') && (acceptedHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
      pugResponse(`${template}.pug`, model, code)(req, res);
    } else if (req.accepts('json') && (acceptedHeaders & HttpAcceptHeaders.JSON) === HttpAcceptHeaders.JSON) {
      if (req.headers['x-data-transform']) {
        const transformer = DI.resolve<DataTransformer>(req.headers['x-data-transform'] as string);
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
