import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ZOD_ROOT points the checks at another zod install, such as the oldest version the peer range allows.
export const zodRoot = process.env.ZOD_ROOT ?? dirname(fileURLToPath(import.meta.resolve('zod')));

/** Type-checks generated client source against the runtime sources; returns the diagnostics as strings. */
export function typecheck(source: string): string[] {
  return typecheckFiles({ 'client.ts': source });
}

/** Type-checks generated files side by side (`client.ts`, `client.zod.ts`, ...) against the package sources and the installed zod. */
export function typecheckFiles(files: Record<string, string>, options: ts.CompilerOptions = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'client-gen-'));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const program = ts.createProgram(
      Object.keys(files).map((name) => join(dir, name)),
      {
        strict: true,
        noEmit: true,
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        target: ts.ScriptTarget.ES2022,
        skipLibCheck: true,
        types: [],
        baseUrl: packageRoot,
        paths: {
          '@spinajs/client/runtime': ['src/runtime/index.ts'],
          '@spinajs/client/formats': ['src/formats/index.ts'],
          '@spinajs/client/mocks': ['src/mocks/index.ts'],
          '@spinajs/http-socket-common': ['../http-socket-common/src/index.ts'],
          msw: [join(dirname(fileURLToPath(import.meta.resolve('msw'))), 'index.d.ts')],
          zod: [join(zodRoot, 'index.d.ts')],
          'zod/mini': [join(zodRoot, 'mini/index.d.ts')],
        },
        ...options,
      },
    );
    return ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? `${d.file.fileName.slice(dir.length + 1)}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
