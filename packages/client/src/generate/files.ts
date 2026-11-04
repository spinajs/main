import { emitClient, type GenerateClientOptions } from '../generate.js';
import { emitKeys } from './hooks/keys.js';
import { emitReactContext } from './hooks/react.js';
import { emitSocketHooks, emitSwrSocketHooks } from './hooks/socket.js';
import { emitSwr } from './hooks/swr.js';
import { emitQueries, emitReactQuery } from './hooks/react-query.js';
import { hookRoutes, type HookRoute } from './hooks/shared.js';
import { buildClientModel, type ClientModel } from './model.js';
import { emitServer } from './server.js';

export interface GeneratedFile {
  /** Relative to the directory of the client file. */
  path: string;
  /** `client` files start with `'use client'`; `server-safe` files import neither React nor a `client` file. */
  environment: 'client' | 'server-safe';
  contents: string;
}

export interface ZodOptions {
  mini?: boolean;
  unsupported?: 'warn' | 'error';
}

export interface GenerateClientFilesOptions extends GenerateClientOptions {
  /** File name of the client without extension, default `client`; companion files are named `<basename>.<target>.ts`. */
  basename?: string;
  hooks?: ('react-query' | 'swr')[];
  zod?: boolean | ZodOptions;
  models?: boolean;
  socketHooks?: boolean;
  /** First segment of every query key and cache tag, default `spinajs`. */
  keyPrefix?: string;
  /** Writes `client.server.ts`, with `createServerAppClient` for Server Components and loaders. */
  server?: boolean;
}

type HooksTarget = NonNullable<GenerateClientFilesOptions['hooks']>[number];

const HOOKS_TARGET_SET: Record<HooksTarget, true> = { 'react-query': true, swr: true };

const HOOKS_TARGETS = Object.keys(HOOKS_TARGET_SET) as HooksTarget[];

export type GeneratorTarget = HooksTarget | 'zod' | 'models' | 'socket-hooks' | 'server';

/** Whether each target's emitter has landed; the CLI refuses a requested target that is not available. */
export const GENERATOR_TARGETS: Readonly<Record<GeneratorTarget, { readonly available: boolean }>> = {
  'react-query': { available: true },
  swr: { available: true },
  zod: { available: false },
  models: { available: false },
  'socket-hooks': { available: true },
  server: { available: true },
};

// `hookRoutes` is built once, so every hooks file prints the same routes.
type EmitOptions = GenerateClientFilesOptions & { basename: string; hookRoutes: HookRoute[] };

type Emitter = (model: ClientModel, options: EmitOptions) => Promise<GeneratedFile[]>;

const noFiles: Emitter = () => Promise.resolve([]);

// Both hook libraries read these two files, so they are written once whichever libraries are requested.
const hooksShared: Emitter = (model, options) =>
  Promise.resolve([
    { path: `${options.basename}.keys.ts`, environment: 'server-safe', contents: emitKeys(model, options) },
    { path: `${options.basename}.react.ts`, environment: 'client', contents: emitReactContext(model, options) },
  ]);

const swrFile: Emitter = (model, options) => Promise.resolve([{ path: `${options.basename}.swr.ts`, environment: 'client', contents: emitSwr(model, options.hookRoutes, options) }]);

const reactQuery: Emitter = (model, options) =>
  Promise.resolve([
    { path: `${options.basename}.queries.ts`, environment: 'server-safe', contents: emitQueries(model, options.hookRoutes, options) },
    { path: `${options.basename}.react-query.ts`, environment: 'client', contents: emitReactQuery(model, options.hookRoutes, options) },
  ]);

// Their own files, not the hooks files: both libraries share the event and stream hooks, which an app using both would otherwise get twice.
const socketHooksFiles: Emitter = (model, options) =>
  Promise.resolve([
    { path: `${options.basename}.socket.ts`, environment: 'client', contents: emitSocketHooks(model, options) },
    ...(options.hooks?.includes('swr') ? [{ path: `${options.basename}.socket-swr.ts`, environment: 'client' as const, contents: emitSwrSocketHooks(model, options) }] : []),
  ]);

const serverFile: Emitter = (model, options) => Promise.resolve([{ path: `${options.basename}.server.ts`, environment: 'server-safe', contents: emitServer(model, options) }]);

// The targets that write their own files; `models` adds to client.ts.
const COMPANIONS: Partial<Record<GeneratorTarget, Emitter>> = { 'react-query': reactQuery, swr: swrFile, zod: noFiles, 'socket-hooks': socketHooksFiles, server: serverFile };

export function requestedTargets(options: GenerateClientFilesOptions): GeneratorTarget[] {
  const requested: Record<GeneratorTarget, boolean> = {
    'react-query': options.hooks?.includes('react-query') ?? false,
    swr: options.hooks?.includes('swr') ?? false,
    zod: !!options.zod,
    models: !!options.models,
    'socket-hooks': !!options.socketHooks,
    server: !!options.server,
  };
  return (Object.keys(GENERATOR_TARGETS) as GeneratorTarget[]).filter((t) => requested[t]);
}

function checkOptions(options: GenerateClientFilesOptions): void {
  const hooks: readonly string[] = options.hooks ?? [];
  const unknown = hooks.find((h) => !(HOOKS_TARGETS as readonly string[]).includes(h));
  if (unknown !== undefined) throw new Error(`generateClientFiles: unknown hooks target '${unknown}'; use ${HOOKS_TARGETS.join(' or ')}`);
  const twice = hooks.find((h, i) => hooks.indexOf(h) !== i);
  if (twice !== undefined) throw new Error(`generateClientFiles: hooks target '${twice}' is listed twice`);
  if (options.socketHooks && hooks.length === 0) throw new Error('generateClientFiles: socketHooks needs hooks, which pick the flavour of the socket hooks');
  if (options.socketHooks && options.includeSocket === false) throw new Error('generateClientFiles: socketHooks needs the socket contracts, which includeSocket: false leaves out of client.ts');
  if (options.keyPrefix === '') throw new Error('generateClientFiles: keyPrefix must not be empty');
}

export function assertUniquePaths(files: GeneratedFile[]): void {
  const twice = files.find((f, i) => files.findIndex((g) => g.path === f.path) !== i);
  if (twice) throw new Error(`generateClientFiles: two emitters write ${twice.path}`);
}

/** Generates `client.ts` and every companion file the options request, all from one manifest read. */
export async function generateClientFiles(options: GenerateClientFilesOptions): Promise<GeneratedFile[]> {
  checkOptions(options);
  const basename = options.basename ?? 'client';
  const model = buildClientModel(options.manifest, { includeSocket: options.includeSocket });
  const targets = requestedTargets(options);
  const emitters = [...(options.hooks?.length ? [hooksShared] : []), ...targets.flatMap((t) => COMPANIONS[t] ?? [])];
  const client = await emitClient(model, { moduleName: options.moduleName, manifestHash: emitters.length > 0 });
  const files: GeneratedFile[] = [{ path: `${basename}.ts`, environment: 'server-safe', contents: client }];
  const routes = options.hooks?.length ? hookRoutes(model, options) : [];
  for (const emit of emitters) files.push(...(await emit(model, { ...options, basename, hookRoutes: routes })));
  assertUniquePaths(files);
  return files;
}
