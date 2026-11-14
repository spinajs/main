import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Constructor, DI, Injectable, PerInstanceCheck } from '@spinajs/di';
import * as chai from 'chai';
import { validate as isUuid } from 'uuid';
import { DateTime } from 'luxon';
import { Event, IQueueMessage, Job, QueueClient, QueueEvent, QueueJob, QueueMessage, QueueMessageType, QueueService } from '../src/index.js';

const expect = chai.expect;

@PerInstanceCheck()
@Injectable(QueueClient)
class MessageIdCapturingClient extends QueueClient {
  public Emitted: IQueueMessage[] = [];

  public async emit(event: IQueueMessage): Promise<void> {
    this.Emitted.push(event);
  }

  public async subscribe(_channel: string | Constructor<QueueMessage>, _cb: (e: IQueueMessage) => Promise<void>): Promise<void> {}

  public unsubscribe(): void {}
}

class MessageIdConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      queue: {
        default: 'message-id-queue',
        routing: {},
        connections: [{ service: 'MessageIdCapturingClient', name: 'message-id-queue', defaultQueueChannel: '/queue/test', defaultTopicChannel: '/topic/test' }],
      },
    };
  }
}

@Event()
class MessageIdEvent extends QueueEvent {
  public Foo: string;
}

@Job()
class MessageIdJob extends QueueJob {
  public async execute(): Promise<unknown> {
    return 'ok';
  }
}

async function emitted(): Promise<IQueueMessage & { JobId?: string }> {
  const queue = await DI.resolve(QueueService);
  const client = queue.get('message-id-queue') as unknown as MessageIdCapturingClient;
  expect(client.Emitted).to.have.length(1);
  return client.Emitted[0];
}

describe('message ids', function () {
  this.timeout(15000);

  beforeEach(async () => {
    DI.clearCache();
    DI.register(MessageIdConf).as(Configuration);
    await DI.resolve(Configuration);
    await DI.resolve(QueueService);
  });

  it('gives an emitted event a uuid MessageId', async () => {
    await MessageIdEvent.emit({ Foo: 'bar' });

    const message = await emitted();
    expect(message.MessageId).to.be.a('string');
    expect(isUuid(message.MessageId!)).to.equal(true);
  });

  it("uses the MessageId as a job's JobId when the JobId is unset", async () => {
    const jobId = await MessageIdJob.emit({});

    const message = await emitted();
    expect(isUuid(message.MessageId!)).to.equal(true);
    expect(message.JobId).to.equal(message.MessageId);
    expect(jobId).to.equal(message.MessageId);
  });

  it('keeps a caller-set JobId apart from the MessageId', async () => {
    const jobId = await MessageIdJob.emit({ JobId: 'job-1' });

    const message = await emitted();
    expect(jobId).to.equal('job-1');
    expect(message.JobId).to.equal('job-1');
    expect(isUuid(message.MessageId!)).to.equal(true);
  });

  it('preserves a caller-set MessageId', async () => {
    const queue = await DI.resolve(QueueService);
    const result = await queue.emit({ Name: 'MessageIdEvent', Type: QueueMessageType.Event, CreatedAt: DateTime.now(), Persistent: false, Priority: 0, MessageId: 'caller-id' });

    const message = await emitted();
    expect(result).to.equal(undefined);
    expect(message.MessageId).to.equal('caller-id');
  });

  it('hydrates MessageId and Headers into a message class', () => {
    const event = new MessageIdEvent();
    const payload = { MessageId: 'm-1', Headers: { traceparent: 't-1' } };
    event.hydrate(payload);

    expect(event.MessageId).to.equal('m-1');
    expect(event.Headers).to.deep.equal({ traceparent: 't-1' });
    expect(event.Headers, 'a copy, not the payload object').to.not.equal(payload.Headers);
  });
});
