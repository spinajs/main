import { AsyncService } from '@spinajs/di';

export class FooServiceMixed2 extends AsyncService {
  public resolve(): Promise<void> {
    return Promise.resolve();
  }
}
