import type { MessageAttributeValue } from '@aws-sdk/client-sqs';
import { QueueHeaders, type IQueueMessage } from '@spinajs/queue';

export const NOT_BEFORE_ATTRIBUTE = 'x-spinajs-not-before';
export const MAX_SQS_DELAY_MS = 900_000;

const MAX_ATTRIBUTES = 10;
// attributes count towards the SQS message size, and the body carries every header anyway
const MAX_ATTRIBUTES_BYTES = 8192;
const VALID_NAME = /^[A-Za-z0-9_.-]{1,256}$/;
const STANDARD: readonly string[] = Object.values(QueueHeaders);

// the characters SQS accepts in a string attribute value; a lone surrogate is none of them
const isSqsCharacter = (code: number): boolean => code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);

const usableValue = (value: string): boolean => value !== '' && [...value].every((c) => isSqsCharacter(c.codePointAt(0) ?? 0));

const usableName = (name: string): boolean => VALID_NAME.test(name) && !name.startsWith('.') && !name.endsWith('.') && !name.includes('..') && !/^(aws|amazon)\./i.test(name);

const attributeBytes = (name: string, value: string): number => Buffer.byteLength(name) + Buffer.byteLength('String') + Buffer.byteLength(value);

/**
 * Standard headers first, then the not-before deadline, then the other headers. SQS keeps at most 10 attributes,
 * and refuses empty values and some names and characters: what does not fit is left out.
 * The not-before deadline is the transport's own, so it is taken from `extra` only.
 */
export function toMessageAttributes(message: IQueueMessage, extra: Record<string, string> = {}): Record<string, MessageAttributeValue> {
  const headers = Object.entries(message.Headers ?? {}).filter(([name]) => name !== NOT_BEFORE_ATTRIBUTE);
  const all = new Map<string, unknown>([...(message.MessageId ? [[QueueHeaders.MessageId, message.MessageId] as const] : []), ...headers, ...Object.entries(extra)]);
  const names = [...all.keys()];
  const ordered = [...STANDARD.filter((n) => all.has(n)), ...names.filter((n) => n === NOT_BEFORE_ATTRIBUTE), ...names.filter((n) => !STANDARD.includes(n) && n !== NOT_BEFORE_ATTRIBUTE)];

  const result: Array<[string, MessageAttributeValue]> = [];
  let bytes = 0;
  for (const name of ordered) {
    if (result.length === MAX_ATTRIBUTES) break;
    // a body parsed from JSON may carry a header that is not a string
    const value = all.get(name);
    if (typeof value !== 'string' || !usableValue(value) || !usableName(name)) continue;
    const size = attributeBytes(name, value);
    if (bytes + size > MAX_ATTRIBUTES_BYTES) continue;
    bytes += size;
    result.push([name, { DataType: 'String', StringValue: value }]);
  }
  return Object.fromEntries(result);
}

export function readMessageAttributes(attributes: Record<string, MessageAttributeValue> | undefined): Record<string, string> {
  const result: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (typeof value.StringValue === 'string') result.push([name, value.StringValue]);
  }
  return Object.fromEntries(result);
}
