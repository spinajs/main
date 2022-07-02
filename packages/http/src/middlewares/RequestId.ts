import { Request, Response, NextFunction } from 'express';
import { ParamsDictionary } from 'express-serve-static-core';
import { ParsedQs } from 'qs';
import { ServerMiddleware } from '../interfaces';
import * as express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';

@Injectable(ServerMiddleware)
export class RequestId extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public after(): (_req: express.Request, _res: express.Response, _next: express.NextFunction) => void {
    return null;
  }

  public before(): (req: Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.storage.requestId = uuidv4();
      next();
    };
  }
}
