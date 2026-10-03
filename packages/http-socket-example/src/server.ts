import '@spinajs/log';
import { createServer, Server as NodeHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { SocketHttpHost, SocketServer } from '@spinajs/http-socket';
import { NotesStore } from './store.js';
import './auth.js';
import './notes.socket.js';

/** socket.io attaches to this plain node http server. An app on @spinajs/http needs no host of its own: the default HttpServerHost uses that server. */
export class NotesHttpHost extends SocketHttpHost {
  public readonly Http: NodeHttpServer = createServer();

  public async server(): Promise<NodeHttpServer> {
    return this.Http;
  }
}

DI.register(NotesHttpHost).as(SocketHttpHost);

export interface INotesServerOptions {
  /** 0 or absent: a free port */
  port?: number;
  /** log to the console; tests keep it quiet */
  verbose?: boolean;
  /** merged over this example's `http.socket` settings */
  socket?: Record<string, unknown>;
}

// one notes server per process: DI and this configuration are process-wide, so a second start replaces the first one's options
let current: INotesServerOptions = {};

/** The example's settings, merged over the package defaults ( `http.socket` of @spinajs/http-socket ). */
export class NotesConfiguration extends FrameworkConfiguration {
  protected onLoad(): unknown {
    const verbose = current.verbose === true;

    return {
      logger: {
        targets: [verbose ? { name: 'Console', type: 'ConsoleTarget' } : { name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: verbose ? 'info' : 'trace', target: verbose ? 'Console' : 'Empty' }],
      },
      http: {
        socket: {
          // a handshake without one of the demo tokens is refused instead of running as UNATTENDED
          auth: { required: true, revalidateMs: 60_000 },
          streams: { maxCredits: 16 },
          ...current.socket,
        },
      },
    };
  }
}

export interface INotesServer {
  url: string;
  path: string;
  server: SocketServer;
  store: NotesStore;
  close(): Promise<void>;
}

export async function startNotesServer(options: INotesServerOptions = {}): Promise<INotesServer> {
  current = options;
  DI.clearCache();
  // without it the config sources look for the cjs builds and cannot require them in an ES module, so the package defaults never load
  DI.setESMModuleSupport();
  DI.register(NotesConfiguration).as(Configuration);
  await DI.resolve(Configuration);

  const host = DI.resolve(SocketHttpHost) as NotesHttpHost;
  const server = await DI.resolve(SocketServer);
  await new Promise<void>((resolve) => host.Http.listen(options.port ?? 0, '127.0.0.1', () => resolve()));
  const { port } = host.Http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    path: DI.get(Configuration)!.get<string>('http.socket.path'),
    server,
    store: DI.resolve(NotesStore) as NotesStore,
    close: async () => {
      await server.dispose();
      host.Http.closeAllConnections();
      await new Promise<void>((resolve) => host.Http.close(() => resolve()));
    },
  };
}
