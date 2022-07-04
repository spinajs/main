import { Autoinject, Constructor, DI, Inject } from '@spinajs/di';
import { BaseController, ArgHydrator, Hydrator, Ok, Del, Post, Query, Req } from '@spinajs/http';
import { BasePath, Get, Param, Body, Patch } from '@spinajs/http';
import { extractModelDescriptor, ModelBase, SelectQueryBuilder, Orm, DeleteQueryBuilder, createQuery, UpdateQueryBuilder, InsertQueryBuilder, IUpdateResult, IModelDescriptor, RelationType } from '@spinajs/orm';
import _ from 'lodash';
import * as express from 'express';
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
    const model = this.Orm.Models.find((x) => x.name.toLowerCase() === input.toLowerCase());
    if (!model) {
      return null;
    }

    const desc = extractModelDescriptor(model.type);

    const param = new Model();
    param.Descriptor = desc;
    param.Type = model.type;

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
    return createQuery(this.Type, SelectQueryBuilder).query as SelectQueryBuilder<ModelBase>;
  }

  public get InserQuery() {
    return createQuery(this.Type, InsertQueryBuilder).query;
  }

  public get DeleteQuery() {
    return createQuery(this.Type, DeleteQueryBuilder).query;
  }

  public get UpdateQueryBuilder() {
    return createQuery(this.Type, UpdateQueryBuilder).query;
  }
}

