import { emitClient, type GenerateClientOptions } from '../generate.js';
import { buildClientModel, type ClientModel } from './model.js';

export interface GeneratedFile {
  /** Relative to the directory of the client file. */
  path: string;
  contents: string;
}

export interface ZodOptions {
  mini?: boolean;
  /** Lenient reply schemas next to the strict request schemas. */
  replies?: boolean;
  unsupported?: 'warn' | 'error';
}

export interface GenerateClientFilesOptions extends GenerateClientOptions {
  /** File name of the client without extension, default `client`; companion files are named `<basename>.<target>.ts`. */
  basename?: string;
  hooks?: ('react-query' | 'swr')[];
  zod?: boolean | ZodOptions;
  models?: boolean;
  socketHooks?: boolean;
  keyPrefix?: string;
  /** `client.server.ts`; implied by `next`. */
  server?: boolean;
  next?: boolean;
  mocks?: boolean;
  /** Adds `client.msw.ts`; needs `mocks`. */
  msw?: boolean;
}

type HooksTarget = NonNullable<GenerateClientFilesOptions['hooks']>[number];

const HOOKS_TARGETS = ['react-query', 'swr'] as const satisfies readonly HooksTarget[];

export type GeneratorTarget = HooksTarget | 'zod' | 'models' | 'socket-hooks' | 'server' | 'next' | 'mocks' | 'msw';

/** Whether each target's emitter has landed; the CLI refuses a requested target that is not available. */
export const GENERATOR_TARGETS: Readonly<Record<GeneratorTarget, { readonly available: boolean }>> = {
  'react-query': { available: false },
  swr: { available: false },
  zod: { available: false },
  models: { available: false },
  'socket-hooks': { available: false },
  server: { available: false },
  next: { available: false },
  mocks: { available: false },
  msw: { available: false },
};

type Emitter = (model: ClientModel, options: GenerateClientFilesOptions & { basename: string }) => Promise<GeneratedFile[]>;

const noFiles: Emitter = () => Promise.resolve([]);

// The targets that write their own file; `models` and `socket-hooks` add to client.ts and the hooks files.
const COMPANIONS: Partial<Record<GeneratorTarget, Emitter>> = { 'react-query': noFiles, swr: noFiles, zod: noFiles };

export function requestedTargets(options: GenerateClientFilesOptions): GeneratorTarget[] {
  const flags: [boolean | undefined, GeneratorTarget][] = [
    [options.zod !== undefined && options.zod !== false, 'zod'],
    [options.models, 'models'],
    [options.socketHooks, 'socket-hooks'],
    [options.server || options.next, 'server'],
    [options.next, 'next'],
    [options.mocks, 'mocks'],
    [options.msw, 'msw'],
  ];
  return [...(options.hooks ?? []), ...flags.flatMap(([on, target]) => (on ? [target] : []))];
}

function checkOptions(options: GenerateClientFilesOptions): void {
  const hooks: readonly string[] = options.hooks ?? [];
  const unknown = hooks.find((h) => !(HOOKS_TARGETS as readonly string[]).includes(h));
  if (unknown !== undefined) throw new Error(`generateClientFiles: unknown hooks target '${unknown}'; use ${HOOKS_TARGETS.join(' or ')}`);
  const twice = hooks.find((h, i) => hooks.indexOf(h) !== i);
  if (twice !== undefined) throw new Error(`generateClientFiles: hooks target '${twice}' is listed twice`);
  if (options.msw && !options.mocks) throw new Error('generateClientFiles: msw needs mocks, because the handlers are generated from the mocks');
  if (options.socketHooks && hooks.length === 0) throw new Error('generateClientFiles: socketHooks needs hooks, because socket hooks are added to the hooks files');
}

/** Generates `client.ts` and every companion file the options request, all from one manifest read. */
export async function generateClientFiles(options: GenerateClientFilesOptions): Promise<GeneratedFile[]> {
  checkOptions(options);
  const basename = options.basename ?? 'client';
  const model = buildClientModel(options.manifest, { includeSocket: options.includeSocket });
  const emitters = requestedTargets(options).flatMap((t) => COMPANIONS[t] ?? []);
  const client = await emitClient(model, { moduleName: options.moduleName, includeSocket: options.includeSocket, manifestHash: emitters.length > 0 });
  const files: GeneratedFile[] = [{ path: `${basename}.ts`, contents: client }];
  for (const emit of emitters) files.push(...(await emit(model, { ...options, basename })));
  return files;
}
