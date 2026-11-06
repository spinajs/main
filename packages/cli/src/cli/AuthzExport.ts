import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';

interface AuthzExportOptions {
  ir: string;
  format: 'openfga';
  out?: string;
  strict?: boolean;
}

@Command('authz:export', 'Writes the policy IR as an OpenFGA model')
@Option({ flags: '--ir <path>', description: 'canonical PolicyIR JSON file', defaultValue: 'authz.ir.json' })
@Option({ flags: '--format <format>', description: 'output format', defaultValue: 'openfga', choices: ['openfga'] })
@Option({ flags: '-o, --out <path>', description: 'write the model to this file instead of stdout' })
@Option({ flags: '--strict', description: 'fail when a part of the policy has no exact OpenFGA form' })
export class AuthzExport extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  protected write(text: string): void {
    process.stdout.write(text);
  }

  public async execute(options: AuthzExportOptions): Promise<void> {
    const ir = await loadIr();
    const { dsl, warnings } = ir.writeOpenFga(JSON.parse(await readFile(options.ir, 'utf8')) as unknown, { strict: options.strict === true });
    for (const w of warnings) this.Log.warn(`authz:export: ${w}`);
    if (options.out === undefined) return this.write(dsl);
    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, dsl);
    this.Log.info(`OpenFGA model written to ${out}`);
  }
}

/** The part of `@spinajs/authz-ir` the commands call; typed here because authz-ir depends on cli through authz, so cli cannot reference it. */
export interface AuthzIrModule {
  writeOpenFga(ir: unknown, options: { strict: boolean }): { dsl: string; warnings: string[] };
  readOpenFga(dsl: string): unknown;
  irToRebacConfig(ir: unknown): { namespaces: unknown; permissions: unknown; problems: string[] };
}

const AUTHZ_IR = '@spinajs/authz-ir';

/** Loaded lazily: `@spinajs/authz-ir` is an optional peer, command discovery must not need it. */
export async function loadIr(): Promise<AuthzIrModule> {
  return (import(AUTHZ_IR) as Promise<AuthzIrModule>).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/authz-ir to use the authz commands', { cause: err });
    throw err;
  });
}
