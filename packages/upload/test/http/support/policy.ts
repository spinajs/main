import { Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import type { IController, IRoute, Request } from '@spinajs/http';

/**
 * A class policy on top of authorize, standing in for an app's `@Access`: `x-test-policy: deny` refuses before the action.
 * `@Access` itself needs the authz test host, which would swap this suite's shared Configuration.
 */
export class HeaderPolicy extends BasePolicy {
  public isEnabled(_action: IRoute, _instance: IController): boolean {
    return true;
  }

  public async execute(req: Request): Promise<void> {
    if (req.headers['x-test-policy'] === 'deny') throw new Forbidden('refused by the test policy');
  }
}
