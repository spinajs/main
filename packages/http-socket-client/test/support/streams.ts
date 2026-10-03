import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { StreamDispatcher } from '../../src/streams.js';
import { makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { waitForState } from './wait.js';

/** Streams on a connection, with ids from a CommandDispatcher as SocketClient wires them. */
export function streamsOn(connection: Connection, timeoutMs = 1000): StreamDispatcher {
  const commands = new CommandDispatcher(connection, timeoutMs);
  return new StreamDispatcher(connection, () => commands.nextId(), timeoutMs);
}

export async function onlineStreams(server: StubServer, timeoutMs = 1000): Promise<{ connection: Connection; streams: StreamDispatcher }> {
  const connection = makeConnection(server);
  const streams = streamsOn(connection, timeoutMs);
  connection.connect();
  await waitForState(statefulConnection(connection), 'online');
  return { connection, streams };
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** Reads until the stream fails; resolves with the items read and the rejection. */
export async function readUntilFailure<T>(items: AsyncIterable<T>): Promise<{ items: T[]; error: unknown }> {
  const out: T[] = [];
  try {
    for await (const item of items) out.push(item);
  } catch (error) {
    return { items: out, error };
  }
  throw new Error('expected the stream to fail');
}
