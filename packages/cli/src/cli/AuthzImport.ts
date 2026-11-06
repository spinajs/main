import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';
import { loadIr } from './AuthzExport.js';

interface AuthzImportOptions {
  format: 'openfga';
  out: string;
  strict?: boolean;
}

@Command('authz:import <model>', 'Turns an OpenFGA model into an authz.rebac config fragment')
@Option({ flags: '--format <format>', description: 'input format', defaultValue: 'openfga', choices: ['openfga'] })
@Option({ flags: '-o, --out <path>', description: 'config fragment to write', defaultValue: 'authz.rebac.json' })
@Option({ flags: '--strict', description: 'fail when a part of the model has no authz.rebac form' })
export class AuthzImport extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  public async execute(model: string, options: AuthzImportOptions): Promise<void> {
    const ir = await loadIr();
    const { namespaces, permissions, problems } = ir.irToRebacConfig(ir.readOpenFga(await readFile(model, 'utf8')));
    for (const p of problems) this.Log.warn(`authz:import: ${p}`);
    if (options.strict === true && problems.length > 0) throw new Error(`authz:import --strict: ${problems.length} part(s) of ${model} have no authz.rebac form`);
    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify({ authz: { rebac: { namespaces, permissions } } }, null, 2)}\n`);
    this.Log.info(`authz.rebac config written to ${out}`);
  }
}
