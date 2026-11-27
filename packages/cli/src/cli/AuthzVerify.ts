import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliCommand, Command, Option } from '../index.js';

interface AssertionSet {
  readonly assertions: readonly unknown[];
}

/**
 * The part of `@spinajs/authz-verify` this command calls. Typed here rather than imported: that package depends on
 * `@spinajs/authz`, which depends on this CLI, so a project reference would be circular.
 */
interface VerifyResult {
  readonly diagnostics: readonly { readonly code: string }[];
}

interface VerifyModule {
  verifyAssertions(ir: unknown, set: AssertionSet, options: { k: number; requireSolver: boolean }): Promise<VerifyResult[]>;
  formatResults(results: VerifyResult[], format: 'text' | 'json' | 'github'): string[];
  summarize(results: VerifyResult[]): { error: number; warning: number; info: number };
  releaseSolver(): Promise<void>;
}

const VERIFY_MODULE = '@spinajs/authz-verify';
/** The warning of a holds that only the bounded engine found: `--fail-on bounded` fails on it and on errors, not on other warnings. */
const BOUNDED_HOLDS = 'AZV007';

interface AuthzVerifyOptions {
  ir: string;
  assertions: string;
  format: 'text' | 'json' | 'github';
  bound: number;
  requireSolver?: boolean;
  failOn: 'warning' | 'error' | 'bounded';
}

const isAssertionSet = (v: unknown): v is AssertionSet => typeof v === 'object' && v !== null && Array.isArray((v as { assertions?: unknown }).assertions);

@Command('authz:verify', 'Checks the authorization assertions of an app against its policy IR')
@Option('--ir <path>', false, 'canonical policy IR (JSON)', 'authz.ir.json')
@Option('-a, --assertions <path>', false, 'module whose default export is defineAssertions(...)', 'authz.assertions.js')
@Option({ flags: '-f, --format <format>', description: 'output format', defaultValue: 'text', choices: ['text', 'json', 'github'] })
@Option('-k, --bound <k>', false, 'objects per type for the bounded engine', 3, (v: string) => Number.parseInt(v, 10))
@Option('--require-solver', false, 'report a missing z3-solver (AZV090) as an error')
@Option({ flags: '--fail-on <severity>', description: 'severity that sets a non-zero exit code (bounded: errors and holds only up to k)', defaultValue: 'error', choices: ['warning', 'error', 'bounded'] })
export class AuthzVerifyCommand extends CliCommand {
  public async execute(options: AuthzVerifyOptions): Promise<void> {
    // Loaded lazily: @spinajs/authz-verify (and its optional z3-solver) is a development tool and an optional peer.
    const verify = await (import(VERIFY_MODULE) as Promise<VerifyModule>).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/authz-verify to use authz:verify', { cause: err });
      throw err;
    });
    const ir: unknown = JSON.parse(await readFile(resolve(process.cwd(), options.ir), 'utf8'));
    const loaded = (await import(pathToFileURL(resolve(process.cwd(), options.assertions)).href)) as { default?: unknown };
    if (!isAssertionSet(loaded.default)) throw new Error(`${options.assertions} must export defineAssertions(...) as its default export`);
    try {
      const results = await verify.verifyAssertions(ir, loaded.default, { k: options.bound, requireSolver: options.requireSolver === true });
      for (const line of verify.formatResults(results, options.format)) this.Print(line);
      const s = verify.summarize(results);
      const bounded = results.some((r) => r.diagnostics.some((d) => d.code === BOUNDED_HOLDS));
      if (s.error > 0 || (options.failOn === 'warning' && s.warning > 0) || (options.failOn === 'bounded' && bounded)) process.exitCode = 1;
    } finally {
      await verify.releaseSolver();
    }
  }

  // Machine-readable output must not go through the logger's layout.
  protected Print(line: string): void {
    process.stdout.write(`${line}\n`);
  }
}
