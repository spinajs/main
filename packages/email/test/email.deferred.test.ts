import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, NewInstance, PerInstanceCheck } from '@spinajs/di';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { QueueService, QueueClient, IQueueMessage, QueueMessage, JobModel, QueueMessageType } from '@spinajs/queue';
import '@spinajs/orm-sqlite';
import { MigrationTransactionMode, Orm } from '@spinajs/orm';

import { EmailService, EmailSender, EmailConnectionOptions, IEmail, EmailSend } from '../src/index.js';

chai.use(chaiAsPromised);

/** Message the fake SMTP sender rejects with when toggled to fail. */
const FAKE_ERROR_MESSAGE = 'fake smtp failure';

/**
 * Broker-free QueueClient stub ( copied from packages/queue/test/tracking.test.ts ).
 * `emit` stashes the wire message; `deliver` replays a message to every registered
 * `subscribe` callback so we can drive `consume` deterministically ( including a
 * redelivery of the SAME wire message with the SAME JobId ).
 */
@PerInstanceCheck()
@Injectable(QueueClient)
class TestQueueClient extends QueueClient {
  /** when true, emitting an EVENT-type message throws ( simulates a broker publish failure ). */
  public static FailEventEmit = false;

  public Emitted: IQueueMessage[] = [];
  private Callbacks: Array<(e: IQueueMessage) => Promise<void>> = [];

  public async emit(event: IQueueMessage): Promise<void> {
    if (TestQueueClient.FailEventEmit && event.Type === QueueMessageType.Event) {
      throw new Error('broker publish failed');
    }
    this.Emitted.push(event);
  }

  public async subscribe(_channel: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>): Promise<void> {
    this.Callbacks.push(callback);
  }

  public unsubscribe(): void {
    this.Callbacks = [];
  }

  /** test helper: replay a wire message to all subscribers ( simulates a broker delivery ) */
  public async deliver(event: IQueueMessage): Promise<void> {
    for (const cb of this.Callbacks) {
      await cb(event);
    }
  }
}

/**
 * Fake email sender registered by `service: 'FakeEmailSender'`. Because senders are
 * `@NewInstance()`, the failure toggle and the call counter live at module level.
 */
let FAKE_SHOULD_FAIL = false;
let FAKE_SEND_CALLS = 0;

@Injectable(EmailSender)
@NewInstance()
class FakeEmailSender extends EmailSender {
  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public async send(_email: IEmail): Promise<void> {
    FAKE_SEND_CALLS++;
    if (FAKE_SHOULD_FAIL) {
      throw new Error(FAKE_ERROR_MESSAGE);
    }
  }
}

// FakeEmailSender is wired purely through DI ( config `service: 'FakeEmailSender'` ); keep an
// explicit reference so `noUnusedLocals` doesn't flag the decorator-only registration.
void FakeEmailSender;

class EmailDeferredConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      db: {
        DefaultConnection: 'queue',
        Connections: [
          {
            Driver: 'orm-driver-sqlite',
            Filename: ':memory:',
            Name: 'queue',
            Migration: {
              OnStartup: true,
              Table: 'orm_migrations',
              Transaction: {
                Mode: MigrationTransactionMode.PerMigration,
              },
            },
          },
        ],
      },
      email: {
        retry: { count: 3 },
        connections: [{ name: 'test', service: 'FakeEmailSender' }],
      },
      queue: {
        default: 'test-queue',
        routing: {},
        connections: [
          {
            service: 'TestQueueClient',
            name: 'test-queue',
            defaultQueueChannel: '/queue/test',
            defaultTopicChannel: '/topic/test',
          },
        ],
      },
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

async function email() {
  return DI.resolve(EmailService);
}

async function client() {
  const queue = await DI.resolve(QueueService);
  return queue.get('test-queue') as unknown as TestQueueClient;
}

const BASE_EMAIL: IEmail = {
  to: ['someone@spinajs.com'],
  from: 'sender@spinajs.com',
  subject: 'hello',
  connection: 'test',
};

function emittedOfType(c: TestQueueClient, name: string): IQueueMessage[] {
  return c.Emitted.filter((m) => m.Name === name);
}

