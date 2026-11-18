import { createHash } from 'node:crypto';
import { IQueueMessage, IQueueConnectionOptions, QueueClient, QueueHeaders, QueueMessage, readQueueHeaders, decideDelivery, isCrash, resolveDeliveryPolicy, retryCountOf, unparseableMessage, UnparseableMessageError, type DeliveryDecision, type DeliveryPolicy } from '@spinajs/queue';
import { Constructor, Injectable, PerInstanceCheck } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, GetQueueAttributesCommand, type Message, type SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { DateTime } from 'luxon';
import _ from 'lodash';
import { MAX_SQS_DELAY_MS, NOT_BEFORE_ATTRIBUTE, readMessageAttributes, toMessageAttributes } from './attributes.js';

const MAX_TIMER_MS = 2 ** 31 - 1;

/** SQS allows 12 hours of visibility counted from the receive; an hour is left for the handler that already ran. */
const MAX_FIFO_RETRY_SECONDS = 39_600;

function maxReceiveCountOf(redrivePolicy: string): number | undefined {
  try {
    const policy: unknown = JSON.parse(redrivePolicy);
    const count = Number(typeof policy === 'object' && policy !== null ? Reflect.get(policy, 'maxReceiveCount') : undefined);
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}
// MessageGroupId and MessageDeduplicationId: 1 to 128 ASCII letters, digits or punctuation
const SQS_ID = /^[\x21-\x7E]{1,128}$/;

/** A delay as every queue transport takes it: a whole number of ms from 0 to the Node timer limit. */
const toDelayMs = (ms: number | undefined): number => (ms === undefined || Number.isNaN(ms) ? 0 : Math.min(Math.max(0, Math.round(ms)), MAX_TIMER_MS));

// hashing keeps one MessageId one deduplication id where SQS would refuse the MessageId itself
const toDedupId = (id: string): string => (SQS_ID.test(id) ? id : createHash('sha256').update(id).digest('hex'));

function groupIdValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * SQS specific connection options that can be passed through the generic
 * {@link IQueueConnectionOptions.options} bag.
 */
export interface ISqsConnectionOptions {
  region?: string;
  /**
   * @deprecated Never read by the transport. Use `defaultQueueChannel`, `defaultTopicChannel` or `queue.routing`.
   */
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
  /**
   * Who retries and dead-letters a failed message. 'redrive' ( default ): the SQS visibility timeout and the queue's
   * redrive policy. 'transport': the delivery decision of `@spinajs/queue`, with its headers and dead-letter channel.
   */
  retryMode?: 'redrive' | 'transport';
}

/** What the transport reads of a received SQS message. */
export type SqsReceived = Pick<Message, 'Body' | 'ReceiptHandle' | 'MessageId' | 'MessageAttributes' | 'Attributes'>;

export interface SqsSendOptions {
  delayMs?: number;
  /** Absolute deadline (epoch ms) of an `x-spinajs-not-before` re-send; wins over delayMs. */
  notBefore?: number;
  headers?: Record<string, string>;
  /** FIFO: the MessageGroupId, instead of the one the routing `groupBy` gives. A dead letter keeps the group it was received in. */
  groupId?: string;
  /** FIFO: the MessageDeduplicationId, instead of the MessageId. A dead letter needs its own, or SQS drops it as a duplicate of the original. */
  dedupId?: string;
}

/**
 * Tracks a live subscription. Unlike STOMP there is no broker-side subscription
 * object - a subscription here is a detached long-poll loop over one queue URL.
 * The descriptor is the loop's control block: `running` gates the loop and the
 * `AbortController` interrupts an in-flight ( up to WaitTimeSeconds ) ReceiveMessage
 * so unsubscribe / dispose return promptly instead of blocking on the poll.
 */
export interface ISqsSubscriptionDescriptor {
  url: string;
  /**
   * Runs every entry of {@link handlers} in turn. Several message types can share one
   * queue URL, so one poll loop serves all of them.
   */
  callback: (e: IQueueMessage) => Promise<void>;
  /**
   * Subscribers of this URL keyed by message class name, or by the URL for a raw string subscribe.
   */
  handlers: Map<string, (e: IQueueMessage) => Promise<void>>;
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

  /**
   * Poll loops still running, including ones already stopped by {@link unsubscribe}.
   * {@link dispose} waits for them so no handler is cut off from the SQSClient.
   */
  protected Loops = new Set<Promise<void>>();

  protected RetryMode: 'redrive' | 'transport' = 'redrive';

  /** maxReceiveCount of each FIFO queue whose redrive policy the subscribe check read. */
  protected FifoReceiveLimits = new Map<string, number>();

  protected readonly WarnedRetryCaps = new Set<string>();

  constructor(options: IQueueConnectionOptions) {
    super(options);
  }

  // a RedeliverLater comes back in both modes: after the visibility timeout ('redrive') or after its delay ('transport')
  public get RedeliversFailedEvents(): boolean {
    return true;
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
    this.RetryMode = this.readRetryMode();
    this.Sqs = new SQSClient({
      region: o.region,
      endpoint: o.endpoint,
      credentials: o.credentials,
    });

    await super.resolve();

    this.Log.info({ connection: this.Options.name, region: o.region ?? '<default>', endpoint: o.endpoint ?? '<default>' }, 'SQS queue client ${connection} resolved ( region: ${region}, endpoint: ${endpoint} )');
  }

  public async emit(message: IQueueMessage): Promise<void> {
    // for SQS a channel is a queue URL; Name, Type and JobId ride the JSON body
    const urls = this.getChannelForMessage(message);
    // built first: a FIFO URL without a group id throws before anything is sent
    const inputs = urls.map((url) => this.sendParams(url, message, { delayMs: message.ScheduleDelay }));

    await Promise.all(
      inputs.map((input) => {
        this.Log.trace({ messageType: message.Type, messageName: message.Name, queueUrl: input.QueueUrl, connection: this.Options.name }, 'Publishing ${messageType} Name: ${messageName} to SQS queue ${queueUrl} ( ${connection} )');
        return this.sendMessage(input);
      }),
    );
  }

  protected now(): number {
    return Date.now();
  }

  protected isFifo(url: string): boolean {
    return url.endsWith('.fifo');
  }

  protected async sendMessage(input: SendMessageCommandInput): Promise<void> {
    await this.Sqs.send(new SendMessageCommand(input));
  }

  protected async deleteMessage(url: string, receiptHandle: string | undefined): Promise<void> {
    await this.Sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receiptHandle }));
  }

  protected async changeVisibility(url: string, receiptHandle: string | undefined, seconds: number): Promise<void> {
    await this.Sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
  }

  protected async redrivePolicyOf(url: string): Promise<string | undefined> {
    const res = await this.Sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['RedrivePolicy'] }));
    return res.Attributes?.RedrivePolicy;
  }

  protected readRetryMode(): 'redrive' | 'transport' {
    // the bag is typed any; a typed local keeps the read out of no-unsafe-member-access
    const options: Record<string, unknown> = this.Options.options ?? {};
    const raw = options.retryMode;
    if (raw === undefined) return 'redrive';
    if (raw !== 'redrive' && raw !== 'transport') {
      throw new InvalidArgument(`Queue connection ${this.Options.name}: options.retryMode must be 'redrive' or 'transport', got ${JSON.stringify(raw)}`);
    }
    return raw;
  }

  /**
   * FIFO retries keep the message and extend its visibility, so an AWS redrive policy must outlast every retry.
   * One that was read and cannot fails the subscription: AWS would dead-letter the message, without headers,
   * before the transport does. One that cannot be read is only warned about: the role may lack the permission
   * while the queue is configured correctly.
   */
  protected async checkFifoRedrive(url: string, maxRetries: number): Promise<void> {
    let policy: string | undefined;
    try {
      policy = await this.redrivePolicyOf(url);
    } catch (error) {
      this.Log.warn(
        { error, queueUrl: url, connection: this.Options.name },
        'Cannot read the redrive policy of FIFO queue ${queueUrl} ( ${connection} ), so transport retry mode runs unchecked there: if its maxReceiveCount is too small, AWS dead-letters messages without headers. Grant sqs:GetQueueAttributes on the queue to have it checked',
      );
      return;
    }

    if (policy === undefined) return;

    const maxReceiveCount = maxReceiveCountOf(policy);
    if (maxReceiveCount === undefined) {
      this.Log.warn({ queueUrl: url, connection: this.Options.name, policy }, 'FIFO queue ${queueUrl} ( ${connection} ) has a redrive policy without a readable maxReceiveCount, so transport retry mode runs unchecked there: ${policy}');
      return;
    }

    if (maxReceiveCount <= maxRetries + 1) {
      throw new InvalidArgument(
        `FIFO queue ${url} ( connection ${this.Options.name} ) has a redrive policy with maxReceiveCount ${maxReceiveCount}, but its route asks for maxRetries ${maxRetries}: in transport retry mode AWS would dead-letter the message before the transport does. ` +
          `Raise maxReceiveCount above ${maxRetries + 1}, lower the route's maxRetries, or remove the redrive policy`,
      );
    }

    this.FifoReceiveLimits.set(url, maxReceiveCount);
  }

  /**
   * A message's own RetryCount wins over the routing value the subscribe check saw. When the queue's redrive policy
   * cannot hold it, the message is decided with the most retries that policy holds, so the transport dead-letters
   * it with its headers one receive before AWS would do it without them.
   */
  protected withinReceiveLimit(desc: ISqsSubscriptionDescriptor, message: IQueueMessage, policy: DeliveryPolicy): DeliveryPolicy {
    const limit = this.FifoReceiveLimits.get(desc.url);
    if (limit === undefined || limit > policy.maxRetries + 1) return policy;

    // a stored limit passed the subscribe check, so it is at least 2
    const maxRetries = limit - 2;
    const key = `${desc.url} ${message.Name}`;
    if (!this.WarnedRetryCaps.has(key)) {
      this.WarnedRetryCaps.add(key);
      this.Log.error(
        { messageName: message.Name, queueUrl: desc.url, asked: policy.maxRetries, maxReceiveCount: limit, maxRetries },
        '${messageName} asks for ${asked} retries, but the redrive policy of FIFO queue ${queueUrl} has maxReceiveCount ${maxReceiveCount}: the transport dead-letters it after ${maxRetries}. Raise maxReceiveCount above ${asked} + 1 or lower the RetryCount',
      );
    }

    return { ...policy, maxRetries };
  }

  /** The MessageGroupId of a FIFO send: the value of the message field the routing `groupBy` names. */
  protected groupIdOf(message: IQueueMessage): string {
    // without the routing schema a configuration file can give any value here
    const field: unknown = this.getRouteOption(message, 'groupBy');
    if (typeof field !== 'string' || field.trim() === '') {
      throw new InvalidArgument(`${message.Name}: a message sent to an SQS FIFO queue needs queue.routing.${message.Name}.groupBy, the message field whose value is the MessageGroupId`);
    }

    const id = groupIdValue(Reflect.get(message, field));
    if (id === '') {
      throw new InvalidArgument(`${message.Name}: the groupBy field ${field} holds no MessageGroupId ( a non-empty string or a number )`);
    }
    if (!SQS_ID.test(id)) {
      throw new InvalidArgument(`${message.Name}: the groupBy field ${field} holds a MessageGroupId SQS refuses ( 1 to 128 ASCII letters, digits or punctuation )`);
    }
    return id;
  }

  protected sendParams(url: string, message: IQueueMessage, o: SqsSendOptions = {}): SendMessageCommandInput {
    const params: SendMessageCommandInput = { QueueUrl: url, MessageBody: JSON.stringify(message) };
    const headers = o.headers ?? {};

    if (this.isFifo(url)) {
      params.MessageGroupId = o.groupId ?? this.groupIdOf(message);
      // without one SQS takes the send only on a queue with content-based deduplication
      const dedupId = o.dedupId ?? message.MessageId;
      if (dedupId) params.MessageDeduplicationId = toDedupId(dedupId);
      if (toDelayMs(o.delayMs) > 0) {
        this.Log.warn({ messageName: message.Name, queueUrl: url }, '${messageName}: the SQS FIFO queue ${queueUrl} takes no per-message delay, the message is sent without it');
      }
      params.MessageAttributes = toMessageAttributes(message, headers);
      return params;
    }

    const now = this.now();
    const delayMs = toDelayMs(o.notBefore !== undefined ? o.notBefore - now : o.delayMs);
    const notBefore = o.notBefore ?? (delayMs > MAX_SQS_DELAY_MS ? now + delayMs : undefined);
    if (delayMs > 0) params.DelaySeconds = Math.min(Math.ceil(delayMs / 1000), MAX_SQS_DELAY_MS / 1000);
    params.MessageAttributes = toMessageAttributes(message, notBefore === undefined ? headers : { ...headers, [NOT_BEFORE_ATTRIBUTE]: String(notBefore) });
    return params;
  }

  public async subscribe(channelOrMessage: string | Constructor<QueueMessage>, callback: (e: IQueueMessage) => Promise<void>, _subscriptionId?: string, _durable?: boolean): Promise<void> {
    // mirror STOMP's overload handling: a raw string is the queue URL itself,
    // a message class is resolved through the routing table.
    const urls = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);
    const key = _.isString(channelOrMessage) ? channelOrMessage : channelOrMessage.name;

    if (urls.length === 0 || urls.some((url) => !url)) {
      throw new InvalidArgument(`No SQS queue URL for ${key} on connection ${this.Options.name}: set a queue.routing entry, defaultQueueChannel or defaultTopicChannel`);
    }

    // before any poll loop starts, so a refused subscription leaves nothing behind
    if (this.RetryMode === 'transport') {
      const maxRetries = _.isString(channelOrMessage) ? 0 : (this.getMaxRetriesForMessage(channelOrMessage) ?? 0);
      for (const url of urls.filter((u) => this.isFifo(u))) {
        await this.checkFifoRedrive(url, maxRetries);
      }
    }

    urls.forEach((url) => {
      const existing = this.Subscriptions.get(url);

      if (existing) {
        if (existing.handlers.has(key)) {
          this.Log.warn({ queueUrl: url }, 'SQS queue ${queueUrl} already subscribed !');
        } else {
          existing.handlers.set(key, callback);
          this.Log.success({ queueUrl: url, key }, 'SQS queue ${queueUrl} subscribed for ${key} on the existing poll loop !');
        }
        return;
      }

      const handlers = new Map([[key, callback]]);
      const desc: ISqsSubscriptionDescriptor = {
        url,
        handlers,
        callback: async (e) => {
          for (const h of [...handlers.values()]) {
            await h(e);
          }
        },
        running: true,
        controller: new AbortController(),
        exited: false,
      };

      this.Subscriptions.set(url, desc);

      // detached loop - subscribe returns as soon as the poll loop is started,
      // it is NOT awaited. Errors inside the loop must never escape ( there is no
      // caller to catch them ), so pollLoop swallows/logs everything itself.
      const loop = this.pollLoop(desc).finally(() => this.Loops.delete(loop));
      this.Loops.add(loop);

      this.Log.success({ queueUrl: url }, 'SQS queue ${queueUrl} subscribed and polling for messages !');
    });
  }

  /**
   * Long-poll loop for a single subscription. Runs until `desc.running` is cleared
   * ( by unsubscribe / dispose ). Each received message goes to {@link handleMessage}.
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
              MessageAttributeNames: ['All'],
              MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
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
          this.Log.warn({ error: err, queueUrl: desc.url, connection: this.Options.name, backoff }, 'SQS receive error on ${queueUrl} ( ${connection} ), backing off ${backoff}ms');
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
            this.Log.error({ error: err, queueUrl: desc.url, connection: this.Options.name }, 'Unexpected error handling SQS message on ${queueUrl} ( ${connection} ), skipping');
          }
        }
      }
    } catch (err) {
      // last-resort guard: even the loop scaffolding ( e.g. an unexpected throw from
      // the receive-error branch ) must not reject the detached promise.
      this.Log.error({ error: err, queueUrl: desc.url, connection: this.Options.name }, 'SQS poll loop for ${queueUrl} ( ${connection} ) crashed unexpectedly');
    } finally {
      desc.exited = true;
      this.Log.trace({ queueUrl: desc.url, connection: this.Options.name }, 'SQS poll loop for ${queueUrl} ( ${connection} ) stopped');
    }
  }

  /**
   * Processes a single received SQS message: parse -> rehydrate -> handler -> ack.
   * A handler failure or an unparseable body is left for the visibility timeout and the redrive policy
   * in 'redrive' mode, and decided by {@link executeDecision} in 'transport' mode. A crash is never decided.
   */
  protected async handleMessage(desc: ISqsSubscriptionDescriptor, m: SqsReceived): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(m.Body!);
    } catch (e) {
      await this.handleUnparseable(desc, m, e);
      return;
    }

    // JSON.parse also yields null, numbers, strings and booleans, which carry no message
    if (!parsed || typeof parsed !== 'object') {
      await this.handleUnparseable(desc, m, new TypeError('the body is not a JSON object'));
      return;
    }

    const message = parsed as IQueueMessage;

    // luxon DateTime serializes to an ISO string over the wire - rehydrate it
    if (typeof (message.CreatedAt as unknown) === 'string') {
      message.CreatedAt = DateTime.fromISO(message.CreatedAt as unknown as string);
    }

    const attributes = readMessageAttributes(m.MessageAttributes);
    message.MessageId = message.MessageId ?? attributes[QueueHeaders.MessageId];
    const standard = readQueueHeaders(attributes);
    if (message.Headers || Object.keys(standard).length > 0) message.Headers = { ...message.Headers, ...standard };

    const attempt = this.attemptOf(desc, m, message);

    const notBefore = Number(attributes[NOT_BEFORE_ATTRIBUTE]);
    const now = this.now();
    // the transport never writes a deadline past the timer limit; a later one would be re-sent every 15 minutes for ever
    if (!this.isFifo(desc.url) && Number.isFinite(notBefore) && notBefore > now && notBefore <= now + MAX_TIMER_MS) {
      await this.sendMessage(this.sendParams(desc.url, message, { notBefore }));
      await this.deleteMessage(desc.url, m.ReceiptHandle);
      return;
    }

    try {
      await desc.callback(message);
    } catch (err) {
      await this.handleFailure(desc, m, message, attempt, err);
      return;
    }

    // ACK: only delete once the handler has fully succeeded. A delete failure is
    // non-fatal ( at-least-once: SQS will simply redeliver ) and is logged
    // distinctly so it is never mistaken for a handler failure.
    try {
      await this.deleteMessage(desc.url, m.ReceiptHandle);
      this.Log.trace({ messageType: message.Type, messageName: message.Name, queueUrl: desc.url, connection: this.Options.name }, 'Processed and acked ${messageType} Name: ${messageName} from ${queueUrl} ( ${connection} )');
    } catch (err) {
      this.Log.error({ error: err, messageName: message.Name, queueUrl: desc.url, connection: this.Options.name }, 'ack/delete failed for message ${messageName} on ${queueUrl} ( ${connection} ), it will redeliver');
    }
  }

  /**
   * The received copy's attempt. On FIFO in transport mode the receive count is the only attempt counter:
   * it is also written to the message's `x-retry-count`, so the handler sees it as on the other transports.
   */
  protected attemptOf(desc: ISqsSubscriptionDescriptor, m: SqsReceived, message: IQueueMessage): number {
    if (!this.isFifo(desc.url) || this.RetryMode !== 'transport') return retryCountOf(message.Headers);

    const attempt = this.receiveCountOf(m) - 1;
    if (attempt > 0) message.Headers = { ...message.Headers, [QueueHeaders.RetryCount]: String(attempt) };
    return attempt;
  }

  protected async handleFailure(desc: ISqsSubscriptionDescriptor, m: SqsReceived, message: IQueueMessage, attempt: number, error: unknown): Promise<void> {
    if (isCrash(error)) {
      this.Log.error({ error, messageName: message.Name, queueUrl: desc.url }, 'The consumer of ${messageName} on ${queueUrl} crashed; the message stays as it is until its visibility timeout ends');
      return;
    }

    if (this.RetryMode === 'redrive') {
      this.Log.error({ error, messageName: message.Name, queueUrl: desc.url }, 'Handler failed for ${messageName} on ${queueUrl}, leaving message for redelivery');
      return;
    }

    const policy = resolveDeliveryPolicy(this, message);
    await this.executeDecision(desc, m, message, decideDelivery(message, attempt, error, this.isFifo(desc.url) ? this.withinReceiveLimit(desc, message, policy) : policy));
  }

  protected receiveCountOf(m: SqsReceived): number {
    const count = Number(m.Attributes?.ApproximateReceiveCount);
    return Number.isInteger(count) && count >= 1 ? count : 1;
  }

  /** A body that is not a JSON object has no type and no route. Redrive mode leaves it to AWS; transport mode dead-letters it. */
  protected async handleUnparseable(desc: ISqsSubscriptionDescriptor, m: SqsReceived, cause: unknown): Promise<void> {
    if (this.RetryMode === 'redrive') {
      this.Log.error({ error: cause, queueUrl: desc.url, connection: this.Options.name }, 'Unparseable SQS message on ${queueUrl} ( ${connection} ), leaving for redelivery / DLQ');
      return;
    }

    const stand = unparseableMessage();
    const messageId = readMessageAttributes(m.MessageAttributes)[QueueHeaders.MessageId];
    const decision = decideDelivery(messageId ? { ...stand, MessageId: messageId } : stand, 0, new UnparseableMessageError(cause), resolveDeliveryPolicy(this, stand));
    await this.executeDecision(desc, m, stand, decision);
  }

  /**
   * A failed send, delete or visibility change propagates to the poll loop, which logs it, and the message comes
   * back after its visibility timeout. A delete that fails after a copy was sent leaves two copies: at least once.
   */
  protected async executeDecision(desc: ISqsSubscriptionDescriptor, m: SqsReceived, message: IQueueMessage, decision: DeliveryDecision): Promise<void> {
    if (decision.action === 'ack') {
      if (decision.dropped) {
        this.Log.warn({ messageName: message.Name, queueUrl: desc.url, reason: decision.reason }, 'Handler failed for ${messageName} on ${queueUrl}, dropping it. ${reason}');
      }
      await this.deleteMessage(desc.url, m.ReceiptHandle);
      return;
    }

    if (decision.action === 'dead-letter') {
      if (decision.channel) {
        const headers = { ...decision.headers, [QueueHeaders.OriginalDestination]: desc.url };
        // a FIFO dead letter keeps the group it was received in and needs a dedup id of its own
        const input = this.sendParams(decision.channel, message, { headers, groupId: m.Attributes?.MessageGroupId, dedupId: `${message.MessageId ?? m.MessageId ?? ''}:dead` });
        await this.sendMessage({ ...input, MessageBody: m.Body ?? '' });
      } else {
        this.Log.warn({ messageName: message.Name, queueUrl: desc.url, reason: decision.headers[QueueHeaders.Error] }, '${messageName} failed on ${queueUrl} and no dead-letter queue is configured - dropping. ${reason}');
      }
      await this.deleteMessage(desc.url, m.ReceiptHandle);
      return;
    }

    // a FIFO re-send would lose its place in the group, and SQS drops one whose dedup id it saw in the last 5 minutes
    if (this.isFifo(desc.url)) {
      await this.changeVisibility(desc.url, m.ReceiptHandle, Math.min(Math.ceil(decision.delayMs / 1000), MAX_FIFO_RETRY_SECONDS));
      return;
    }

    const copy = { ...message, Headers: { ...message.Headers, ...decision.headers } };
    await this.sendMessage(this.sendParams(desc.url, copy, { delayMs: decision.delayMs, headers: decision.headers }));
    await this.deleteMessage(desc.url, m.ReceiptHandle);
  }

  public unsubscribe(channelOrMessage: string | Constructor<QueueMessage>, _removeDurable?: boolean): void {
    const urls = _.isString(channelOrMessage) ? [channelOrMessage] : this.getChannelForMessage(channelOrMessage);

    urls.forEach((url) => {
      const desc = this.Subscriptions.get(url);

      if (!desc) {
        return;
      }

      // a message class leaves the loop to the other types still subscribed on the URL
      if (!_.isString(channelOrMessage)) {
        desc.handlers.delete(channelOrMessage.name);

        if (desc.handlers.size !== 0) {
          return;
        }
      }

      this.stop(desc);
      this.Subscriptions.delete(url);

      this.Log.info({ queueUrl: url, connection: this.Options.name }, 'Unsubscribed from SQS queue ${queueUrl} ( ${connection} )');
    });
  }

  public async dispose(): Promise<void> {
    // stop every poll loop and interrupt any in-flight long poll so this returns
    // promptly instead of waiting up to WaitTimeSeconds for the last receive.
    for (const desc of this.Subscriptions.values()) {
      this.stop(desc);
    }

    this.Subscriptions.clear();

    // the abort reaches only ReceiveMessage: a handler already running still
    // finishes and needs the SQSClient for its DeleteMessage
    await Promise.all([...this.Loops]);

    this.Sqs?.destroy();

    this.Log.info({ connection: this.Options.name }, 'SQS queue client ${connection} disposed');
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
