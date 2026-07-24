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
// NOTE: import the exception, not the `ServerError` *response* from './index.js'.
// That barrel import created the cycle interfaces -> responses -> index ->
// response-methods/badRequest -> interfaces, which blew up with
// "Cannot access 'Response' before initialization" whenever a module other
// than index.js (eg. server.js) was the entry point. `UnexpectedServerError`
// is mapped back to the ServerError response by __handle_error__ anyway.
import { UnexpectedServerError } from '@spinajs/exceptions';
import * as cs from 'cookie-signature';
import { XMLBuilder } from 'fast-xml-parser';

export function _setCoockies(res: express.Response, options?: IResponseOptions) {
  const cfg = DI.get(Configuration);
  if (!cfg) {
    throw new Error('Configuration service is not registered in DI container, cannot set coockies without configuration. Please register configuration service to use coockies in http responses');
  }



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

    // Presence check, not truthiness: 0 / false / '' are valid JSON bodies and
    // must be sent. Only undefined / null mean "no body".
    if (model !== undefined && model !== null) {
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

    // Presence check, not truthiness: 0 / false / '' are valid bodies. Only
    // undefined / null end the response empty (and always terminate it —
    // otherwise a missing body on this fallback path hangs until timeout).
    if (model !== undefined && model !== null) {
      res.set('Content-Type', 'text/plain');
      res.send(JSON.stringify(model));
    } else {
      res.end();
    }
  };
}

/**
 * Serializes data to an XML body. The payload should be a plain object graph;
 * arrays and scalars are wrapped under a `<response>` root so the output is a
 * single well-formed document.
 *
 * @param model - data to serialize
 * @param options - response options (status, headers, cookies)
 * @param xmlOptions - fast-xml-parser XMLBuilder options
 */
export function xmlResponse(model: any, options?: IResponseOptions, xmlOptions?: any) {
  return (_req: express.Request, res: express.Response) => {
    res.status(options?.StatusCode ? options.StatusCode : HTTP_STATUS_CODE.OK);

    _setCoockies(res, options);
    _setHeaders(res, options);

    res.set('Content-Type', 'application/xml');

    const builder = new XMLBuilder({ ignoreAttributes: false, ...xmlOptions });
    const payload = model !== null && typeof model === 'object' && !Array.isArray(model) ? model : { response: model };
    res.send(builder.build(payload));
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
  const cfg: Configuration = DI.get(Configuration)!;

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

    _render(file, model, options?.StatusCode ? options.StatusCode : HTTP_STATUS_CODE.OK).catch((err) => {
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
      const templateEngine = DI.get(Templates)!;

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
  const cfg: Configuration | null = DI.get(Configuration);

  if(!cfg) {
    throw new Error('Configuration service is not registered in DI container, cannot send http response without configuration. Please register configuration service to use http responses');
  }

  const acceptedHeaders = cfg.get<HttpAcceptHeaders>('http.AcceptHeaders');
  const transformers = DI.resolve(Array.ofType(DataTransformer));

  const errorTransform = function (req: express.Request, res: express.Response) {
    const transformerName = (req.headers['x-error-transform'] as string) ?? 'default-http-error-transform';
    return transform(req, res, transformerName);
  };

  const dataTransform = function (req: express.Request, res: express.Response) {
    const transformerName = (req.headers['x-data-transform'] as string) ?? 'invalid-x-data-transform-header';
    return transform(req, res, transformerName);
  }

  const transform = function (req: express.Request, res: express.Response, dataTransformer: string) {
    const transformer = transformers.find((t) => t.Type === dataTransformer);
    if (transformer) {
      jsonResponse(transformer.transform(model, req), options)(req, res);
    } else {
      jsonResponse(
        {
          error: {
            message: `invalid data transformer ${dataTransformer}`,
            code: HTTP_STATUS_CODE.BAD_REQUEST,
          },
        },
        {
          ...options,
          StatusCode: HTTP_STATUS_CODE.BAD_REQUEST,
        },
      )(req, res);
    }
  };

  const htmlBranch = (req: express.Request, res: express.Response) => {
    const fs = DI.resolve<fs>('__file_provider__', ['__fs_http_response_templates__']);

    if (!fs) {
      throw new UnexpectedServerError('file provider __fs_http_response_templates__ not set. Pleas set response template file provider for html http default responses !');
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
  };

  const jsonBranch = (req: express.Request, res: express.Response) => {
    if (options && options.StatusCode && options.StatusCode >= 400) {
      errorTransform(req, res);
    } else if (req.headers['x-data-transform']) {
      dataTransform(req, res);
    } else {
      jsonResponse(model, options)(req, res);
    }
  };

  return (req: express.Request, res: express.Response) => {
    // Offer the types the server is configured to produce, JSON first so a
    // wildcard / absent Accept (*/*) defaults to JSON rather than HTML. Explicit
    // client preferences (order / q-values) are still honored by req.accepts.
    const offered: string[] = [];
    if ((acceptedHeaders & HttpAcceptHeaders.JSON) === HttpAcceptHeaders.JSON) offered.push('json');
    if ((acceptedHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) offered.push('html');
    if ((acceptedHeaders & HttpAcceptHeaders.XML) === HttpAcceptHeaders.XML) offered.push('xml');

    const best = offered.length ? req.accepts(offered) : false;

    if (best === 'html') {
      htmlBranch(req, res);
    } else if (best === 'json') {
      jsonBranch(req, res);
    } else if (best === 'xml') {
      xmlResponse(model, options)(req, res);
    } else if (req.accepts('text/plain')) {
      // Client accepts plain text (or the config offers nothing negotiable).
      textResponse(model, options)(req, res);
    } else {
      // Client explicitly asked for a media type the server can't produce.
      jsonResponse(
        { error: { message: 'Not Acceptable', code: HTTP_STATUS_CODE.NOT_ACCEPTABLE } },
        { ...options, StatusCode: HTTP_STATUS_CODE.NOT_ACCEPTABLE },
      )(req, res);
    }
  };
}
