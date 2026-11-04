import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TypecheckOptions {
  noUnusedLocals?: boolean;
  noUnusedParameters?: boolean;
  /** Major of the React types `react` resolves to; the peer range covers both. Default 19. */
  react?: 18 | 19;
  /** `@tanstack/react-query` at the peer floor (5.0.0) or the pinned latest. Default latest. */
  reactQuery?: ReactQueryVersion;
}

export type ReactQueryVersion = 'floor' | 'latest';

const require = createRequire(import.meta.url);
const REACT_TYPES = { 18: '@types/react-18', 19: '@types/react' } as const;
const reactTypes = (major: 18 | 19) => join(dirname(require.resolve(`${REACT_TYPES[major]}/package.json`)), 'index.d.ts');
export const REACT_QUERY_PACKAGES: Record<ReactQueryVersion, string> = { floor: '@tanstack/react-query-5.0', latest: '@tanstack/react-query' };
const reactQueryTypes = (version: ReactQueryVersion) => join(dirname(require.resolve(`${REACT_QUERY_PACKAGES[version]}/package.json`)), 'build/modern/index.d.ts');

/** Type-checks generated client source against the runtime sources; returns the diagnostics as strings. */
export function typecheck(source: string): string[] {
  return typecheckFiles({ 'client.ts': source });
}

/** Type-checks a set of files written side by side, with React's and React Query's types available. */
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
    const program = ts.createProgram(roots, {
      strict: true,
      noEmit: true,
      noUnusedLocals: options.noUnusedLocals ?? false,
      noUnusedParameters: options.noUnusedParameters ?? false,
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      skipLibCheck: true,
      types: [],
      baseUrl: packageRoot,
      paths: {
        '@spinajs/client/runtime': ['src/runtime/index.ts'],
        '@spinajs/http-socket-common': ['../http-socket-common/src/index.ts'],
        react: [reactTypes(options.react ?? 19)],
        '@tanstack/react-query': [reactQueryTypes(options.reactQuery ?? 'latest')],
      },
    });
    return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
