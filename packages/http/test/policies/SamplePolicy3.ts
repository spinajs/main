import { BasePolicy, IController, IRoute } from '../../src';
import { Request } from 'express';
import { Forbidden } from '../@spinajs/exceptions';

export class SamplePolicy3 extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request): Promise<void> {
    throw new Forbidden();
  }
}
