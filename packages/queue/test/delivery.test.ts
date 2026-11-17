import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { Configuration, FrameworkConfiguration, InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';
import { DI, type ContainerSnapshot } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdempotencyInFlight } from '@spinajs/idempotency';
import {
  assertDeliveryRouting,
  backoffDelay,
  BlackHoleQueueClient,
  decideDelivery,
  Event,
  isNonRetryableFailure,
  PermanentJobFailure,
  QUEUE_ROUTING_CONFIGURATION_SCHEMA,
  QueueEvent,
  QueueHeaders,
  QueueMessageType,
  RedeliverLater,
  resolveDeliveryPolicy,
  retryCountOf,
  UnparseableMessageError,
  unparseableMessage,
  type DeliveryPolicy,
  type IQueueConnectionOptions,
  type IQueueJob,
  type IQueueMessage,
} from '../src/index.js';

@Event()
class Shipped extends QueueEvent {}

let routing: Record<string, unknown> = {};
let beforeConfigure: ContainerSnapshot | undefined;

// One class at module level: DI keeps the first class registered under a name.
class DeliveryConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { queue: { default: 'bh', routing, connections: [] }, logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] } };
  }
}

// DI.clearCache() keeps a registered configuration schema, so each configuration starts from a snapshot taken before it
async function reset(): Promise<void> {
  if (beforeConfigure) {
    await DI.restore(beforeConfigure);
    beforeConfigure = undefined;
  }
  DI.clearCache();
}

async function configure(value: Record<string, unknown>): Promise<Configuration> {
  await reset();
  beforeConfigure = DI.snapshot();
  routing = value;
  DI.register(DeliveryConf).as(Configuration);
  return DI.resolve(Configuration);
}

async function clientWith(value: Record<string, unknown>, options: Partial<IQueueConnectionOptions> = {}): Promise<BlackHoleQueueClient> {
  await configure(value);
  return new BlackHoleQueueClient({ name: 'bh', service: 'BlackHoleQueueClient', ...options });
}

const job = (extra: Partial<IQueueMessage> = {}): IQueueMessage => ({ Name: 'SendInvoice', Type: QueueMessageType.Job, CreatedAt: DateTime.fromMillis(0), Persistent: true, Priority: 0, MessageId: 'm-1', ...extra });
const event = (extra: Partial<IQueueMessage> = {}): IQueueMessage => job({ Name: 'InvoiceSent', Type: QueueMessageType.Event, ...extra });
const policy = (extra: Partial<DeliveryPolicy> = {}): DeliveryPolicy => ({ maxRetries: 2, backoff: { kind: 'exponential', delayMs: 1000 }, deadLetterChannel: '/queue/dlq', onEventFailure: 'drop', ...extra });

