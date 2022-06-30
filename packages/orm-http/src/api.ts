import { Autoinject, Bootstrapper, Constructor, Container, IContainer, Injectable } from '@spinajs/di';
import { HttpServer, Ok, ServerError } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log';
import { extractModelDescriptor, ModelBase, Orm, SelectQueryBuilder } from '@spinajs/orm';
import * as express from 'express';
import _ from 'lodash';

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

interface IApiRouteParamaters {
  id?: any;
  includes?: string[][];
  filters?: any;
  order?: string;
  orderDirection?: string;
  page?: number;
  perPage?: number;
}

@Injectable(Bootstrapper)
export class OrmJsonApiBootsrapper extends Bootstrapper {
  @Logger('http')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  @Autoinject()
  protected Server: HttpServer;

  @Autoinject()
  protected Orm: Orm;

  protected Router: express.Router;

  constructor() {
    super();
    this.Router = express.Router();
  }

  public bootstrap(): void | Promise<void> {
    this.Orm.Models.forEach((model) => {
      this.addGet(model.type);
      this.addGetAll(model.type);
      this.addUpdate(model.type);
      this.addInsert(model.type);
      this.addDelete(model.type);
    });

    this.Server.use(this.Router);
  }

  protected extractRouteParameters(req: express.Request): IApiRouteParamaters {
    const id = req.params['id'];
    const page = Number(req.query['page']);
    const perPage = Number(req.query['perPage']);
    const order = req.query['order'] as string;
    const orderDirection = req.query['orderDirection'] as string;
    const includes = req.query['include']
      ? (req.query['include'] as string).split(',').map((i) => {
          return i.split('.');
        })
      : [];
    const filters = req.query['filter'] ? JSON.parse(req.query['filter'] as string) : [];

    return {
      id,
      page,
      perPage,
      order,
      orderDirection,
      includes,
      filters,
    };
  }

  protected addGet(model: Constructor<ModelBase>) {
    const path = `/repository/${model.name.toLowerCase()}/:id`;

    this.Router.get(path, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const params = this.extractRouteParameters(req);
        const desc = extractModelDescriptor(model);
        const query = (model as any)['where'](desc.PrimaryKey, params.id);

        let currQuery: SelectQueryBuilder<any> = null;
        params.includes.forEach((i) => {
          currQuery = query;

          i.forEach((ii) => {
            currQuery.populate(ii, function () {
              currQuery = this;
            });
          });
        });

        const result = await query.firstOrFail();

        res.locals.response = new Ok(modelToJsonApi(result));
        next();
      } catch (err) {
        res.locals.response = new ServerError({
          error: {
            message: err.message,
            err: err,
          },
        });
        next(err);
      }
    });

    this.Log.trace(`API GET:${path}`);
  }

  protected addGetAll(model: Constructor<ModelBase>) {
    const path = `/repository/${model.name.toLowerCase()}`;

    this.Router.get(path, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const params = this.extractRouteParameters(req);
        const query = (model as any)['all'](params.page ?? 0, params.perPage ?? 15);

        if (params.order) {
          query.order(params.order, params.orderDirection ?? 'asc');
        }

        let currQuery: SelectQueryBuilder<any> = null;
        params.includes.forEach((i) => {
          currQuery = query;

          i.forEach((ii) => {
            currQuery.populate(ii, function () {
              currQuery = this;
            });
          });
        });

        const result = await query;

        res.locals.response = new Ok(modelToJsonApi(result));
        next();
      } catch (err) {
        res.locals.response = new ServerError({
          error: {
            message: err.message,
            err: err,
          },
        });

        next(err);
      }
    });

    this.Log.trace(`API DEL:${path}`);
  }

  protected addUpdate(model: Constructor<ModelBase>) {
    const path = `/repository/${model.name.toLowerCase()}/:id`;

    this.Router.put(path, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const desc = extractModelDescriptor(model);
        const param = req.params['id'];
        const entity = new model({ [desc.PrimaryKey]: param, ...req.body });
        let result = null;

        if (param) {
          await (model as any)['update'](entity);
        } else {
          await (model as any)['insert'](entity);
        }

        res.locals.response = new Ok(result);
        next();
      } catch (err) {
        res.locals.response = new ServerError({
          error: {
            message: err.message,
            err: err,
          },
        });

        next(err);
      }
    });

    this.Log.trace(`API PUT:${path}`);
  }
  protected addInsert(model: Constructor<ModelBase>) {
    const path = `/repository/${model.name.toLowerCase()}`;

    this.Router.post(path, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const entity = new model(req.body);
        await (model as any)['insert'](entity);
        res.locals.response = new Ok(entity);
        next();
      } catch (err) {
        res.locals.response = new ServerError({
          error: {
            message: err.message,
            err: err,
          },
        });

        next(err);
      }
    });

    this.Log.trace(`API POST:${path}`);
  }
  protected addDelete(model: Constructor<ModelBase>) {
    const path = `repository/${model.constructor.name.toLowerCase()}/:id`;

    this.Router.delete(path, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const param = req.params['id'];

        await (model as any)['destroy'](param);
        res.locals.response = new Ok();
        next();
      } catch (err) {
        res.locals.response = new ServerError({
          error: {
            message: err.message,
            err: err,
          },
        });

        next(err);
      }
    });

    this.Log.trace(`API DEL:${path}`);
  }

  // protected relationAddGet(model: ModelBase, path: string) {}
  // protected relationAddGetAll(model: ModelBase, path: string) {}
  // protected relationAddUpdate(model: ModelBase, path: string) {}
  // protected relationAddInsert(model: ModelBase, path: string) {}
  // protected relationAddDelete(model: ModelBase, path: string) {}
}
