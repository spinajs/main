import { AsyncService } from '@spinajs/di';

export class FooServiceAsync extends AsyncService {
  public Counter = 0;

  public resolve(): Promise<void> {
    this.Counter++;
    return Promise.resolve();
  }
}
