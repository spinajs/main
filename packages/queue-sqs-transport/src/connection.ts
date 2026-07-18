import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueMessage } from '@spinajs/queue';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { DateTime } from 'luxon';
import _ from 'lodash';

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

/**
 * Tracks a live subscription. Unlike STOMP there is no broker-side subscription
 * object - a subscription here is a detached long-poll loop over one queue URL.
 * The descriptor is the loop's control block: `running` gates the loop and the
 * `AbortController` interrupts an in-flight ( up to WaitTimeSeconds ) ReceiveMessage
 * so unsubscribe / dispose return promptly instead of blocking on the poll.
 */
interface ISqsSubscriptionDescriptor {
  url: string;
  callback: (e: IQueueMessage) => Promise<void>;
  running: boolean;
  controller: AbortController;
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

  /**
   * Active subscriptions keyed by queue URL. Each entry owns a detached poll loop.
   */
  protected Subscriptions = new Map<string, ISqsSubscriptionDescriptor>();

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  public async resolve(): Promise<void> {
    const o = (this.Options.options ?? {}) as ISqsConnectionOptions;

    // SQS is HTTP based - there is no eager connection to establish and no
    // connection-level destination to validate here. Destinations are resolved
    // per-message at emit time via getChannelForMessage, which consults the
    // global queue.routing table first and only then falls back to the
    // connection defaults - so a routing-only connection ( no defaultQueueChannel /
    // defaultTopicChannel ) is perfectly valid. resolve()'s only job is to build
    // the SQSClient; region/endpoint/credentials are all optional for the SDK.
    this.Sqs = new SQSClient({
      region: o.region,
      endpoint: o.endpoint,
      credentials: o.credentials,
    });

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

  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, _subscriptionId?: string, _durable?: boolean): Promise<void> {
    // mirror STOMP's overload handling: a raw string is the queue URL itself,
    // a message class is resolved through the routing table.
    const urls = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    urls.forEach((url) => {
      if (this.Subscriptions.has(url)) {
        this.Log.warn(`SQS queue ${url} already subscribed !`);
        return;
      }

      const desc: ISqsSubscriptionDescriptor = {
        url,
        callback,
        running: true,
        controller: new AbortController(),
      };

      this.Subscriptions.set(url, desc);

      // detached loop - subscribe returns as soon as the poll loop is started,
      // it is NOT awaited. Errors inside the loop must never escape ( there is no
      // caller to catch them ), so pollLoop swallows/logs everything itself.
      void this.pollLoop(desc);

      this.Log.success(`SQS queue ${url} subscribed and polling for messages !`);
    });
  }

  /**
   * Long-poll loop for a single subscription. Runs until `desc.running` is cleared
   * ( by unsubscribe / dispose ). On success the message is acked by DeleteMessage;
   * on handler failure the message is left untouched so the SQS visibility timeout
   * redelivers it and the redrive policy dead-letters after maxReceiveCount.
   */
  protected async pollLoop(desc: ISqsSubscriptionDescriptor): Promise<void> {
    const o = (this.Options.options ?? {}) as ISqsConnectionOptions;

    while (desc.running) {
      let res;

      try {
        res = await this.Sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: desc.url,
            WaitTimeSeconds: o.waitTimeSeconds ?? 20,
            MaxNumberOfMessages: o.maxMessages ?? 1,
            VisibilityTimeout: o.visibilityTimeout,
          }),
          { abortSignal: desc.controller.signal },
        );
      } catch (err) {
        // aborted by unsubscribe / dispose - the in-flight long poll was cut short
        if (!desc.running) {
          break;
        }

        // transient receive error ( throttling, network blip ) - log and keep the
        // loop alive, otherwise a single hiccup would silently stop consumption.
        this.Log.warn(`SQS receive error on ${desc.url} ( ${this.Options.name} ): ${err}`);
        continue;
      }

      for (const m of res?.Messages ?? []) {
        // a concurrent unsubscribe / dispose may have flipped this mid-batch
        if (!desc.running) {
          break;
        }

        let parsed: IQueueMessage;

        try {
          parsed = JSON.parse(m.Body!);
        } catch (e) {
          // poison message - we can't tell its Type so we can't route it. Leave it:
          // SQS redelivery + the redrive policy will dead-letter it after maxReceiveCount,
          // which is preferable to deleting evidence of a producer bug.
          this.Log.error(`Unparseable SQS message on ${desc.url} ( ${this.Options.name} ), leaving for redelivery / DLQ: ${e}`);
          continue;
        }

        // luxon DateTime serializes to an ISO string over the wire - rehydrate it
        if (typeof (parsed.CreatedAt as unknown) === 'string') {
          parsed.CreatedAt = DateTime.fromISO(parsed.CreatedAt as unknown as string);
        }

        try {
          await desc.callback(parsed);

          // ACK: only delete once the handler has fully succeeded.
          await this.Sqs.send(new DeleteMessageCommand({ QueueUrl: desc.url, ReceiptHandle: m.ReceiptHandle }));

          this.Log.trace(`Processed and acked ${parsed.Type} Name: ${parsed.Name} from ${desc.url} ( ${this.Options.name} )`);
        } catch (err) {
          // NACK: do nothing. The message stays invisible only for the visibility
          // timeout, after which SQS redelivers; the redrive policy dead-letters it
          // once maxReceiveCount is hit. No manual retry / DLQ logic here.
          this.Log.error(`Handler failed for ${parsed.Name} on ${desc.url}, leaving message for redelivery: ${err}`);
        }
      }
    }

    this.Log.trace(`SQS poll loop for ${desc.url} ( ${this.Options.name} ) stopped`);
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>, _removeDurable?: boolean): void {
    const urls = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    urls.forEach((url) => {
      const desc = this.Subscriptions.get(url);

      if (!desc) {
        return;
      }

      this.stop(desc);
      this.Subscriptions.delete(url);

      this.Log.info(`Unsubscribed from SQS queue ${url} ( ${this.Options.name} )`);
    });
  }

  public async dispose(): Promise<void> {
    // stop every poll loop and interrupt any in-flight long poll so this returns
    // promptly instead of waiting up to WaitTimeSeconds for the last receive.
    for (const desc of this.Subscriptions.values()) {
      this.stop(desc);
    }

    this.Subscriptions.clear();

    this.Sqs?.destroy();

    this.Log.info(`SQS queue client ${this.Options.name} disposed`);
  }

  /**
   * Stops a subscription's poll loop: clears the running flag and aborts any
   * in-flight ReceiveMessage. The loop observes both and exits.
   */
  protected stop(desc: ISqsSubscriptionDescriptor): void {
    desc.running = false;
    desc.controller.abort();
  }
}
