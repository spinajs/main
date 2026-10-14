import { Injectable, NewInstance } from '@spinajs/di';
import { KeyedBackoff } from '@spinajs/util';
import type { KeyedBackoffOptions } from '@spinajs/util';

import type { ThrottleFlow } from '../contracts/throttle.js';

/** One flow's rows of a `MemoryAuthnThrottle`. Register a subclass as `FlowLimiter` to replace the limiter of every flow. */
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
