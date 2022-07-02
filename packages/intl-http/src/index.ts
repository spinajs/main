import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { ServerMiddleware, Request as sRequest } from '@spinajs/http';
import * as express from 'express';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    language: string;
  }
}

@Injectable(ServerMiddleware)
export class IntHttpMiddleware extends ServerMiddleware {
  @Config('intl.queryParameter')
  protected LangQueryParameter: string;

  public before(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      if (req.query[this.LangQueryParameter]) {
        req.storage.language = req.query[this.LangQueryParameter];
      } else if (req.cookies[this.LangQueryParameter]) {
        req.storage.language = req.cookies[this.LangQueryParameter];
      } else if (req.headers[`x-${this.LangQueryParameter}`]) {
        req.storage.language = req.headers[`x-${this.LangQueryParameter}`] as string;
      }

      next();
    };
  }
  public after(): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
    return null;
  }
}
