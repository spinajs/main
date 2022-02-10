import { AsyncModule } from '@spinajs/di';

export class FooServiceMixed2 extends AsyncModule {
  public resolveAsync(): Promise<void> {
    return Promise.resolve();
  }
}
