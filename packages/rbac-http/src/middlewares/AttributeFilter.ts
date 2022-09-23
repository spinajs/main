import { BaseMiddleware, IController, IRoute } from '@spinajs/http';
import { Request } from 'express';

/**
 * Filters attributes of db models
 */
export class FilterAttribute extends BaseMiddleware {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  // tslint:disable-next-line: no-empty
  public async onBeforeAction(_req: Request): Promise<void> {}

  // tslint:disable-next-line: no-empty
  public async onAfterAction(_req: Request): Promise<void> {}
}
