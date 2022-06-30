import { AsyncModule, Constructor } from '@spinajs/di';
import { DeleteQueryBuilder, InsertQueryBuilder, ModelBase, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import * as express from 'express';

export abstract class RepositoryMiddleware extends AsyncModule {
  public onGetMiddlewareStart(_req: express.Request): void {}
  public onGetAllMiddlewareStart(_req: express.Request): void {}
  public onUpdateMiddlewareStart(_req: express.Request): void {}
  public onInsertMiddlewareStart(_req: express.Request): void {}
  public onDeleteMiddlewareStart(_req: express.Request): void {}

  public onGetMiddlewareQuery(_query: SelectQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}
  public onGetAllMiddlewareQuery(_query: SelectQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}
  public onUpdateMiddlewareQuery(_query: UpdateQueryBuilder<any>, _model: Constructor<ModelBase>, _req: express.Request): void {}
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