describe('decideDelivery', () => {
  it('retries a job with growing x-retry-count and exponential delay', () => {
    expect(decideDelivery(job(), 0, new Error('boom'), policy())).to.deep.equal({ action: 'retry', attempt: 1, delayMs: 1000, headers: { [QueueHeaders.MessageId]: 'm-1', [QueueHeaders.Error]: 'boom', [QueueHeaders.RetryCount]: '1' } });
    expect(decideDelivery(job(), 1, new Error('boom'), policy())).to.include({ action: 'retry', attempt: 2, delayMs: 2000 });
  });

  it('dead-letters an exhausted job with its headers', () => {
    expect(decideDelivery(job(), 2, new Error('boom'), policy())).to.deep.equal({ action: 'dead-letter', channel: '/queue/dlq', reason: 'exhausted', headers: { [QueueHeaders.MessageId]: 'm-1', [QueueHeaders.Error]: 'boom', [QueueHeaders.RetryCount]: '2' } });
  });

  it('dead-letters NonRetryableError and PermanentJobFailure on the first failure', () => {
    expect(decideDelivery(job(), 0, new NonRetryableError('no'), policy())).to.include({ action: 'dead-letter', reason: 'non-retryable' });
    expect(decideDelivery(job(), 0, new PermanentJobFailure('denied', 'no access'), policy())).to.include({ action: 'dead-letter', reason: 'non-retryable' });
  });

  it('matches NonRetryableError by name across package copies', () => {
    const foreign = new Error('no');
    foreign.name = 'NonRetryableError';
    expect(decideDelivery(job(), 0, foreign, policy())).to.include({ reason: 'non-retryable' });
  });

  it('drops a failed event by default and retries it with onEventFailure retry', () => {
    expect(decideDelivery(event(), 0, new Error('boom'), policy())).to.deep.equal({ action: 'ack', dropped: true, reason: 'boom' });
    expect(decideDelivery(event(), 0, new Error('boom'), policy({ onEventFailure: 'retry' }))).to.include({ action: 'retry', attempt: 1 });
  });

  it('dead-letters an event exhausted under onEventFailure retry', () => {
    expect(decideDelivery(event(), 2, new Error('boom'), policy({ onEventFailure: 'retry' }))).to.include({ action: 'dead-letter', reason: 'exhausted', channel: '/queue/dlq' });
  });

  it('forces a retry for RedeliverLater whatever the policy, attempt unchanged', () => {
    const d = decideDelivery(event(), 3, new RedeliverLater(5000), policy({ maxRetries: 0 }));
    expect(d).to.include({ action: 'retry', attempt: 3, delayMs: 5000, forced: true });
    expect(d.action === 'retry' && d.headers[QueueHeaders.RetryCount]).to.equal('3');
  });

  it("decides a handler's own IdempotencyInFlight by the retry policy, never as a forced redelivery", () => {
    const own = new IdempotencyInFlight(5000);
    const jobPolicy = policy({ maxRetries: 1 });
    expect(decideDelivery(job(), 0, own, jobPolicy)).to.deep.include({ action: 'retry', attempt: 1, delayMs: 1000 });
    expect(decideDelivery(job(), 0, own, jobPolicy)).to.not.have.property('forced');
    expect(decideDelivery(job(), 1, own, jobPolicy)).to.include({ action: 'dead-letter', reason: 'exhausted' });
    expect(decideDelivery(event(), 0, own, jobPolicy)).to.include({ action: 'ack', dropped: true });
    expect(decideDelivery(event(), 1, own, policy({ maxRetries: 1, onEventFailure: 'retry' }))).to.include({ action: 'dead-letter', reason: 'exhausted' });
  });

  it('takes only the RedeliverLater itself as a redelivery, not an error that carries one as its cause', () => {
    const wrapped = new Error('handler failed', { cause: new RedeliverLater(5000) });
    expect(decideDelivery(job(), 2, wrapped, policy())).to.include({ action: 'dead-letter', reason: 'exhausted' });
    const lookalike = Object.assign(new Error('redeliver in 5000 ms'), { name: 'RedeliverLater', delayMs: 5000 });
    expect(decideDelivery(job(), 2, lookalike, policy())).to.include({ action: 'dead-letter', reason: 'exhausted' });
  });

  it('dead-letters an unparseable body to the policy channel', () => {
    expect(decideDelivery(unparseableMessage(), 0, new UnparseableMessageError(new SyntaxError('bad json')), policy())).to.include({ action: 'dead-letter', reason: 'unparseable', channel: '/queue/dlq' });
  });

  it('refuses to decide a crash', () => {
    const crash = Object.assign(new Error('dead'), { crash: true });
    expect(() => decideDelivery(job(), 0, crash, policy())).to.throw(InvalidArgument, /crash/);
    expect(() => decideDelivery(job(), 0, Object.assign(new RedeliverLater(10), { crash: true }), policy())).to.throw(InvalidArgument, /crash/);
  });

  it('cuts x-error at 1024 characters', () => {
    const d = decideDelivery(job(), 0, new Error('x'.repeat(5000)), policy());
    expect(d.action === 'retry' && d.headers[QueueHeaders.Error].length).to.equal(1024);
  });

  it('leaves x-spinajs-message-id out when the message has none', () => {
    const d = decideDelivery(job({ MessageId: undefined }), 0, new Error('boom'), policy());
    expect(d.action === 'retry' && d.headers).to.deep.equal({ [QueueHeaders.Error]: 'boom', [QueueHeaders.RetryCount]: '1' });
  });

  it('caps an exponential delay at maxDelayMs and keeps a fixed one', () => {
    expect(backoffDelay({ kind: 'exponential', delayMs: 1000, maxDelayMs: 3000 }, 5)).to.equal(3000);
    expect(backoffDelay({ kind: 'fixed', delayMs: 700 }, 5)).to.equal(700);
    expect(backoffDelay({ kind: 'exponential', delayMs: 0 }, 3)).to.equal(0);
  });

  it('reads x-retry-count as a string or a number', () => {
    expect(retryCountOf({ [QueueHeaders.RetryCount]: '3' })).to.equal(3);
    expect(retryCountOf({ [QueueHeaders.RetryCount]: 3 })).to.equal(3);
    expect(retryCountOf({ [QueueHeaders.RetryCount]: 'x' })).to.equal(0);
    expect(retryCountOf({ [QueueHeaders.RetryCount]: '-2' })).to.equal(0);
    expect(retryCountOf(undefined)).to.equal(0);
  });

  it('names the error in x-error when it has no message', () => {
    const d = decideDelivery(job(), 0, new TypeError(), policy());
    expect(d.action === 'retry' && d.headers[QueueHeaders.Error]).to.equal('TypeError');
  });

  it('tells a non-retryable failure by marker or by name', () => {
    expect(isNonRetryableFailure(new NonRetryableError('no'))).to.equal(true);
    expect(isNonRetryableFailure(new PermanentJobFailure('denied', 'no access'))).to.equal(true);
    expect(isNonRetryableFailure(new Error('boom'))).to.equal(false);
  });

  it('dead-letters a subclass of NonRetryableError that renames itself', () => {
    class CardExpired extends NonRetryableError {
      constructor() {
        super('card expired');
        this.name = 'CardExpired';
      }
    }
    expect(decideDelivery(job(), 0, new CardExpired(), policy())).to.include({ action: 'dead-letter', reason: 'non-retryable' });
  });
});