describe('email deferred ( hermetic - no SMTP, no broker )', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    FAKE_SHOULD_FAIL = false;
    FAKE_SEND_CALLS = 0;
    TestQueueClient.FailEventEmit = false;
    DI.register(EmailDeferredConf).as(Configuration);

    await DI.resolve(Configuration);
    await DI.resolve(Orm);
  });

  afterEach(async () => {
    sinon.restore();
    const queue = await DI.resolve(QueueService);
    await queue.dispose();
  });

  it('sendDeferred sets RetryCount from config; per-email retryCount override wins; wire carries it', async () => {
    const e = await email();
    const c = await client();

    // config default ( email.retry.count = 3 )
    const job = await e.sendDeferred({ ...BASE_EMAIL });
    expect(job.RetryCount).to.equal(3);
    expect((c.Emitted[0] as any).RetryCount).to.equal(3);

    // per-email override wins
    const overridden = await e.sendDeferred({ ...BASE_EMAIL, retryCount: 7 });
    expect(overridden.RetryCount).to.equal(7);
    expect((c.Emitted[1] as any).RetryCount).to.equal(7);
  });

  it('delivering the job calls the sender, marks the row success and emits EmailSent', async () => {
    const e = await email();
    const queue = await DI.resolve(QueueService);
    await queue.consume(EmailSend);

    await e.sendDeferred({ ...BASE_EMAIL });

    const c = await client();
    const wire = c.Emitted[0];
    await c.deliver(wire);

    expect(FAKE_SEND_CALLS).to.equal(1);

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('success');

    expect(emittedOfType(c, 'EmailSent').length).to.equal(1);
    expect(emittedOfType(c, 'EmailSendFailed').length).to.equal(0);
  });

  it('failing sender with RetryCount=1: two deliveries -> row dead, exactly one EmailSendFailed with attempt/max/error', async () => {
    FAKE_SHOULD_FAIL = true;

    const e = await email();
    const queue = await DI.resolve(QueueService);
    await queue.consume(EmailSend);

    await e.sendDeferred({ ...BASE_EMAIL, retryCount: 1 });

    const c = await client();
    const wire = c.Emitted[0];

    await expect(c.deliver(wire)).to.be.rejectedWith(FAKE_ERROR_MESSAGE); // attempt 1, retrying
    await expect(c.deliver(wire)).to.be.rejectedWith(FAKE_ERROR_MESSAGE); // attempt 2, dead

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('dead');

    const failed = emittedOfType(c, 'EmailSendFailed');
    expect(failed.length).to.equal(1);
    expect((failed[0] as any).Attempt).to.equal(2);
    expect((failed[0] as any).MaxAttempts).to.equal(1);
    expect((failed[0] as any).Error).to.equal(FAKE_ERROR_MESSAGE);
    expect((failed[0] as any).JobId).to.equal((wire as any).JobId);
  });

  it('a non-final failure ( first of two deliveries ) emits NO EmailSendFailed', async () => {
    FAKE_SHOULD_FAIL = true;

    const e = await email();
    const queue = await DI.resolve(QueueService);
    await queue.consume(EmailSend);

    await e.sendDeferred({ ...BASE_EMAIL, retryCount: 1 });

    const c = await client();
    const wire = c.Emitted[0];

    await expect(c.deliver(wire)).to.be.rejectedWith(FAKE_ERROR_MESSAGE); // attempt 1, retrying ( not final )

    const row = await JobModel.where({ JobId: (wire as any).JobId }).firstOrFail();
    expect(row.Status).to.equal('retrying');
    expect(emittedOfType(c, 'EmailSendFailed').length).to.equal(0);
  });

  it('immediate send() with a failing sender rejects with the ORIGINAL error and emits no EmailSent', async () => {
    FAKE_SHOULD_FAIL = true;

    const e = await email();
    const c = await client();

    await expect(e.send({ ...BASE_EMAIL })).to.be.rejectedWith(FAKE_ERROR_MESSAGE);

    expect(FAKE_SEND_CALLS).to.equal(1);
    expect(emittedOfType(c, 'EmailSent').length).to.equal(0);
  });

  it('a failing EmailSent emit does not make a successful send() reject', async () => {
    TestQueueClient.FailEventEmit = true;

    const e = await email();

    // sender succeeds, but emitting the EmailSent event throws - send() must swallow it.
    await expect(e.send({ ...BASE_EMAIL })).to.be.fulfilled;
    expect(FAKE_SEND_CALLS).to.equal(1);
  });
});
