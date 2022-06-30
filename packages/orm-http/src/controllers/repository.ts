import { AccessControl } from '@spinajs/rbac';
import { Constructor, DI, Inject } from '@spinajs/di';
import { BaseController, ArgHydrator, Hydrator, Ok, Del, Post, Query, Forbidden, Req } from '@spinajs/http';
import { BasePath, Get, Param, Body, Patch } from '@spinajs/http';
import { extractModelDescriptor, ModelBase, SelectQueryBuilder, Orm, DeleteQueryBuilder, createQuery, UpdateQueryBuilder, InsertQueryBuilder, IUpdateResult } from '@spinajs/orm';
import _ from 'lodash';
import * as express from 'express';
import { checkRoutePermission } from '@spinajs/rbac-http';
import { RepositoryMiddleware } from './../middleware';

class IncludesHydrator extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    return new Includes(input ? input.split(',').map((x: string) => x.split('.')) : []);
  }
}

class FiltersHydrator extends ArgHydrator {
  public async hydrate(input: any): Promise<any> {
    return new Filters(input ? JSON.parse(input) : []);
  }
}

function dehydrate(model: ModelBase, omit?: string[]) {
  const dObj = {
    type: model.constructor.name,
    id: model.PrimaryKeyValue,
    attributes: model.dehydrate(false, omit),
    relationships: _.mapValues(_.groupBy(model.getFlattenRelationModels(false), '__relationKey__'), (x) => {
      return x.map((xx) => {
        return {
          type: xx.constructor.name,
          id: xx.PrimaryKeyValue,
        };
      });
    }),
  };
  return dObj;
}

function modelToJsonApi(model: ModelBase | ModelBase[]) {
  return {
    data: Array.isArray(model) ? model.map((m) => dehydrate(m)) : dehydrate(model),
    included: Array.isArray(model) ? _.flatMap(model, extractIncluded) : extractIncluded(model),
  };
}

function extractIncluded(model: ModelBase) {
  return model.getFlattenRelationModels(true).map((m) => dehydrate(m));
}

function applyQueryIncludes(includes: Includes, query: SelectQueryBuilder<any>) {
  let currQuery: SelectQueryBuilder<any> = null;
  includes.Param.forEach((i) => {
    currQuery = query;
    i.forEach((ii: string) => {
      currQuery.populate(ii, function () {
        currQuery = this;
      });
    });
  });
}

@Hydrator(IncludesHydrator)
class Includes {
  constructor(public Param: string[][]) {}
}

@Hydrator(FiltersHydrator)
class Filters {
  constructor(public Param: any) {}
}

interface JsonApiIncomingObject {
  data: {
    attributes: {};
  };
}

@BasePath('repository')
@Inject(Orm, AccessControl)
export class Repository extends BaseController {
  protected Middlewares: RepositoryMiddleware[];

  constructor(protected Orm: Orm, protected Ac: AccessControl) {
    super();
  }

  public async resolveAsync(): Promise<void> {
    super.resolveAsync();
    this.Middlewares = await DI.resolve(Array.ofType(RepositoryMiddleware));
  }

  protected getModel(model: string): Constructor<ModelBase> {
    return this.Orm.Models.find((x) => x.name.toLowerCase() === model).type;
  }

  private checkPolicy(model: Constructor<ModelBase>, permission: string, req: express.Request) {
    const p = checkRoutePermission(req, model.name.toLowerCase(), permission);

    if (!p || !p.granted) {
      throw new Forbidden(`current user does not have permission to access resource ${model.name} with ${permission} grant`);
    }
  }

  @Get(':model/:id')
  public async get(@Param() model: string, @Param('id') id: string, @Query() include: Includes, @Query() _filters: Filters, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    this.Middlewares.forEach((m) => m.onGetMiddlewareStart(req));

    const mDesc = extractModelDescriptor(mClass);
    const query = (mClass as any)['where'](mDesc.PrimaryKey, id);

    this.Middlewares.forEach((m) => m.onGetMiddlewareQuery(query, mClass, req));

    applyQueryIncludes(include, query);

    const result = await query.firstOrFail();
    let jResult = modelToJsonApi(result);

    this.Middlewares.forEach((m) => {
      jResult = m.onGetMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  @Get(':model')
  public async getAll(@Param() model: string, @Query() page: number, @Query() perPage: number, @Query() order: string, @Query() orderDirection: string, @Query() include: Includes, @Query() _filters: Filters, @Req() req: express.Request) {
    this.Middlewares.forEach((m) => m.onGetAllMiddlewareStart(req));

    const mClass = this.getModel(model);
    const query = (mClass as any)['all'](page ?? 0, perPage ?? 15);
    if (order) {
      query.order(order, orderDirection ?? 'asc');
    }

    applyQueryIncludes(include, query);

    this.Middlewares.forEach((m) => m.onGetAllMiddlewareQuery(query, mClass, req));

    const result = await query;
    let jResult = modelToJsonApi(result);

    this.Middlewares.forEach((m) => {
      jResult = m.onGetAllMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  @Del(':model/:id')
  public async del(@Param() model: string, @Param() id: string, @Req() req: express.Request) {
    this.Middlewares.forEach((m) => m.onDeleteMiddlewareStart(req));

    const mClass = this.getModel(model);

    const { query, description } = createQuery(mClass, DeleteQueryBuilder);
    query.where(description.PrimaryKey, id);

    this.Middlewares.forEach((m) => m.onDeleteMiddlewareQuery(query, mClass, req));

    await query;

    this.Middlewares.forEach((m) => m.onDeleteMiddlewareResult(req));

    return new Ok();
  }

  @Patch(':model/:id')
  public async patch(@Param() model: string, @Param() id: string, @Body() incoming: JsonApiIncomingObject, @Req() req: express.Request) {
    this.Middlewares.forEach((m) => m.onUpdateMiddlewareStart(req));

    const mClass = this.getModel(model);

    this.checkPolicy(mClass, 'updateAny', req);

    const entity: ModelBase = await (mClass as any)['getOrFail'](id);
    entity.hydrate(incoming.data.attributes);

    const { query, description } = createQuery(mClass, UpdateQueryBuilder);
    query.update(this.dehydrate()).where(description.PrimaryKey, id);

    this.Middlewares.forEach((m) => m.onUpdateMiddlewareQuery(query, mClass, req));

    await query;
    let jResult = modelToJsonApi(entity);
    this.Middlewares.forEach((m) => {
      jResult = m.onUpdateMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  @Post(':model')
  public async insert(@Param() model: string, @Body() incoming: JsonApiIncomingObject, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    const entity: ModelBase = new mClass();
    entity.hydrate(incoming.data.attributes);

    this.Middlewares.forEach((m) => m.onInsertMiddlewareStart(req));

    const { query } = createQuery(mClass, InsertQueryBuilder);
    let pKey = null;
    const iMidleware = {
      afterQuery: (data: IUpdateResult) => {
        pKey = data.LastInsertId;
        return data;
      },
      modelCreation: (): any => null,
      afterHydration: (): any => null,
    };

    query.middleware(iMidleware);
    query.values(this.dehydrate());

    this.Middlewares.forEach((m) => m.onInsertMiddlewareQuery(query, mClass, req));

    await query;

    entity.PrimaryKeyValue = pKey;

    let jResult = modelToJsonApi(entity);
    this.Middlewares.forEach((m) => {
      jResult = m.onInsertMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }
}
