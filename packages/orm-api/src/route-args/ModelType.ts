import { Orm } from '@spinajs/orm';
import { Injectable, Autoinject } from '@spinajs/di';
import { RouteArgs, IRouteCall, IRouteParameter, Parameter, Route, IRoute } from '@spinajs/http';
import * as express from 'express';

export function ModelType() {
    return Route(Parameter('ModelTypeRouteArgs'));
}

@Injectable()
export class ModelTypeRouteArgs extends RouteArgs {
    @Autoinject(Orm)
    protected Orm: Orm;

    public get SupportedType(): string {
        return 'ModelType';
    }

    public async extract(callData: IRouteCall, param: IRouteParameter, req: express.Request, _res: express.Response, _route?: IRoute) {
        return Promise.resolve({
            CallData: callData,
            Args: this.Orm.Models.find((x) => x.name.toLowerCase() === req.params[param.Name].trim().toLowerCase()).type,
        });
    }
}
