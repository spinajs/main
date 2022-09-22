import { AsyncService } from '@spinajs/di';

export class FooServiceAsync2 extends AsyncService {
  public resolve(): Promise<void> {
    return Promise.resolve();
  }
}
