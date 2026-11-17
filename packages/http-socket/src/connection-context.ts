import type { Socket } from 'socket.io';

const KEY = 'context';

const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';

export function storeConnectionContext(socket: Socket, context: Readonly<Record<string, unknown>>): void {
  const data: unknown = socket.data;
  if (isObject(data)) Reflect.set(data, KEY, { ...context });
}

/** Empty for a socket whose stored state predates the key. */
export function connectionContextOf(socket: Socket): Readonly<Record<string, unknown>> {
  const data: unknown = socket.data;
  const context: unknown = isObject(data) ? Reflect.get(data, KEY) : undefined;
  return isObject(context) ? { ...context } : {};
}
