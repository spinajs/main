import { AsyncModule } from '@spinajs/di';

export class FooService2 extends AsyncModule {
  public resolveAsync(): Promise<void> {
    return Promise.resolve();
  }
}
