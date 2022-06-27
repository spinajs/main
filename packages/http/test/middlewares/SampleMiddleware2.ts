import { BaseMiddleware, IRoute, IController } from '../../src/interfaces';
import { Request } from 'express';

export class SampleMiddleware2 extends BaseMiddleware {
  public static CalledBefore = false;
  public static CalledAfter = false;

  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  // tslint:disable-next-line: no-empty
  public async onBeforeAction(_req: Request): Promise<void> {
    SampleMiddleware2.CalledBefore = true;
  }

  // tslint:disable-next-line: no-empty
  public async onAfterAction(_req: Request): Promise<void> {
    SampleMiddleware2.CalledAfter = true;
  }
}
