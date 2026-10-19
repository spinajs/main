import { Injectable } from '@spinajs/di';
import { ConfigurationSource } from '@spinajs/configuration';
import type { Configuration, IConfigLike } from '@spinajs/configuration';

import { AuthzChangeEvent } from './change-bus.js';

/**
 * `authz.bus.topic` becomes the channel of `AuthzChangeEvent` unless `queue.routing` already routes it.
 * Order 2 loads after the file sources (1), so it sees the application's topic and routing.
 */
@Injectable(ConfigurationSource)
export class AuthzBusRouteSource extends ConfigurationSource {
  public get Order(): number {
    return 2;
  }

  public Load(configuration: Configuration): Promise<IConfigLike> {
    const route = ['queue', 'routing', AuthzChangeEvent.name];
    const topic = configuration.get<unknown>(['authz', 'bus', 'topic']);
    const skip = configuration.get<unknown>(route) !== undefined || typeof topic !== 'string' || topic === '';
    return Promise.resolve((skip ? {} : { queue: { routing: { [AuthzChangeEvent.name]: { channel: topic } } } }) as unknown as IConfigLike);
  }
}
