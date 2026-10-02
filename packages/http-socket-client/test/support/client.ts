import { SocketClient, type SocketClientOptions } from '../../src/client.js';
import { track } from './cleanup.js';
import { FAST_RECONNECT } from './connection.js';
import type { StubServer } from './stub-server.js';
import type { Stateful } from './wait.js';

export function makeClient(server: StubServer, overrides: Partial<SocketClientOptions> = {}): SocketClient {
  return track(new SocketClient({ url: server.url, clientId: 'client-1', reconnect: FAST_RECONNECT, io: { transports: ['websocket'] }, ...overrides }));
}

export function statefulClient(client: SocketClient): Stateful {
  return {
    get state() {
      return client.state;
    },
    onState: (listener) => client.on('state', listener),
  };
}
