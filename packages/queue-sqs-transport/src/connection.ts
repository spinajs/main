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
  /**
   * Base delay ( ms ) the poll loop sleeps after a failed ReceiveMessage before
   * retrying. Escalates ( doubles ) on consecutive failures up to
   * {@link receiveErrorBackoffMaxMs} and resets after a successful receive.
   * Prevents a persistent fault ( deleted queue, revoked credentials ) from
   * hot-looping the receive-error branch. Defaults to 500ms.
   */
  receiveErrorBackoffMs?: number;
  /**
   * Cap ( ms ) for the escalating receive-error backoff. Defaults to 10000ms.
   */
  receiveErrorBackoffMaxMs?: number;
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
  /**
   * Set to true by {@link pollLoop} right before it returns, regardless of how it
   * exits ( normal stop, abort or a swallowed error ). Lets callers / tests
   * observe that the detached loop has actually wound down.
   */
  exited: boolean;
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
        exited: false,
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

    // Escalating backoff for the receive-error branch. Starts at the base delay,
    // doubles on each consecutive failure up to the cap, and is reset to the base
    // after any successful ReceiveMessage. Without this a persistent fault
    // ( deleted queue, revoked credentials, permanently dead endpoint ) makes the
    // SDK send throw immediately and the loop spins as a tight infinite loop,
    // spamming logs and hammering the SQS API.
    const baseBackoff = Math.max(0, o.receiveErrorBackoffMs ?? 500);
    const maxBackoff = Math.max(baseBackoff, o.receiveErrorBackoffMaxMs ?? 10000);
    let backoff = baseBackoff;

    try {
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

          // a successful receive clears the fault - drop back to the base delay so a
          // transient blip doesn't leave the loop permanently slow.
          backoff = baseBackoff;
        } catch (err) {
          // aborted by unsubscribe / dispose - the in-flight long poll was cut short
          if (!desc.running) {
            break;
          }

          // receive error ( throttling, network blip, or a persistent fault ) - log
          // and keep the loop alive, otherwise a single hiccup would silently stop
          // consumption. Back off before retrying so a *persistent* fault can't
          // hot-loop the receive; the sleep is abortable so unsubscribe / dispose
          // still tears the loop down promptly instead of waiting out the delay.
          this.Log.warn(`SQS receive error on ${desc.url} ( ${this.Options.name} ), backing off ${backoff}ms: ${err}`);
          await this.backoffSleep(backoff, desc.controller.signal);
          backoff = Math.min(backoff * 2, maxBackoff);
          continue;
        }

        for (const m of res?.Messages ?? []) {
          // a concurrent unsubscribe / dispose may have flipped this mid-batch
          if (!desc.running) {
            break;
          }

          // Defense-in-depth: NOTHING a single message does may escape this loop as
          // an unhandled rejection ( the loop runs detached - there is no caller to
          // catch it, and an escaped throw would crash the worker / Node process ).
          // Any per-message failure is logged and the loop moves on.
          try {
            await this.handleMessage(desc, m);
          } catch (err) {
            this.Log.error(`Unexpected error handling SQS message on ${desc.url} ( ${this.Options.name} ), skipping: ${err}`);
          }
        }
      }
    } catch (err) {
      // last-resort guard: even the loop scaffolding ( e.g. an unexpected throw from
      // the receive-error branch ) must not reject the detached promise.
      this.Log.error(`SQS poll loop for ${desc.url} ( ${this.Options.name} ) crashed unexpectedly: ${err}`);
    } finally {
      desc.exited = true;
      this.Log.trace(`SQS poll loop for ${desc.url} ( ${this.Options.name} ) stopped`);
    }
  }

  /**
   * Processes a single received SQS message: parse -> rehydrate -> handler -> ack.
   * Guards against poison / non-object payloads so a bad message is skipped rather
   * than crashing the loop. Keeps the ack/nack contract: delete on handler success,
   * leave ( for redelivery / DLQ ) on handler failure.
   */
  protected async handleMessage(desc: ISqsSubscriptionDescriptor, m: { Body?: string; ReceiptHandle?: string }): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(m.Body!);
    } catch (e) {
      // poison message - we can't tell its Type so we can't route it. Leave it:
      // SQS redelivery + the redrive policy will dead-letter it after maxReceiveCount,
      // which is preferable to deleting evidence of a producer bug.
      this.Log.error(`Unparseable SQS message on ${desc.url} ( ${this.Options.name} ), leaving for redelivery / DLQ: ${e}`);
      return;
    }

    // JSON.parse happily yields non-object values ( null, numbers, strings,
    // booleans ) that would blow up the CreatedAt / callback access below with a
    // TypeError. Treat them as poison and skip so the loop stays alive.
    if (!parsed || typeof parsed !== 'object') {
      this.Log.error(`Non-object SQS message body on ${desc.url} ( ${this.Options.name} ), skipping`);
      return;
    }

    const message = parsed as IQueueMessage;

    // luxon DateTime serializes to an ISO string over the wire - rehydrate it
    if (typeof (message.CreatedAt as unknown) === 'string') {
      message.CreatedAt = DateTime.fromISO(message.CreatedAt as unknown as string);
    }

    try {
      await desc.callback(message);
    } catch (err) {
      // NACK: do nothing. The message stays invisible only for the visibility
      // timeout, after which SQS redelivers; the redrive policy dead-letters it
      // once maxReceiveCount is hit. No manual retry / DLQ logic here.
      this.Log.error(`Handler failed for ${message.Name} on ${desc.url}, leaving message for redelivery: ${err}`);
      return;
    }

    // ACK: only delete once the handler has fully succeeded. A delete failure is
    // non-fatal ( at-least-once: SQS will simply redeliver ) and is logged
    // distinctly so it is never mistaken for a handler failure.
    try {
      await this.Sqs.send(new DeleteMessageCommand({ QueueUrl: desc.url, ReceiptHandle: m.ReceiptHandle }));
      this.Log.trace(`Processed and acked ${message.Type} Name: ${message.Name} from ${desc.url} ( ${this.Options.name} )`);
    } catch (err) {
      this.Log.error(`ack/delete failed for message ${message.Name} on ${desc.url} ( ${this.Options.name} ), it will redeliver: ${err}`);
    }
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
   * Abortable delay used by the receive-error backoff. Resolves after `ms`, or
   * immediately if the descriptor's AbortController fires ( unsubscribe / dispose )
   * so a disposed subscription never sits parked in a long backoff sleep. The
   * loop re-checks `desc.running` right after, so an abort mid-sleep exits promptly.
   */
  protected backoffSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal.addEventListener('abort', onAbort, { once: true });
    });
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
