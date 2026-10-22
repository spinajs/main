import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { EmailVerificationStore } from '@spinajs/email-verification';
import '@spinajs/email-verification/register-schema';
import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { RedisEmailVerificationStore } from '../src/index.js';

export class RedisStoreTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      emailVerification: { enabled: true, store: 'RedisEmailVerificationStore', redis: {} },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
    };
  }
}

// ioredis-mock instances share one keyspace per host:port, so rawClient() sees the store's keys.
(RedisEmailVerificationStore.prototype as unknown as { createClient: (this: RedisEmailVerificationStore) => Redis }).createClient = function () {
  return new RedisMock((this as unknown as { clientOptions(): object }).clientOptions());
};

const OWNED: unknown[] = [Configuration, RedisStoreTestConfiguration, EmailVerificationStore, RedisEmailVerificationStore];
let registered = false;
let current: RedisEmailVerificationStore | undefined;

export async function disposeStore(): Promise<void> {
  await current?.dispose();
  current = undefined;
  for (const t of OWNED) DI.uncache(t as never);
}

export async function bootStore(): Promise<RedisEmailVerificationStore> {
  await disposeStore();
  if (!registered) {
    DI.setESMModuleSupport();
    DI.register(RedisStoreTestConfiguration).as(Configuration);
    registered = true;
  }
  await DI.resolve(Configuration);
  current = await DI.resolve(RedisEmailVerificationStore);
  return current;
}

let raw: Redis | undefined;
export const rawClient = (): Redis => (raw ??= new RedisMock());
