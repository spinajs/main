import { RouteMiddleware, IController, IRoute } from '@spinajs/http';

/**
 * Filters attributes of db models
 */
export class FilterAttribute extends RouteMiddleware {
  public async onResponse(): Promise<void> {}

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  // tslint:disable-next-line: no-empty
  public async onBefore(): Promise<void> {}

  // tslint:disable-next-line: no-empty
  public async onAfter(): Promise<void> {}
}
