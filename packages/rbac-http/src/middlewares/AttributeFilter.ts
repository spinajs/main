import { RouteMiddleware, IController, IRoute, Response } from '@spinajs/http';
import { Request } from 'express';

/**
 * Filters attributes of db models
 */
export class FilterAttribute extends RouteMiddleware {
  public onResponse(response: Response, route: IRoute): Promise<void> {

     

  }

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  // tslint:disable-next-line: no-empty
  public async onBefore(): Promise<void> {}

  // tslint:disable-next-line: no-empty
  public async onAfter(): Promise<void> {}
}
