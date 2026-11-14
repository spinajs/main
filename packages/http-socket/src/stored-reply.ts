import type { StoredReply } from '@spinajs/idempotency';
import type { IdempotentReply } from './interfaces.js';

type Path = Array<string | number>;

interface IAttachment {
  path: Path;
  type: string;
  base64: string;
}

interface IBinaryReplyBody {
  reply: IdempotentReply;
  attachments: IAttachment[];
}

// A store keeps replies as JSON, which would turn a Buffer into an object of its bytes: binary parts are stored apart.
const BINARY_REPLY = 'socket-binary';

const VIEWS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function isBinary(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== 'undefined' && value instanceof Blob);
}

/** Mirrors socket.io-parser's check, which decides between JSON and binary attachments. */
export function hasBinary(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  if (isBinary(value)) {
    return true;
  }

  seen.add(value);
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return hasBinary(toJSON.call(value), seen);
  }

  return Object.values(value).some((item) => hasBinary(item, seen));
}

// a step through one of these would reach a prototype, never data of the reply
const UNSAFE_STEPS = new Set<unknown>(['__proto__', 'constructor', 'prototype']);

function attachment(value: ArrayBuffer | ArrayBufferView, path: Path): IAttachment {
  if (path.some((step) => UNSAFE_STEPS.has(step))) {
    throw new TypeError(`a binary part under ${path.join('.')} cannot be stored`);
  }
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // a Buffer replays as the Uint8Array a structured clone of it is
  const type = value instanceof ArrayBuffer ? 'ArrayBuffer' : Object.hasOwn(VIEWS, value.constructor.name) ? value.constructor.name : 'Uint8Array';
  return { path, type, base64: Buffer.from(bytes).toString('base64') };
}

/** `value` already is a wire value: plain objects, arrays, binary parts and values with toJSON ( a Date ), as JSON.stringify reads them. */
function detach(value: unknown, path: Path, out: IAttachment[]): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    out.push(attachment(value, path));
    return null;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    throw new TypeError('a reply holding a Blob cannot be stored');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  // JSON.stringify calls toJSON once per value, so a toJSON that returns its own object ends here too
  const json: unknown = typeof toJSON === 'function' ? toJSON.call(value) : value;
  if (json !== value) {
    return detach(json, path, out);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown, index) => detach(item, [...path, index], out));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detach(item, [...path, key], out)]));
}

function binaryOf(part: IAttachment): ArrayBuffer | ArrayBufferView {
  if (typeof part.base64 !== 'string' || !(part.type === 'ArrayBuffer' || Object.hasOwn(VIEWS, part.type))) {
    throw new TypeError(`a stored binary part has an unknown type ${String(part.type)}`);
  }
  // a copy: a decoded Buffer may sit in Node's shared pool
  const buffer = new Uint8Array(Buffer.from(part.base64, 'base64')).buffer;
  return part.type === 'ArrayBuffer' ? buffer : new VIEWS[part.type](buffer);
}

/** The container one step of a stored path names: own data of the reply only. */
function stepInto(target: unknown, step: unknown): Record<string | number, unknown> {
  if (target === null || typeof target !== 'object' || !(typeof step === 'string' || typeof step === 'number') || UNSAFE_STEPS.has(step) || !Object.hasOwn(target, step)) {
    throw new TypeError(`a stored binary part has a path the reply does not hold (${String(step)})`);
  }
  return target as Record<string | number, unknown>;
}

function attach(reply: IdempotentReply, part: IAttachment): void {
  if (!Array.isArray(part?.path) || part.path.length === 0) {
    throw new TypeError('a stored binary part has no path');
  }
  let target: unknown = reply;
  for (const step of part.path.slice(0, -1)) {
    target = stepInto(target, step)[step];
  }
  const last = part.path[part.path.length - 1];
  stepInto(target, last)[last] = binaryOf(part);
}

export function toStoredReply(reply: IdempotentReply): StoredReply {
  if (!hasBinary(reply)) {
    return { kind: 'socket', body: reply };
  }
  const attachments: IAttachment[] = [];
  const body: IBinaryReplyBody = { reply: detach(reply, [], attachments) as IdempotentReply, attachments };
  return { kind: BINARY_REPLY, body };
}

/** Throws for a stored reply that is not one `toStoredReply` wrote. */
export function fromStoredReply(stored: StoredReply): IdempotentReply {
  if (stored.kind !== BINARY_REPLY) {
    return stored.body as IdempotentReply;
  }
  const { reply, attachments } = (stored.body ?? {}) as Partial<IBinaryReplyBody>;
  if (reply === null || typeof reply !== 'object' || !Array.isArray(attachments)) {
    throw new TypeError('a stored binary reply has no reply or no attachments');
  }
  for (const part of attachments) {
    attach(reply, part);
  }
  return reply;
}
