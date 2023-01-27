import { BasePolicy, IController, IRoute } from '../../src/index.js';
import { Request } from 'express';
import { Forbidden } from '../../../exceptions/lib/index.js';

export class SamplePolicy3 extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request): Promise<void> {
    throw new Forbidden();
  }
}
