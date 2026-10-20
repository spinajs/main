import { Connection, type ConnectionOptions } from '../../src/connection.js';
import { track } from './cleanup.js';
import type { StubServer } from './stub-server.js';
import type { Stateful } from './wait.js';

/** Retries after 20, 40, 80, 100, 100 … ms; no jitter, so timings are exact. */
export const FAST_RECONNECT = { minMs: 20, maxMs: 100, jitter: 0 };

export function makeConnection(server: StubServer, overrides: Partial<ConnectionOptions> = {}): Connection {
  return track(new Connection({ url: server.url, clientId: 'client-1', reconnect: FAST_RECONNECT, io: { transports: ['websocket'] }, ...overrides } as ConnectionOptions));
}

export function statefulConnection(connection: Connection): Stateful {
  return {
    get state() {
      return connection.state;
    },
    onState: (listener) => connection.events.on('state', listener),
  };
}
