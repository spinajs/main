import { Injectable, NewInstance } from '@spinajs/di';
import { KeyedBackoff } from '@spinajs/util';
import type { KeyedBackoffOptions } from '@spinajs/util';

import type { ThrottleFlow } from '../contracts/throttle.js';

/**
 * One flow's rows of a `MemoryAuthnThrottle`. Register a subclass as `FlowLimiter` to replace the limiter of every flow.
 * A subclass must keep the `(flow, options)` constructor (DI passes resolved constructor dependencies before these
 * arguments) and take its own dependencies through property injection.
 */
@NewInstance()
@Injectable()
export class FlowLimiter extends KeyedBackoff {
  constructor(
    public readonly flow: ThrottleFlow,
    options: KeyedBackoffOptions,
  ) {
    super(options);
  }
}
