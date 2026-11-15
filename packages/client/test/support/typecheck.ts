import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SwrVersion = 'floor' | 'latest';

export interface TypecheckOptions {
  noUnusedLocals?: boolean;
  noUnusedParameters?: boolean;
  /** Major of the React types `react` resolves to; the peer range covers both. Default 19. */
  react?: 18 | 19;
  /** Which swr the `swr` imports resolve to: the peer floor (2.2.0) or the installed latest. Default latest. */
  swr?: SwrVersion;
  /** `@tanstack/react-query` at the peer floor (5.0.0) or the pinned latest. Default latest. */
  reactQuery?: ReactQueryVersion;
}

export type ReactQueryVersion = 'floor' | 'latest';

const require = createRequire(import.meta.url);
const REACT_TYPES = { 18: '@types/react-18', 19: '@types/react' } as const;
const reactTypes = (major: 18 | 19) => join(dirname(require.resolve(`${REACT_TYPES[major]}/package.json`)), 'index.d.ts');
export const REACT_QUERY_PACKAGES: Record<ReactQueryVersion, string> = { floor: '@tanstack/react-query-5.0', latest: '@tanstack/react-query' };
const reactQueryTypes = (version: ReactQueryVersion) => join(dirname(require.resolve(`${REACT_QUERY_PACKAGES[version]}/package.json`)), 'build/modern/index.d.ts');

const swrTypes = (version: SwrVersion): Record<string, string[]> => {
  const root = (name: string) => dirname(require.resolve(`${name}/package.json`));
  if (version === 'latest') {
    const dist = join(root('swr'), 'dist');
    return {
      swr: [join(dist, 'index/index.d.mts')],
      'swr/infinite': [join(dist, 'infinite/index.d.mts')],
      'swr/mutation': [join(dist, 'mutation/index.d.mts')],
      'swr/subscription': [join(dist, 'subscription/index.d.mts')],
    };
  }
  const floor = root('swr-floor');
  return {
    swr: [join(floor, 'core/dist/index.d.ts')],
    'swr/infinite': [join(floor, 'infinite/dist/index.d.ts')],
    'swr/mutation': [join(floor, 'mutation/dist/index.d.ts')],
    'swr/subscription': [join(floor, 'subscription/dist/index.d.ts')],
    'swr/_internal': [join(floor, '_internal/dist/index.d.ts')],
  };
};

/** Type-checks generated client source against the runtime sources; returns the diagnostics as strings. */
export function typecheck(source: string): string[] {
  return typecheckFiles({ 'client.ts': source });
}

/** Type-checks a set of files written side by side, with the types of React, React Query, swr, the socket client and a next/cache stub available. */
export function typecheckFiles(files: Record<string, string>, options: TypecheckOptions = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'client-gen-'));
  try {
    const roots = Object.entries(files).map(([name, contents]) => {
      const file = join(dir, name);
      writeFileSync(file, contents);
      return file;
    });
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    // swr 2.2.0 ships CommonJS typings only, which Node16 reads as a default import without call signatures; apps on it use a bundler.
    const floor = options.swr === 'floor';
    const program = ts.createProgram(roots, {
      strict: true,
      noEmit: true,
      noUnusedLocals: options.noUnusedLocals ?? false,
      module: floor ? ts.ModuleKind.ESNext : ts.ModuleKind.Node16,
      moduleResolution: floor ? ts.ModuleResolutionKind.Bundler : ts.ModuleResolutionKind.Node16,
      noUnusedParameters: options.noUnusedParameters ?? false,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      skipLibCheck: true,
      types: [],
      baseUrl: packageRoot,
      paths: {
        '@spinajs/client/runtime': ['src/runtime/index.ts'],
        '@spinajs/http-socket-common': ['../http-socket-common/src/index.ts'],
        '@spinajs/http-socket-client': ['../http-socket-client/src/index.ts'],
        react: [reactTypes(options.react ?? 19)],
        ...swrTypes(options.swr ?? 'latest'),
        '@tanstack/react-query': [reactQueryTypes(options.reactQuery ?? 'latest')],
        'next/cache': [fileURLToPath(new URL('./next-cache.d.ts', import.meta.url))],
      },
    });
    return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
