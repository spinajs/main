import { AccessControl } from '@spinajs/rbac';
import { Autoinject, Constructor, DI, Inject } from '@spinajs/di';
import { BaseController, ArgHydrator, Hydrator, Ok, Del, Post, Query, Forbidden, Req } from '@spinajs/http';
import { BasePath, Get, Param, Body, Patch } from '@spinajs/http';
import { extractModelDescriptor, ModelBase, SelectQueryBuilder, Orm, DeleteQueryBuilder, createQuery, UpdateQueryBuilder, InsertQueryBuilder, IUpdateResult, IModelDescriptor } from '@spinajs/orm';
import _ from 'lodash';
import * as express from 'express';
import { checkRoutePermission } from '@spinajs/rbac-http';
import { RepositoryMiddleware } from '../middleware';
import { JsonApiIncomingObject } from '../interfaces';

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

class ModelParamHydrator extends ArgHydrator {
  @Autoinject(Orm)
  protected Orm: Orm;

  public async hydrate(input: string): Promise<any> {
    const model = this.Orm.Models.find((x) => x.name.toLowerCase() === input.toLowerCase()).type;
    const desc = extractModelDescriptor(model);

    const param = new Model();
    param.Descriptor = desc;
    param.Type = model;

    return param;
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

@Hydrator(ModelParamHydrator)
class Model {
  public Type: Constructor<ModelBase>;
  public Descriptor: IModelDescriptor;

  public get SelectQuery() {
    return createQuery(this.constructor, SelectQueryBuilder).query;
  }

  public get InserQuery() {
    return createQuery(this.constructor, InsertQueryBuilder).query;
  }

  public get DeleteQuery() {
    return createQuery(this.constructor, DeleteQueryBuilder).query;
  }

  public get UpdateQueryBuilder() {
    return createQuery(this.constructor, UpdateQueryBuilder).query;
  }
}

const PrimaryKeySchema = {
  $id: 'JsonApiPrimaryKeySchema',
  title: 'Json api primary key schema for id parameter',
  anyOf: [
    { type: 'string', minLength: 0, maxLength: 10 },
    { type: 'number', minimum: 0 },
    { type: 'string', pattern: '^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$', minLength: 32, maxLength: 36 },
  ],
};

const modelSchema = {
  $id: 'JsonApiModelSchema',
  title: 'Json api modele/resource schema',
  type: 'string',
  minLength: 0,
  maxLength: 32,
};

const genericStringSchema = {
  $id: 'JsonApiIncludeSchema',
  title: 'Json api modele/resource schema',
  type: 'string',
  minLength: 0,
  maxLength: 256,
};

@BasePath('repository')
@Inject(Orm, AccessControl)
export class JsonApi extends BaseController {
  protected Middlewares: RepositoryMiddleware[];

  constructor(protected Orm: Orm, protected Ac: AccessControl) {
    super();
  }

  public async resolveAsync(): Promise<void> {
    super.resolveAsync();
    this.Middlewares = await DI.resolve(Array.ofType(RepositoryMiddleware));
  }

  @Get(':model/:id')
  public async get(@Param(modelSchema) model: Model, @Param(PrimaryKeySchema) id: string | number, @Query(genericStringSchema) include: Includes, @Query(genericStringSchema) _filters: Filters, @Req() req: express.Request) {
    await Promise.all(this.Middlewares.map((m) => m.onGetMiddlewareStart(id, req)));

    const query = model.SelectQuery.where(model.Descriptor.PrimaryKey, id);

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
    await Promise.all(this.Middlewares.map((m) => m.onGetAllMiddlewareStart(req)));

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
    await Promise.all(this.Middlewares.map((m) => m.onDeleteMiddlewareStart(id, req)));

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
    await Promise.all(this.Middlewares.map((m) => m.onUpdateMiddlewareStart(id, incoming, req)));

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
    await Promise.all(this.Middlewares.map((m) => m.onInsertMiddlewareStart(incoming, req)));

    const mClass = this.getModel(model);
    const entity: ModelBase = new mClass();
    entity.hydrate(incoming.data.attributes);

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
