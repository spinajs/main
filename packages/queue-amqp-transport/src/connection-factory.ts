import { DI } from '@spinajs/di';
import { IQueueConnectionOptions } from '@spinajs/queue';
import { AmqpQueueClient } from './connection.js';
import { Configuration } from '@spinajs/configuration';

/**
 * Create factory func that sets client-id to connection by app name.
 * We cannot have two connections with the same ID, so by default we take app-name
 * with NODE_ENV and then name from options.
 *
 * This way we can share the same config/connections across multiple apps.
 */
DI.register(async (container, options: IQueueConnectionOptions) => {
  const cfg = container.get(Configuration)!;
  const appName = cfg.get<string>('app.name', 'no-app');
  const env = cfg.get<string>('process.env.APP_ENV', 'development');

  const c = new AmqpQueueClient({
    ...options,
    clientId: `${appName}-${env}-${options.name}`,
  });
  await c.resolve();

  return c;
}).as(AmqpQueueClient);
