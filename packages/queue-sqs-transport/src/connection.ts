import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueMessage } from '@spinajs/queue';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';

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
  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve(): Promise<void> {
    throw new Error('SqsQueueClient.resolve not implemented');
  }

  public async emit(_message: IQueueMessage): Promise<void> {
    throw new Error('SqsQueueClient.emit not implemented');
  }

  public async subscribe(_channelOrMessage: string | Constructor<QueueMessage>, _callback: (e: IQueueMessage) => Promise<void>, _subscriptionId?: string, _durable?: boolean): Promise<void> {
    throw new Error('SqsQueueClient.subscribe not implemented');
  }

  public unsubscribe(_channelOrMessage: string | Constructor<QueueMessage>, _removeDurable?: boolean): void {
    throw new Error('SqsQueueClient.unsubscribe not implemented');
  }

  public async dispose(): Promise<void> {
    /* stub - no-op until implemented */
  }
}
