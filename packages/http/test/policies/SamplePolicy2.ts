import { BasePolicy, IController, IRoute } from '../../src/index.js';
import { Request } from 'express';

export class SamplePolicy2 extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(_req: Request): Promise<void> {}
}
