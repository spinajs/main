import { emitClient, type GenerateClientOptions } from '../generate.js';
import { buildClientModel, type ClientModel } from './model.js';
import type { GeneratorDiagnostic } from './zod/diagnostics.js';
import { emitMocks } from './mocks.js';
import { emitMsw } from './msw.js';
import { emitZod } from './zod/emit.js';

export interface GeneratedFile {
  /** Relative to the directory of the client file. */
  path: string;
  contents: string;
  /** What the emitter could not reproduce of the server's validation. */
  diagnostics?: GeneratorDiagnostic[];
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
  keyPrefix?: string;
  /** Writes `<basename>.mocks.ts`: schema-driven mock data and a typed fake client, imported by no other generated file. */
  mocks?: boolean;
  /** Writes `<basename>.msw.ts`: one MSW handler per route, answering with the data of `<basename>.mocks.ts`; needs `mocks`. */
  msw?: boolean;
}

type HooksTarget = NonNullable<GenerateClientFilesOptions['hooks']>[number];

const HOOKS_TARGETS = ['react-query', 'swr'] as const satisfies readonly HooksTarget[];

export type GeneratorTarget = HooksTarget | 'zod' | 'models' | 'socket-hooks' | 'mocks' | 'msw';

/** Whether each target's emitter has landed; the CLI refuses a requested target that is not available. */
export const GENERATOR_TARGETS: Readonly<Record<GeneratorTarget, { readonly available: boolean }>> = {
  'react-query': { available: false },
  swr: { available: false },
  zod: { available: true },
  models: { available: false },
  'socket-hooks': { available: false },
  mocks: { available: true },
  msw: { available: true },
};

type Emitter = (model: ClientModel, options: GenerateClientFilesOptions & { basename: string }) => Promise<GeneratedFile[]>;

const noFiles: Emitter = () => Promise.resolve([]);

const zodFile: Emitter = (model, options) => {
  const { contents, diagnostics } = emitZod(model, typeof options.zod === 'object' ? options.zod : {}, `./${options.basename}.js`);
  return Promise.resolve([{ path: `${options.basename}.zod.ts`, contents, diagnostics }]);
};

const mocksFile: Emitter = (model, options) => {
  const { contents, diagnostics } = emitMocks(model, `./${options.basename}.js`);
  return Promise.resolve([{ path: `${options.basename}.mocks.ts`, contents, diagnostics }]);
};

const mswFile: Emitter = (model, options) => Promise.resolve([{ path: `${options.basename}.msw.ts`, contents: emitMsw(model, `./${options.basename}.js`, `./${options.basename}.mocks.js`).contents }]);

// The targets that write their own file; `models` and `socket-hooks` add to client.ts and the hooks files.
const COMPANIONS: Partial<Record<GeneratorTarget, Emitter>> = { 'react-query': noFiles, swr: noFiles, zod: zodFile, mocks: mocksFile, msw: mswFile };

export function requestedTargets(options: GenerateClientFilesOptions): GeneratorTarget[] {
  return [...(options.hooks ?? []), ...(options.zod ? (['zod'] as const) : []), ...(options.models ? (['models'] as const) : []), ...(options.socketHooks ? (['socket-hooks'] as const) : []), ...(options.mocks ? (['mocks'] as const) : []), ...(options.msw ? (['msw'] as const) : [])];
}

function checkOptions(options: GenerateClientFilesOptions): void {
  const hooks: readonly string[] = options.hooks ?? [];
  const unknown = hooks.find((h) => !(HOOKS_TARGETS as readonly string[]).includes(h));
  if (unknown !== undefined) throw new Error(`generateClientFiles: unknown hooks target '${unknown}'; use ${HOOKS_TARGETS.join(' or ')}`);
  const twice = hooks.find((h, i) => hooks.indexOf(h) !== i);
  if (twice !== undefined) throw new Error(`generateClientFiles: hooks target '${twice}' is listed twice`);
  if (options.msw && !options.mocks) throw new Error('generateClientFiles: msw needs mocks, because the handlers answer with the data of the mocks file');
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
