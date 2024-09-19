import { DI } from '@spinajs/di';
import { IQueueConnectionOptions } from '@spinajs/queue';
import { StompQueueClient } from './connection.js';
import { Configuration } from '@spinajs/configuration';

/**
 * Create factory func that sets client-id to connection by app name.
 * We cannot have two connection with same ID, so by default we take app-name
 * with NODE_ENV and then name from options.
 * 
 * This way we can have same  config/connections for shared across multipel apps
 * 
 */
DI.register(async (container, options: IQueueConnectionOptions) => {

  const cfg = container.get(Configuration);
  const appName = cfg.get<string>("app.name","no-app");

  const c = new StompQueueClient({
    ...options,
    clientId: `${appName}-${process.env.NODE_ENV}-${options.name}`,
  });
  await c.resolve();

  return c;
}).as(StompQueueClient);
