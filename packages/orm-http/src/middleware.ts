import { AsyncService, Constructor } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, ModelBase, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import * as express from 'express';
import { JsonApiIncomingObject } from './interfaces.js';

export abstract class RepositoryMiddleware extends AsyncService {
  public async onGetMiddlewareStart(_resource: any, _req: express.Request): Promise<void> {}
  public async onGetAllMiddlewareStart(_req: express.Request): Promise<void> {}
  public async onUpdateMiddlewareStart(_resource: any, _data: JsonApiIncomingObject, _req: express.Request): Promise<void> {}
  public async onInsertMiddlewareStart(_data: JsonApiIncomingObject, _req: express.Request): Promise<void> {}
  public async onDeleteMiddlewareStart(_resource: any, _req: express.Request): Promise<void> {}

  public onGetMiddlewareQuery(_query: SelectQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}
  public onGetAllMiddlewareQuery(_query: SelectQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}
  public onUpdateMiddlewareQuery(_resource: any, _query: UpdateQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}
  public onInsertMiddlewareQuery(_query: InsertQueryBuilder, _model: Constructor<ModelBase>, _req: express.Request): void {}
  public onDeleteMiddlewareQuery(_query: DeleteQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}

  public onGetMiddlewareResult(jsonData: any, _req: express.Request): any {
    return jsonData;
  }
  public onGetAllMiddlewareResult(jsonData: any, _req: express.Request): any {
    return jsonData;
  }
  public onInsertMiddlewareResult(jsonData: any, _req: express.Request): any {
    return jsonData;
  }

  public onUpdateMiddlewareResult(jsonData: any, _req: express.Request): any {
    return jsonData;
  }

  public onDeleteMiddlewareResult(_req: express.Request): void {}
}
