import type { ISocketServerConfig } from '../interfaces.js';

export interface ISocketConfigFile {
  http: { socket: ISocketServerConfig };
  system: { dirs: { socketControllers: string[] } };
}

const config: ISocketConfigFile = {
  http: {
    socket: {
      path: '/socket.io',
      cors: {
        origins: [],
      },
      auth: {
        required: false,
        revalidateMs: 60_000,
      },
      pingInterval: 25_000,
      pingTimeout: 20_000,
      recovery: {
        maxDisconnectionMs: 120_000,
      },
      maxPayloadBytes: 1024 * 1024,
      maxInFlightPerConnection: 32,
      maxInFlightEventsPerConnection: 128,
      rate: {
        perSecond: 50,
        burst: 100,
      },
      idempotency: {
        service: 'MemoryIdempotencyStore',
        ttlMs: 600_000,
        maxEntries: 100_000,
      },
      ordering: {
        abortGraceMs: 30_000,
      },
      hooks: {
        connectTimeoutMs: 10_000,
      },
      streams: {
        maxCredits: 64,
        maxPerConnection: 8,
        stallTimeoutMs: 60_000,
      },
      drainMs: 5_000,
      adapter: undefined,
      transports: ['websocket', 'polling'],
    },
  },
  system: {
    dirs: {
      // Keep socket controllers out of system.dirs.controllers: the http loader scans those.
      socketControllers: [],
    },
  },
};

export default config;
