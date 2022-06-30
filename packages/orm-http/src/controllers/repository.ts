import { AccessControl } from '@spinajs/rbac';
import { Constructor } from '@spinajs/di';
import { BaseController, ArgHydrator, Hydrator, Ok, Del, Post, Query, Forbidden, Req } from '@spinajs/http';
import { BasePath, Get, Param, Body, Patch } from '@spinajs/http';
import { extractModelDescriptor, ModelBase, SelectQueryBuilder, Orm } from '@spinajs/orm';
import _ from 'lodash';
import * as express from 'express';
import { checkRoutePermission } from '@spinajs/rbac-http';

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
export class Repository extends BaseController {
  constructor(protected Orm: Orm, protected Ac: AccessControl) {
    super();
  }

  protected getModel(model: string): Constructor<ModelBase> {
    return this.Orm.Models.find((x) => x.name === model).type;
  }

  private checkPolicy(model: Constructor<ModelBase>, permission: string, req: express.Request) {
    const p = checkRoutePermission(req, model.name.toLowerCase(), permission);

    if (!p.granted) {
      throw new Forbidden(`current user does not have permission to access resource ${model.name} with ${permission} grant`);
    }
  }

  @Get('/:model/:id')
  public async get(@Param() model: string, @Param('id') id: string, @Query() includes: Includes, @Query() _filters: Filters, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    this.checkPolicy(mClass, 'readAny', req);

    const mDesc = extractModelDescriptor(mClass);
    const query = (mClass as any)['where'](mDesc.PrimaryKey, id);

    applyQueryIncludes(includes, query);

    const result = await query.firstOrFail();

    return new Ok(modelToJsonApi(result));
  }

  @Get('/:model')
  public async getAll(@Param() model: string, @Query() page: number, @Query() perPage: number, @Query() order: string, @Query() orderDirection: string, @Query() includes: Includes, @Query() _filters: Filters, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    this.checkPolicy(mClass, 'readAny', req);

    const query = (mClass as any)['all'](page ?? 0, perPage ?? 15);
    if (order) {
      query.order(order, orderDirection ?? 'asc');
    }

    applyQueryIncludes(includes, query);

    const result = await query;

    return new Ok(modelToJsonApi(result));
  }

  @Del('/:model/:id')
  public async del(@Param() model: string, @Param() id: string, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    this.checkPolicy(mClass, 'deleteAny', req);

    await (mClass as any)['destroy'](id);
    return new Ok();
  }

  @Patch('/:model/:id')
  public async patch(@Param() model: string, @Param() id: string, @Body() incoming: JsonApiIncomingObject, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    this.checkPolicy(mClass, 'updateAny', req);

    const entity: ModelBase = await (mClass as any)['getOrFail'](id);
    entity.hydrate(incoming.data.attributes);

    await entity.update();

    return new Ok(entity.dehydrate());
  }

  @Post('/:model')
  public async insert(@Param() model: string, @Body() incoming: JsonApiIncomingObject, @Req() req: express.Request) {
    const mClass = this.getModel(model);

    this.checkPolicy(mClass, 'createAny', req);

    const entity: ModelBase = new mClass();
    entity.hydrate(incoming.data.attributes);
    await entity.insert();
    return new Ok(entity.dehydrate());
  }
}
