import { Injectable, Singleton } from '@spinajs/di';
import { Clock } from '@spinajs/util';

export abstract class AuthzClock extends Clock {}

@Singleton()
@Injectable(AuthzClock)
export class SystemClock extends AuthzClock {
  now(): Date {
    return new Date();
  }
}
