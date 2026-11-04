import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SwrPackage = 'swr' | 'swr-floor';

export interface ProbeClient {
  users: { get(id: number): Promise<unknown>; list(query: unknown): Promise<unknown>; create(body: unknown): Promise<unknown> };
  articles: { read(id: number): Promise<unknown> };
  health: { get(): Promise<unknown> };
}

export interface Trigger {
  trigger(arg: unknown): Promise<unknown>;
}

export interface MutationConfig {
  invalidate?: false | readonly (readonly unknown[])[];
  onSuccess?: (data: unknown) => void;
}

export interface LoadedHooks {
  useUsersGet(vars: { id: number } | null): { data?: unknown };
  useUsersList(vars: { query: object } | null): { data?: unknown };
  useUsersCreate(config?: MutationConfig): Trigger;
  useArticlesRead(vars: { id: number } | null): { data?: unknown };
  useHealthGet(vars?: Record<string, never> | null): { data?: unknown };
}

export interface LoadedSwr {
  hooks: LoadedHooks;
  appKeys: { users: { all: readonly unknown[]; get(vars: { id: number }): readonly unknown[] }; articles: { all: readonly unknown[] } };
  swr: {
    SWRConfig: unknown;
    default: (key: unknown, fetcher: () => unknown) => { data?: unknown };
    unstable_serialize(key: unknown): string;
  };
}

const swrUrl = (swr: SwrPackage, subpath = '') => import.meta.resolve(`${swr}${subpath}`);

const SWR_SPECIFIER = /^swr(\/|$)/;

/**
 * Loads the generated SWR hooks as real modules. `client.react.ts` becomes a stub that reads the client the test
 * sets on `globalThis`, and `swr` resolves to the requested copy.
 */
export async function loadSwrHooks(files: Record<string, string>, swr: SwrPackage): Promise<LoadedSwr> {
  const dir = mkdtempSync(join(tmpdir(), 'client-swr-'));
  const emit = (name: string, source: string) => {
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    const rewritten = outputText.replace(/from (['"])([^'"]+)\1/g, (match, _quote: string, specifier: string) => {
      if (specifier === './client.keys.js') return "from './client.keys.mjs'";
      if (specifier === './client.react.js') return "from './client.react.mjs'";
      return SWR_SPECIFIER.test(specifier) ? `from '${swrUrl(swr, specifier.slice('swr'.length))}'` : match;
    });
    writeFileSync(join(dir, name), rewritten);
  };
  // swr-floor is an alias of swr 2.2.0, whose files import `swr/_internal`; that import has to stay inside the floor copy.
  const redirect = registerHooks({
    resolve: (specifier, context, next) =>
      swr === 'swr-floor' && context.parentURL?.includes('/node_modules/swr-floor/') && SWR_SPECIFIER.test(specifier) ? next(specifier.replace(/^swr/, 'swr-floor'), context) : next(specifier, context),
  });
  try {
    emit('client.keys.mjs', files['client.keys.ts']);
    emit('client.swr.mjs', files['client.swr.ts']);
    writeFileSync(join(dir, 'client.react.mjs'), 'export const useAppClient = () => globalThis.__swrProbeClient;\n');
    const [hooks, keys, lib] = await Promise.all([
      import(pathToFileURL(join(dir, 'client.swr.mjs')).href) as Promise<LoadedHooks>,
      import(pathToFileURL(join(dir, 'client.keys.mjs')).href) as Promise<Pick<LoadedSwr, 'appKeys'>>,
      import(swrUrl(swr)) as Promise<LoadedSwr['swr']>,
    ]);
    return { hooks, appKeys: keys.appKeys, swr: lib };
  } finally {
    redirect.deregister();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function setProbeClient(client: ProbeClient): void {
  (globalThis as { __swrProbeClient?: ProbeClient }).__swrProbeClient = client;
}