describe('delivery routing', function () {
  this.timeout(60_000);
  afterEach(reset);

  it('resolves the policy from the route, then from the connection', async () => {
    const client = await clientWith(
      { SendInvoice: { maxRetries: 4, backoff: { kind: 'fixed', delayMs: 700 }, deadLetterChannel: '/queue/invoices.dlq' } },
      { retryDelay: 100, defaultQueueDeadLetterChannel: '/queue/dlq' },
    );
    expect(resolveDeliveryPolicy(client, job())).to.deep.equal({ maxRetries: 4, backoff: { kind: 'fixed', delayMs: 700 }, deadLetterChannel: '/queue/invoices.dlq', onEventFailure: 'drop' });
    expect(resolveDeliveryPolicy(client, event())).to.deep.equal({ maxRetries: 0, backoff: { kind: 'exponential', delayMs: 100 }, deadLetterChannel: '/queue/dlq', onEventFailure: 'drop' });
  });

  it("prefers a job's own RetryCount over the route", async () => {
    const client = await clientWith({ SendInvoice: { maxRetries: 4 } });
    const own: IQueueJob = { ...job(), RetryCount: 1 };
    expect(resolveDeliveryPolicy(client, own)).to.include({ maxRetries: 1 });
  });

  it('accepts valid delivery options on a route', async () => {
    const client = await clientWith({ Shipped: { backoff: { kind: 'exponential', delayMs: 5, maxDelayMs: 50 }, onEventFailure: 'retry', groupBy: 'OrderId' } });
    expect(() => assertDeliveryRouting(client, Shipped)).to.not.throw();
    expect(client.getRouteOption(Shipped, 'groupBy')).to.equal('OrderId');
  });

  it('reads an option from the first entry of this connection that declares it', async () => {
    const client = await clientWith({ Shipped: ['/topic/a', { channel: '/topic/b', connection: 'other', groupBy: 'Foreign' }, { channel: '/topic/c', groupBy: 'OrderId' }] }, { name: 'bh' });
    expect(client.getRouteOption(Shipped, 'groupBy')).to.equal('OrderId');
    expect(client.getRouteOption(Shipped, 'backoff')).to.equal(undefined);
  });

  for (const bad of [{ backoff: { kind: 'linear', delayMs: 5 } }, { backoff: { kind: 'fixed', delayMs: -1 } }, { backoff: { kind: 'fixed', delayMs: 5, maxDelayMs: 1.5 } }, { onEventFailure: 'requeue' }, { groupBy: '' }]) {
    it(`refuses ${JSON.stringify(bad)} when the subscription is made`, async () => {
      const client = await clientWith({ Shipped: bad });
      expect(() => assertDeliveryRouting(client, Shipped)).to.throw(InvalidArgument);
    });
  }

  it('refuses a bad delivery option when the schema is registered', async () => {
    await configure({ Shipped: { onEventFailure: 'requeue' } });
    expect(() => registerConfigurationSchema(QUEUE_ROUTING_CONFIGURATION_SCHEMA, DI.RootContainer)).to.throw(InvalidConfiguration);
    await configure({ Shipped: ['/topic/a', { channel: '/topic/b', backoff: { kind: 'fixed', delayMs: 5 } }], Plain: '/queue/plain' });
    expect(() => registerConfigurationSchema(QUEUE_ROUTING_CONFIGURATION_SCHEMA, DI.RootContainer)).to.not.throw();
  });

  // the Configuration's own validator coerces in place, so these check the stored value, not only the verdict
  it('keeps a delay in milliseconds a number through the schema', async () => {
    const configuration = await configure({ Shipped: { backoff: { kind: 'exponential', delayMs: 0, maxDelayMs: 5000 } }, Paid: [{ channel: '/topic/p', backoff: { kind: 'fixed', delayMs: '250' } }] });
    registerConfigurationSchema(QUEUE_ROUTING_CONFIGURATION_SCHEMA, DI.RootContainer);
    expect(configuration.get('queue.routing.Shipped')).to.deep.equal({ backoff: { kind: 'exponential', delayMs: 0, maxDelayMs: 5000 } });
    expect(configuration.get('queue.routing.Paid')).to.deep.equal([{ channel: '/topic/p', backoff: { kind: 'fixed', delayMs: 250 } }]);
  });

  for (const delay of [null, true, false, '', ' ', '\t', -1, 1.5, '5s', 'soon']) {
    it(`refuses a delay of ${JSON.stringify(delay)} by the schema`, async () => {
      await configure({ Shipped: { backoff: { kind: 'fixed', delayMs: 5, maxDelayMs: delay } } });
      expect(() => registerConfigurationSchema(QUEUE_ROUTING_CONFIGURATION_SCHEMA, DI.RootContainer)).to.throw(InvalidConfiguration);
      await configure({ Shipped: [{ channel: '/topic/s', backoff: { kind: 'fixed', delayMs: delay } }] });
      expect(() => registerConfigurationSchema(QUEUE_ROUTING_CONFIGURATION_SCHEMA, DI.RootContainer)).to.throw(InvalidConfiguration);
    });
  }
});
