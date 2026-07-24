import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import '../src/index.js';
import { DynamoDbSessionProvider } from '../src/index.js';
import { UserSession as Session } from '@spinajs/rbac';
import { DateTime } from 'luxon';
import { runSessionProviderConformance, IConformanceExpiration } from '../../rbac/test/conformance/session-provider-conformance.js';
import { GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand, DescribeTableCommand, CreateTableCommand, UpdateTimeToLiveCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';

chai.use(chaiAsPromised);
const expect = chai.expect;

// Current expiration strategy config the ConnectionConf will publish. The
// conformance factory swaps this per strategy before (re)resolving DI.
let CURRENT_EXPIRATION: IConformanceExpiration = { service: 'SlidingExpiration', ttl: 60 };

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
        rbac: {
          session: {
            aws: {
              table: 'rbac_sessions',
            },
            expiration: CURRENT_EXPIRATION,
          },
        },
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '${datetime} ${level} ${message} ${error} duration: ${duration} (${logger})',
            },
          ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
        },
      },
      mergeArrays,
    );
  }
}

/**
 * Stateful in-memory fake of the AWS SDK v3 `DynamoDBClient`. Keyed by
 * SessionId, storing raw DynamoDB attribute-value item maps. Exposes a single
 * `send(command)` method that dispatches on the command type (the v3 call style)
 * instead of v2's named methods. Attribute-value shapes (`{ S }`, `{ N }`) are
 * identical between v2 and v3, so item marshalling is unchanged. Table-admin
 * commands are honored just enough (`DeleteTableCommand` clears the store) so
 * `truncate()` works without an external service.
 */
export function createFakeDynamo() {
  const store = new Map<string, any>();

  return {
    send(command: any): Promise<any> {
      // table admin — no-ops, except DeleteTableCommand which clears the store
      if (command instanceof DescribeTableCommand || command instanceof CreateTableCommand || command instanceof UpdateTimeToLiveCommand) {
        return Promise.resolve({});
      }

      if (command instanceof DeleteTableCommand) {
        store.clear();
        return Promise.resolve({});
      }

      if (command instanceof GetItemCommand) {
        const input = command.input as any;
        return Promise.resolve({ Item: store.get(input.Key.SessionId.S) });
      }

      if (command instanceof PutItemCommand) {
        const input = command.input as any;
        store.set(input.Item.SessionId.S, input.Item);
        return Promise.resolve({});
      }

      if (command instanceof DeleteItemCommand) {
        const input = command.input as any;
        store.delete(input.Key.SessionId.S);
        return Promise.resolve({});
      }

      if (command instanceof ScanCommand) {
        const input = command.input as any;
        let items = Array.from(store.values());
        const vals = input.ExpressionAttributeValues;

        // honor the provider's `UserId = :uid` server-side filter
        if (input.FilterExpression && vals && vals[':uid']) {
          const uid = vals[':uid'].N;
          items = items.filter((it) => it.UserId && it.UserId.N === uid);
        }

        return Promise.resolve({ Items: items });
      }

      return Promise.reject(new Error(`Fake DynamoDBClient received an unsupported command: ${command?.constructor?.name}`));
    },
  };
}

async function makeProvider(expiration: IConformanceExpiration) {
  CURRENT_EXPIRATION = expiration;

  DI.clearCache();
  DI.register(ConnectionConf).as(Configuration);
  await DI.resolve(Configuration);

  // Bypass the real resolve() table bootstrap (it would create a live
  // AWS.DynamoDB and hit an endpoint). We swap in the stateful fake instead.
  const orig = DynamoDbSessionProvider.prototype.resolve;
  DynamoDbSessionProvider.prototype.resolve = async function () {};
  const provider = await DI.resolve(DynamoDbSessionProvider);
  DynamoDbSessionProvider.prototype.resolve = orig;

  (provider as any).DynamoDb = createFakeDynamo();

  return provider;
}

describe('dynamodb session provider', function () {
  this.timeout(15000);

  // Full provider contract under sliding / absolute / capped strategies (E — reused kit).
  runSessionProviderConformance(makeProvider);

  describe('DynamoDbSessionProvider regressions', () => {
    it('deleteByUser removes only the target user\'s sessions, keyed on numeric UserId (B4)', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const u1 = new Session({
        SessionId: 'b4-user1',
        UserId: 1,
        Expiration: DateTime.now().plus({ minutes: 10 }),
        Data: new Map<string, unknown>([['User', 'uuid-1']]),
      });
      const u2 = new Session({
        SessionId: 'b4-user2',
        UserId: 2,
        Expiration: DateTime.now().plus({ minutes: 10 }),
        Data: new Map<string, unknown>([['User', 'uuid-2']]),
      });

      await store.save(u1);
      await store.save(u2);

      await store.deleteByUser(1);

      expect(await store.restore('b4-user1'), 'u1 session should be gone').to.be.null;
      expect(await store.restore('b4-user2'), 'u2 session must survive').to.not.be.null;
    });

    it('persists UserId as a top-level numeric DynamoDB attribute', async () => {
      const store = await makeProvider({ service: 'SlidingExpiration', ttl: 60 });
      await store.truncate();

      const s = new Session({
        SessionId: 'uid-attr',
        UserId: 77,
        Expiration: DateTime.now().plus({ minutes: 10 }),
        Data: new Map<string, unknown>(),
      });

      await store.save(s);
      const restored = await store.restore('uid-attr');

      expect(restored).to.not.be.null;
      expect(restored!.UserId).to.equal(77);
    });
  });
});
