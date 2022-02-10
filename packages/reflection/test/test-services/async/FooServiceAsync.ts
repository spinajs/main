import { AsyncModule } from '@spinajs/di';

export class FooServiceAsync extends AsyncModule {
  public Counter = 0;

  public resolveAsync(): Promise<void> {
    this.Counter++;
    return Promise.resolve();
  }
}
