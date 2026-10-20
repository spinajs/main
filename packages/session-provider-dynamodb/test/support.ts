import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import { AbsoluteExpiration, DefaultSessionIssuer, SessionExpirationProvider, SessionProvider, SlidingCappedExpiration, SlidingExpiration } from '@spinajs/authn-session';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import type { DynamoDBClientConfig, AttributeValue } from '@aws-sdk/client-dynamodb';
import _ from 'lodash';
import { DynamoDbSessionProvider } from '../src/index.js';
import { FakeDynamo } from './fake-dynamo.js';

let sessionOverrides: Record<string, unknown> = {};

export class DynamoSessionTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.merge(this.Config, {
      authn: {
        session: {
          service: 'DynamoDbSessionProvider',
          expiration: { service: 'SlidingExpiration', ttl: 60 },
          aws: { table: 'rbac_sessions' },
        },
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    });
    _.merge(this.Config, { authn: { session: sessionOverrides } });
  }
}

/** One table shared by every boot, as a real table outlives the process. */
export const fake = new FakeDynamo();

type ClientFactory = (this: DynamoDbSessionProvider, cfg: DynamoDBClientConfig) => DynamoDBClient;
const proto = DynamoDbSessionProvider.prototype as unknown as { createClient: ClientFactory };
const realClient = proto.createClient;
// A config with an endpoint (the opt-in integration run) gets a real client.
proto.createClient = function (cfg: DynamoDBClientConfig) {
  return cfg.endpoint ? realClient.call(this, cfg) : (fake as unknown as DynamoDBClient);
};

/** Types these tests resolve; uncached between boots instead of a blanket DI.clearCache(). */
const OWNED_TYPES: unknown[] = [Configuration, DynamoSessionTestConfiguration, SessionProvider, DynamoDbSessionProvider, SessionExpirationProvider, AbsoluteExpiration, SlidingExpiration, SlidingCappedExpiration, DefaultSessionIssuer, SessionIssuer];

let registered = false;
let current: DynamoDbSessionProvider | undefined;

async function shutdown(): Promise<void> {
  if (current) {
    await current.dispose();
    current = undefined;
  }
  for (const t of OWNED_TYPES) {
    DI.uncache(t as never);
  }
  fake.around = undefined;
  fake.pageSize = 2;
  fake.sent.length = 0;
}

/** The store over the shared fake table (or a real endpoint given in `aws.config`); `session` is merged over `authn.session`. */
export async function bootStore(session: Record<string, unknown> = {}): Promise<DynamoDbSessionProvider> {
  await shutdown();
  if (!registered) {
    // The configuration loader reads every @spinajs package's config; without this it tries their CommonJS builds.
    DI.setESMModuleSupport();
    DI.register(DynamoSessionTestConfiguration).as(Configuration);
    registered = true;
  }

  sessionOverrides = session;
  await DI.resolve(Configuration);
  current = await DI.resolve(DynamoDbSessionProvider);
  return current;
}

export const disposeStore = shutdown;

const internals = (store: DynamoDbSessionProvider) => store as unknown as { DynamoDb: DynamoDBClient; Table: string };

/** Every SessionId in the table, live or not yet removed by TTL. */
export async function storedKeys(store: DynamoDbSessionProvider): Promise<string[]> {
  const { DynamoDb, Table } = internals(store);
  const keys: string[] = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await DynamoDb.send(new ScanCommand({ TableName: Table, ConsistentRead: true, ExclusiveStartKey: start }));
    keys.push(...(page.Items ?? []).map((i) => i.SessionId.S!));
    start = page.LastEvaluatedKey;
  } while (start);
  return keys;
}
