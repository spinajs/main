import { Injectable, Singleton } from '@spinajs/di';

export abstract class AuthzClock {
  abstract now(): Date;
}

@Singleton()
@Injectable(AuthzClock)
export class SystemClock extends AuthzClock {
  now(): Date {
    return new Date();
  }
}
