import { Request, Response, NextFunction } from 'express';
import { ParamsDictionary } from 'express-serve-static-core';
import { ParsedQs } from 'qs';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable(ServerMiddleware)
export class ResponseTime extends ServerMiddleware {
  constructor() {
    super();
    this.Order = -1;
  }

  public after(): (req: express.Request, _res: express.Response, _next: express.NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      const end = new Date();
      const diff = end.getTime() - req.storage.responseStart.getTime();

      req.storage.responseEnd = end;
      req.storage.responseTime = diff;
      res.header('x-response-time', diff.toString());
      next();
    };
  }

  public before(): (_req: Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      req.storage.responseStart = new Date();
      next();
    };
  }
}
