import { NewInstance } from '@spinajs/di';

@NewInstance()
export class FooServiceAlwaysNew {
  public Counter = 0;

  constructor() {
    this.Counter++;
  }
}
