import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { StompQueueClient } from '../../../src/connection.js';
import { retryConnect, STOMP_LOGIN, STOMP_PASSWORD, STOMP_URL } from './env.js';

export class ItConf extends FrameworkConfiguration {
  public static Current: Record<string, unknown> = {};

  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      queue: { routing: {} },
      ...ItConf.Current,
    };
  }
}

export async function useConfig(cfg: Record<string, unknown> = {}): Promise<void> {
  ItConf.Current = cfg;
  DI.clearCache();
  DI.register(ItConf).as(Configuration);
  await DI.resolve(Configuration);
}

const open: StompQueueClient[] = [];
let counter = 0;

export async function client(extra: Record<string, unknown> = {}): Promise<StompQueueClient> {
  const c = await retryConnect(() => DI.resolve(StompQueueClient, [{ host: STOMP_URL, login: STOMP_LOGIN, password: STOMP_PASSWORD, name: `it-${Date.now()}-${++counter}`, ...extra }]));
  open.push(c);
  return c;
}

export async function disposeClients(): Promise<void> {
  for (const c of open.splice(0)) {
    await c.dispose().catch(() => undefined);
  }
}
