import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TypecheckOptions {
  /** Also report unused locals and parameters, as an app compiling with `noUnusedLocals` and `noUnusedParameters` does. */
  unused?: boolean;
}

export interface TypecheckResult {
  diagnostics: string[];
  /** The checker's type instantiation count: deterministic for one TypeScript version, unlike wall-clock time. */
  instantiations: number;
}

/** Type-checks generated client source against the runtime sources. */
export function typecheckProgram(source: string, options: TypecheckOptions = {}): TypecheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'client-gen-'));
  try {
    const file = join(dir, 'client.ts');
    writeFileSync(file, source);
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
    const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      ...(options.unused ? { noUnusedLocals: true, noUnusedParameters: true } : {}),
      module: ts.ModuleKind.Node16,
      moduleResolution: ts.ModuleResolutionKind.Node16,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
      types: [],
      baseUrl: packageRoot,
      paths: {
        '@spinajs/client/runtime': ['src/runtime/index.ts'],
        '@spinajs/http-socket-common': ['../http-socket-common/src/index.ts'],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    return { diagnostics, instantiations: program.getInstantiationCount() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Type-checks generated client source against the runtime sources; returns the diagnostics as strings. */
export function typecheck(source: string, options: TypecheckOptions = {}): string[] {
  return typecheckProgram(source, options).diagnostics;
}
