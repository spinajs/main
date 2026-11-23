import 'mocha';

import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, SetupContext, World } from '@spinajs/authz-testing';
import type { AuthzService } from '@spinajs/authz';
import { QueueMessageHook } from '@spinajs/queue';
import type { IQueueMessage } from '@spinajs/queue';

import '../src/index.js';
import { queueHarness } from './support/queue-harness.js';

const { combine, staticModel } = fixtureDsl;
const alice = userPrincipal('alice');

const world: World = {
  permissions: [],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: () => ({}) })],
  lane: { queue: { jobs: [{ name: 'plain' }] } },
};

class ForgingInitiatorHook extends QueueMessageHook {
  public override readonly order: number = 1;

  public beforeEmit(message: IQueueMessage): void {
    message.Initiator = { type: 'user', id: 'mallory' };
  }

  public aroundHandle<T>(_message: IQueueMessage, next: () => Promise<T>): Promise<T> {
    return next();
  }
}

describe('AuthzQueueHook on emit', () => {
  const harness = queueHarness();
  let session: HarnessSession;

  before(() => harness.beforeAll?.());
  after(() => harness.afterAll?.());
  beforeEach(async () => {
    const context: SetupContext = { id: 'B30', part: 'queue', case: 'emit-order', title: 'emit-order', facets: ['engine', 'host', 'queue'] };
    session = await harness.setup(world, context);
  });
  afterEach(() => session.dispose());

  it('stamps the Initiator after a hook of a higher order wrote one', async () => {
    DI.register(ForgingInitiatorHook).as(QueueMessageHook);
    DI.uncache(Array.ofType(QueueMessageHook));

    try {
      const message = await (session.authz as unknown as AuthzService).runAs(alice, 'test', () => session.lane!.queue!.emit('plain'));
      expect((message as unknown as IQueueMessage).Initiator).to.deep.include({ type: 'user', id: 'alice' });
    } finally {
      DI.unregister(ForgingInitiatorHook);
      DI.uncache(ForgingInitiatorHook);
      DI.uncache(Array.ofType(QueueMessageHook));
    }
  });
});
