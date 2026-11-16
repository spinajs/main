import { companionHeader, manifestHashCheck } from './companion.js';
import type { ClientModel } from './model.js';

export interface ServerOptions {
  /** Import path of the runtime, default `@spinajs/client/runtime`. */
  moduleName?: string;
  /** File name of the client without extension, default `client`. */
  basename?: string;
}

/** `client.server.ts`: a per-request client for Server Components, loaders and route handlers. Server-safe: no React, no query library. */
export function emitServer(model: ClientModel, options: ServerOptions = {}): string {
  const lines = [
    companionHeader('server', model),
    `import { serverClientOptions, type ServerClientOptions } from '${options.moduleName ?? '@spinajs/client/runtime'}';`,
    `import { createAppClient, type AppClient, type manifestHash } from './${options.basename ?? 'client'}.js';`,
    '',
    ...manifestHashCheck(model),
    '',
    '/** `baseUrl` must be absolute. `incoming` is the request being served; `forward` lists the header names copied from it, default `cookie` and `authorization`. */',
    'export type ServerAppClientOptions = ServerClientOptions;',
    '',
    '/** Create one per request, and keep what it renders out of shared caches (`cache-control: private, no-store`). */',
    'export function createServerAppClient(options: ServerAppClientOptions): AppClient {',
    '  return createAppClient(serverClientOptions(options));',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}
