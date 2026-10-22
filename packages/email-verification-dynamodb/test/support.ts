import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { EmailVerificationStore } from '@spinajs/email-verification';
import '@spinajs/email-verification/register-schema';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { FakeDynamo } from '../../session-provider-dynamodb/test/fake-dynamo.js';
import { DynamoDbEmailVerificationStore } from '../src/index.js';

let dynamodbOptions: Record<string, unknown> = {};

export class DynamoStoreTestConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      emailVerification: { enabled: true, store: 'DynamoDbEmailVerificationStore', dynamodb: { table: 'ev-test', ...dynamodbOptions } },
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] },
    };
  }
}

export let fake = new FakeDynamo('pk');

(DynamoDbEmailVerificationStore.prototype as unknown as { createClient: () => DynamoDBClient }).createClient = () => fake as unknown as DynamoDBClient;

const OWNED: unknown[] = [Configuration, DynamoStoreTestConfiguration, EmailVerificationStore, DynamoDbEmailVerificationStore];
let registered = false;
let current: DynamoDbEmailVerificationStore | undefined;

export async function disposeStore(): Promise<void> {
  await current?.dispose();
  current = undefined;
  for (const t of OWNED) DI.uncache(t as never);
}

/** A store over a fresh fake table; `options` is merged over `emailVerification.dynamodb`, `prepare` sets the fake up before boot. */
export async function bootStore(options: Record<string, unknown> = {}, prepare?: (fake: FakeDynamo) => void): Promise<DynamoDbEmailVerificationStore> {
  await disposeStore();
  fake = new FakeDynamo('pk');
  prepare?.(fake);
  if (!registered) {
    DI.setESMModuleSupport();
    DI.register(DynamoStoreTestConfiguration).as(Configuration);
    registered = true;
  }
  dynamodbOptions = options;
  await DI.resolve(Configuration);
  current = await DI.resolve(DynamoDbEmailVerificationStore);
  return current;
}

/** Records the store logger's warnings; the `@Logger` getter caches one logger for every store instance. */
export function captureWarnings(store: DynamoDbEmailVerificationStore): { messages: string[]; restore: () => void } {
  const log = (store as unknown as { Log: { warn: (...args: unknown[]) => void } }).Log;
  const original = log.warn;
  const messages: string[] = [];
  log.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  };
  return { messages, restore: () => (log.warn = original) };
}
