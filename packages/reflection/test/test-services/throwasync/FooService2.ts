import { AsyncService } from '@spinajs/di';

export class FooService2 extends AsyncService {
  public resolve(): Promise<void> {
    return Promise.resolve();
  }
}
