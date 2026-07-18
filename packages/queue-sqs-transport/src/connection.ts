import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueMessage } from '@spinajs/queue';
import { InvalidOption } from '@spinajs/exceptions';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

/**
 * SQS specific connection options that can be passed through the generic
 * {@link IQueueConnectionOptions.options} bag.
 */
export interface ISqsConnectionOptions {
  region?: string;
  queueUrl?: string;
  endpoint?: string;
  waitTimeSeconds?: number;
  visibilityTimeout?: number;
  maxMessages?: number;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

@PerInstanceCheck()
@Injectable(QueueClient)
export class SqsQueueClient extends QueueClient {
  /**
   * Underlying AWS SQS client. SQS is a plain HTTP service so there is no
   * long-lived connection to keep alive - the client is created in {@link resolve}
   * and reused for every {@link emit}.
   */
  protected Sqs: SQSClient;

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve(): Promise<void> {
    const o = (this.Options.options ?? {}) as ISqsConnectionOptions;

    this.Sqs = new SQSClient({
      region: o.region,
      endpoint: o.endpoint,
      credentials: o.credentials,
    });

    // SQS is HTTP based - there is no eager connection to establish. We only
    // make sure the transport has some way to resolve a destination queue URL,
    // otherwise every emit would fail with an opaque AWS error.
    if (!o.queueUrl && !this.Options.defaultQueueChannel && !this.Options.defaultTopicChannel) {
      throw new InvalidOption(`SQS connection ${this.Options.name} needs options.queueUrl, defaultQueueChannel or defaultTopicChannel to resolve a destination queue URL`);
    }

    this.Log.info(`SQS queue client ${this.Options.name} resolved ( region: ${o.region ?? '<default>'}, endpoint: ${o.endpoint ?? '<default>'} )`);
  }

  public async emit(message: IQueueMessage): Promise<void> {
    // routing[message.Name] || defaultQueueChannel|defaultTopicChannel - for SQS
    // these entries are queue URLs. `Name`/`Type`/`JobId` ride the JSON body so
    // the core consumer can rehydrate the message on the receiving side.
    const urls = this.getChannelForMessage(message);
    const body = JSON.stringify(message);

    await Promise.all(
      urls.map((QueueUrl) => {
        this.Log.trace(`Publishing ${message.Type} Name: ${message.Name} to SQS queue ${QueueUrl} ( ${this.Options.name} )`);
        return this.Sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: body }));
      }),
    );
  }

  public async subscribe(_channelOrMessage: string | Constructor<QueueMessage>, _callback: (e: IQueueMessage) => Promise<void>, _subscriptionId?: string, _durable?: boolean): Promise<void> {
    throw new Error('SqsQueueClient.subscribe not implemented');
  }

  public unsubscribe(_channelOrMessage: string | Constructor<QueueMessage>, _removeDurable?: boolean): void {
    throw new Error('SqsQueueClient.unsubscribe not implemented');
  }

  public async dispose(): Promise<void> {
    this.Sqs?.destroy();
  }
}
