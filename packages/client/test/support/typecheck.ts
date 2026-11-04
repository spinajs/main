import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SwrVersion = 'floor' | 'latest';

export interface TypecheckOptions {
  noUnusedLocals?: boolean;
  /** Major of the React types `react` resolves to; the peer range covers both. Default 19. */
  react?: 18 | 19;
  /** Which swr the `swr` imports resolve to: the peer floor (2.2.0) or the installed latest. Default latest. */
  swr?: SwrVersion;
}

const require = createRequire(import.meta.url);
const REACT_TYPES = { 18: '@types/react-18', 19: '@types/react' } as const;
const reactTypes = (major: 18 | 19) => join(dirname(require.resolve(`${REACT_TYPES[major]}/package.json`)), 'index.d.ts');

const swrTypes = (version: SwrVersion): Record<string, string[]> => {
  const root = (name: string) => dirname(require.resolve(`${name}/package.json`));
  if (version === 'latest') {
    const dist = join(root('swr'), 'dist');
    return { swr: [join(dist, 'index/index.d.mts')], 'swr/mutation': [join(dist, 'mutation/index.d.mts')] };
  }
  const floor = root('swr-floor');
  return { swr: [join(floor, 'core/dist/index.d.ts')], 'swr/mutation': [join(floor, 'mutation/dist/index.d.ts')], 'swr/_internal': [join(floor, '_internal/dist/index.d.ts')] };
};

/** Type-checks generated client source against the runtime sources; returns the diagnostics as strings. */
export function typecheck(source: string): string[] {
  return typecheckFiles({ 'client.ts': source });
}

/** Type-checks a set of files written side by side, with React's types available as `react`. */
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
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      skipLibCheck: true,
      types: [],
      baseUrl: packageRoot,
      paths: {
        '@spinajs/client/runtime': ['src/runtime/index.ts'],
        '@spinajs/http-socket-common': ['../http-socket-common/src/index.ts'],
        react: [reactTypes(options.react ?? 19)],
        ...swrTypes(options.swr ?? 'latest'),
      },
    });
    return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
