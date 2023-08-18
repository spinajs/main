import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { ServerMiddleware, Request as sRequest, Route, Parameter, RouteArgs, IRouteCall, IRouteParameter } from '@spinajs/http';
import * as express from 'express';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    language: string;
  }
}

function extractLanguageFromRequest(req: sRequest, param: string) {
  if (req.query[param]) {
    return req.query[param] as string;
  } else if (req.cookies[param]) {
    return req.cookies[param];
  } else if (req.headers[`x-${param}`]) {
    return req.headers[`x-${param}`] as string;
  }

  return null;
}

export function Lang(allowedLanguages?: string[]) {
  return Route(Parameter('LangArgument', null, { allowedLanguages }));
}

function _validate(param: unknown) {
  if (typeof param !== 'string') throw new InvalidArgument('lang parameter is not string');

  if (param.length < 2 || param.length > 5) throw new InvalidArgument('lang parameter length is invalid');
}

@Injectable()
export class LangArgument extends RouteArgs {
  @Config('intl.queryParameter')
  protected LangQueryParameter: string;

  @Config('intl.defaultLocale')
  protected defaultLocale: string;

  get SupportedType(): string {
    return 'LangArgument';
  }

  public async extract(callData: IRouteCall, param: IRouteParameter, req: sRequest) {
    const lang = extractLanguageFromRequest(req, this.LangQueryParameter);

    if (!lang) {
      return { CallData: callData, Args: this.defaultLocale };
    }

    _validate(lang);

    if (param.Options.allowedLanguages) {
      if ((param.Options.allowedLanguages as string[]).indexOf(lang) === -1) {
        throw new InvalidArgument(`Language not supported, allowed languages are ${param.Options.allowedLanguages.join(',')}`);
      }
    }

    return { CallData: callData, Args: lang };
  }
}

@Injectable(ServerMiddleware)
export class IntHttpMiddleware extends ServerMiddleware {
  @Config('intl.queryParameter')
  protected LangQueryParameter: string;

  @Config('intl.defaultLocale')
  protected defaultLocale: string;

  public before(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      const lang = extractLanguageFromRequest(req, this.LangQueryParameter);

      _validate(lang);

      req.storage.language = lang ?? this.defaultLocale;
      next();
    };
  }
  public after(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return null;
  }
}