const PrimaryKeySchema = {
  $id: 'JsonApiPrimaryKeySchema',
  title: 'Json api primary key schema for id parameter',
  anyOf: [
    { type: 'string', minLength: 0, maxLength: 16 },
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
@Inject(Orm)
export class JsonApi extends BaseController {
  protected Middlewares: RepositoryMiddleware[];

  constructor(protected Orm: Orm) {
    super();
  }

  public async resolveAsync(): Promise<void> {
    super.resolveAsync();
    this.Middlewares = await DI.resolve(Array.ofType(RepositoryMiddleware));
  }

  @Get(':model/:id', {
    model: modelSchema,
    id: PrimaryKeySchema,
    include: genericStringSchema,
    _filters: genericStringSchema,
  })
  public async get(@Param() model: Model, @Param() id: string | number, @Query() include: Includes, @Query() _filters: Filters, @Req() req: express.Request) {
    await Promise.all(this.Middlewares.map((m) => m.onGetMiddlewareStart(id, req)));

    const query = model.SelectQuery.select('*').where(model.Descriptor.PrimaryKey, id);
    applyQueryIncludes(include, query);

    this.Middlewares.forEach((m) => m.onGetMiddlewareQuery(query, model.Type, req));

    const result = await query.firstOrFail();
    let jResult = modelToJsonApi(result);

    this.Middlewares.forEach((m) => {
      jResult = m.onGetMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  @Get(':model', {
    model: modelSchema,
    include: genericStringSchema,
    _filters: genericStringSchema,
  })
  public async getAll(@Param() model: Model, @Query() page: number, @Query() perPage: number, @Query() order: string, @Query() orderDirection: 'ASC' | 'DESC', @Query() include: Includes, @Query() _filters: Filters, @Req() req: express.Request) {
    await Promise.all(this.Middlewares.map((m) => m.onGetAllMiddlewareStart(req)));

    const query = model.SelectQuery.select('*')
      .take(perPage)
      .skip(page * perPage);
    if (order) {
      query.order(order, orderDirection ?? 'ASC');
    }

    applyQueryIncludes(include, query);

    this.Middlewares.forEach((m) => m.onGetAllMiddlewareQuery(query, model.Type, req));

    const result = await query;
    let jResult = modelToJsonApi(result);

    this.Middlewares.forEach((m) => {
      jResult = m.onGetAllMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  @Del(':model/:id', {
    model: modelSchema,
    id: PrimaryKeySchema,
  })
  public async del(@Param() model: Model, @Param() id: string | number, @Req() req: express.Request) {
    await Promise.all(this.Middlewares.map((m) => m.onDeleteMiddlewareStart(id, req)));

    const query = model.DeleteQuery.where(model.Descriptor.PrimaryKey, id);
    this.Middlewares.forEach((m) => m.onDeleteMiddlewareQuery(query, model.Type, req));

    await query;
    this.Middlewares.forEach((m) => m.onDeleteMiddlewareResult(req));

    return new Ok();
  }

  @Patch(':model/:id', {
    model: modelSchema,
    id: PrimaryKeySchema,
  })
  public async patch(@Param() model: Model, @Param() id: string | number, @Body() incoming: JsonApiIncomingObject, @Req() req: express.Request) {
    await Promise.all(this.Middlewares.map((m) => m.onUpdateMiddlewareStart(id, incoming, req)));

    const entity: ModelBase = await model.SelectQuery.where(model.Descriptor.PrimaryKey, id).firstOrFail();

    if (incoming.data.attributes) {
      const columns = Object.keys(incoming.data.attributes).filter((x) => model.Descriptor.Columns.find((c) => c.Name === x));

      // create query, so we can pass to middleware
      const query = model.UpdateQueryBuilder.update(_.pick(incoming.data.attributes, columns)).where(entity.PrimaryKeyName, entity.PrimaryKeyValue);

      this.Middlewares.forEach((m) => m.onUpdateMiddlewareQuery(entity.PrimaryKeyValue, query, model.Type, req));
      await query;
    }

    await this.updateRelations(incoming, model, entity);

    let jResult = modelToJsonApi(entity);
    this.Middlewares.forEach((m) => {
      jResult = m.onUpdateMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  @Post(':model', {
    model: modelSchema,
  })
  public async insert(@Param() model: Model, @Body() incoming: JsonApiIncomingObject, @Req() req: express.Request) {
    await Promise.all(this.Middlewares.map((m) => m.onInsertMiddlewareStart(incoming, req)));

    const entity: ModelBase = new model.Type();
    entity.hydrate(incoming.data.attributes);
    let pKey = null;
    const iMidleware = {
      afterQuery: (data: IUpdateResult) => {
        pKey = data.LastInsertId;
        return data;
      },
      modelCreation: (): any => null,
      afterHydration: (): any => null,
    };

    const query = model.InserQuery.middleware(iMidleware).values(entity.dehydrate());

    this.Middlewares.forEach((m) => m.onInsertMiddlewareQuery(query, model.Type, req));

    await query;

    entity.PrimaryKeyValue = pKey;

    await this.updateRelations(incoming, model, entity);

    let jResult = modelToJsonApi(entity);
    this.Middlewares.forEach((m) => {
      jResult = m.onInsertMiddlewareResult(jResult, req);
    });

    return new Ok(jResult);
  }

  protected async updateRelations(incoming: JsonApiIncomingObject, model: Model, entity: ModelBase) {
    if (incoming.data.relationships) {
      const relations = Object.keys(incoming.data.relationships)
        .filter((x) => [...model.Descriptor.Relations.keys()].find((r) => r === x))
        .map((r) => model.Descriptor.Relations.get(r));

      for (const rel of relations) {
        switch (rel.Type) {
          case RelationType.One:
            await model.UpdateQueryBuilder.update({
              [rel.ForeignKey]: incoming.data.relationships[rel.Name].id,
            }).where(entity.PrimaryKeyName, entity.PrimaryKeyValue);
            break;
          case RelationType.Many:
            const rQuery = createQuery(rel.TargetModel, UpdateQueryBuilder).query;
            await rQuery
              .update({
                [rel.ForeignKey]: entity.PrimaryKeyValue,
              })
              .whereIn(
                rel.PrimaryKey,
                incoming.data.relationships[rel.Name].map((x: any) => x.id),
              );
            break;
        }
      }
    }
  }
}
