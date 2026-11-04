import { emitClient, type GenerateClientOptions } from '../generate.js';
import { buildClientModel, type ClientModel } from './model.js';

export interface GeneratedFile {
  /** Relative to the directory of the client file. */
  path: string;
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
  keyPrefix?: string;
}

const HOOKS_TARGETS: readonly string[] = ['react-query', 'swr'];

interface Companion {
  requested(options: GenerateClientFilesOptions): boolean;
  emit(model: ClientModel, options: GenerateClientFilesOptions & { basename: string }): Promise<GeneratedFile[]>;
}

// Each target's emitter lands in its own task; until then a requested target writes no file.
const COMPANIONS: Companion[] = [
  { requested: (o) => (o.hooks?.length ?? 0) > 0, emit: () => Promise.resolve([]) },
  { requested: (o) => Boolean(o.zod), emit: () => Promise.resolve([]) },
];

function checkOptions(options: GenerateClientFilesOptions): void {
  const unknown = (options.hooks ?? []).find((h) => !HOOKS_TARGETS.includes(h));
  if (unknown !== undefined) throw new Error(`generateClientFiles: unknown hooks target '${unknown}'; use ${HOOKS_TARGETS.join(' or ')}`);
}

/** Generates `client.ts` and every companion file the options request, all from one manifest read. */
export async function generateClientFiles(options: GenerateClientFilesOptions): Promise<GeneratedFile[]> {
  checkOptions(options);
  const basename = options.basename ?? 'client';
  const model = buildClientModel(options.manifest);
  const companions = COMPANIONS.filter((c) => c.requested(options));
  const client = await emitClient(model, { moduleName: options.moduleName, includeSocket: options.includeSocket, manifestHash: companions.length > 0 });
  const files: GeneratedFile[] = [{ path: `${basename}.ts`, contents: client }];
  for (const companion of companions) files.push(...(await companion.emit(model, { ...options, basename })));
  return files;
}
