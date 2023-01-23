import { Response, NextFunction } from 'express';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';

@Injectable(ServerMiddleware)
export class RequestId extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public after(): (_req: sRequest, _res: express.Response, _next: express.NextFunction) => void {
    return null;
  }

  public before(): (req: sRequest, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: sRequest, _res: express.Response, next: express.NextFunction) => {
      req.storage.requestId = uuidv4();
      next();
    };
  }
}
