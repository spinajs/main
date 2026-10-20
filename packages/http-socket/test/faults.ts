import 'mocha';
import { AddressInfo } from 'net';
import { DI, Injectable } from '@spinajs/di';
import { ISocketCommandContext, SocketCommandStage } from '../src/interfaces.js';
import { SocketServer } from '../src/server.js';
import { ITestServer, delay, startServer } from './harness.js';

// a hard transport close is what a network drop looks like to the server, and socket.io recovers it
const drop = (socket?: { conn: { transport: { close(): void } } }) => socket?.conn.transport.close();

/** Closes every engine.io connection without a socket.io DISCONNECT, as a network drop does; recovery may restore them. */
export function killConnections(t: ITestServer): number {
  const sockets = [...(t.server.Io?.of('/').sockets.values() ?? [])];
  sockets.forEach((socket) => drop(socket));
  return sockets.length;
}

export function killConnection(t: ITestServer, connectionId: string): boolean {
  const socket = t.server.Io?.of('/').sockets.get(connectionId);
  drop(socket);
  return socket !== undefined;
}

export const ackFaults = {
  /** the next `drop` commands lose their reply: the transport is killed right after the handler settled */
  drop: 0,
  /** every reply waits this long */
  delayMs: 0,
  reset(): void {
    this.drop = 0;
    this.delayMs = 0;
  },
};

/** Outermost stage of every test server; does nothing while `ackFaults` is reset. */
@Injectable(SocketCommandStage)
export class FaultKitStage extends SocketCommandStage {
  public get Order(): number {
    return 10;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    try {
      return await next();
    } finally {
      if (ackFaults.delayMs > 0) {
        await Promise.race([delay(ackFaults.delayMs), new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))]);
      }

      if (ackFaults.drop > 0) {
        ackFaults.drop--;
        drop(DI.get(SocketServer)?.Io?.of('/').sockets.get(ctx.connection.id));
      }
    }
  }
}

/** Runs the server's shutdown, then starts a fresh one on the same port; memory stores are lost, as in a real restart. */
export async function restart(t: ITestServer, cfg: Record<string, unknown> = t.cfg, downMs = 0): Promise<ITestServer> {
  const { port } = t.host.Http.address() as AddressInfo;
  await t.close();

  if (downMs > 0) {
    await delay(downMs);
  }

  return startServer(cfg, undefined, port);
}

afterEach(() => ackFaults.reset());
