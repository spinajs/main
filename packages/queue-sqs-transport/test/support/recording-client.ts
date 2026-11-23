import type { SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IQueueMessage } from '@spinajs/queue';
import { SqsQueueClient } from '../../src/index.js';

export const STANDARD = 'https://sqs.eu-central-1.amazonaws.com/1/orders';
export const FIFO = 'https://sqs.eu-central-1.amazonaws.com/1/orders.fifo';
export const DLQ = 'https://sqs.eu-central-1.amazonaws.com/1/orders-dlq';
export const FIFO_DLQ = 'https://sqs.eu-central-1.amazonaws.com/1/orders-dlq.fifo';

export interface Receipt {
  attributes?: Record<string, string>;
  system?: { ApproximateReceiveCount?: string; MessageGroupId?: string };
  handler?: (m: IQueueMessage) => Promise<void>;
}

export class RecordingSqsClient extends SqsQueueClient {
  public sent: SendMessageCommandInput[] = [];
  public deleted: string[] = [];
  public clockMs = 1_000_000;

  protected now(): number {
    return this.clockMs;
  }

  protected sendMessage(input: SendMessageCommandInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }

  protected deleteMessage(_url: string, receiptHandle: string | undefined): Promise<void> {
    this.deleted.push(receiptHandle ?? '');
    return Promise.resolve();
  }

  /** No poll loop: a test hands messages in through deliver(). */
  protected pollLoop(): Promise<void> {
    return Promise.resolve();
  }

  public deliver(url: string, body: string, receipt: Receipt = {}): Promise<void> {
    const MessageAttributes = Object.fromEntries(Object.entries(receipt.attributes ?? {}).map(([name, value]) => [name, { DataType: 'String', StringValue: value }]));
    return this.handleMessage(
      { url, callback: receipt.handler ?? (() => Promise.resolve()), handlers: new Map(), running: true, controller: new AbortController(), exited: false },
      { Body: body, ReceiptHandle: 'rh-1', MessageId: 'sqs-1', MessageAttributes, Attributes: receipt.system },
    );
  }

  public receive(url: string, message: IQueueMessage, receipt: Receipt = {}): Promise<void> {
    return this.deliver(url, JSON.stringify(message), receipt);
  }
}

function conf(routing: Record<string, unknown>) {
  return class extends FrameworkConfiguration {
    protected onLoad(): unknown {
      return { queue: { routing }, logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] } };
    }
  };
}

/** `options` and `routing` are untyped, as a configuration file gives them when no schema has run. */
export async function recordingClient(o: { queue: string; dlq?: string; options?: Record<string, unknown>; routing?: Record<string, unknown> }): Promise<RecordingSqsClient> {
  DI.clearCache();
  DI.register(conf(o.routing ?? {})).as(Configuration);
  await DI.resolve(Configuration);
  const client = new RecordingSqsClient({
    name: 'sqs',
    service: 'SqsQueueClient',
    defaultQueueChannel: o.queue,
    defaultTopicChannel: o.queue,
    defaultQueueDeadLetterChannel: o.dlq,
    options: { region: 'eu-central-1', ...o.options },
  });
  await client.resolve();
  return client;
}
