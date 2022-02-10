import { AsyncModule } from '@spinajs/di';

export class FooService22 extends AsyncModule {
  public resolveAsync(): Promise<void> {
    return Promise.resolve();
  }
}
