import { BaseMiddleware, IRoute, IController, Response } from '../../src/interfaces';
import { Request } from 'express';

export class SampleMiddleware2 extends BaseMiddleware {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async onResponse(_: Response): Promise<void> {}

  // tslint:disable-next-line: no-empty
  public async onBeforeAction(_req: Request): Promise<void> {}

  // tslint:disable-next-line: no-empty
  public async onAfterAction(_req: Request): Promise<void> {}
}
