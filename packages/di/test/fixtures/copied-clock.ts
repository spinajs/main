import { Injectable, Singleton } from '../../src/index.js';

export abstract class CopiedClock {
  public abstract now(): Date;
}

@Singleton()
@Injectable(CopiedClock)
export class SystemCopiedClock extends CopiedClock {
  public now() {
    return new Date();
  }
}
