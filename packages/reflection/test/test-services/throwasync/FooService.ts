import { AsyncService } from '@spinajs/di';

export class FooService22 extends AsyncService {
  public resolve(): Promise<void> {
    return Promise.resolve();
  }
}
