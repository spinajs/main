import { expect } from 'chai';
import { SocketException } from '@spinajs/http-socket-common';
import { CommandDispatcher } from '../../src/commands.js';
import type { Connection } from '../../src/connection.js';
import { makeConnection, statefulConnection } from './connection.js';
import type { StubServer } from './stub-server.js';
import { waitForState } from './wait.js';

export async function onlineDispatcher(server: StubServer, timeoutMs = 1000): Promise<{ connection: Connection; commands: CommandDispatcher }> {
  const connection = makeConnection(server);
  const commands = new CommandDispatcher(connection, timeoutMs);
  connection.connect();
  await waitForState(statefulConnection(connection), 'online');
  return { connection, commands };
}

export async function rejectionOf(promise: Promise<unknown>): Promise<SocketException> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(SocketException);
    return error as SocketException;
  }
  throw new Error('expected the promise to reject');
}
