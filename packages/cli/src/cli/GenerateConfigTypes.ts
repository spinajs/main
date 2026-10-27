import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Manifest } from '@spinajs/manifest';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';

interface GenerateConfigTypesOptions {
  manifest: string;
  out: string;
  modules?: string;
}

@Command('generate:config-types', 'Writes ConfigPaths declarations from app.manifest.json')
@Option('-m, --manifest <path>', false, 'application manifest file', 'app.manifest.json')
@Option('-o, --out <path>', false, 'declaration file to write', 'src/spinajs-config.d.ts')
@Option('--modules <list>', false, 'comma separated config modules to include')
export class GenerateConfigTypes extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  public async execute(options: GenerateConfigTypesOptions): Promise<void> {
    // Loaded lazily: the compiler pulls in the TypeScript compiler API.
    const { generateConfigDeclarations } = await import('@spinajs/compiler');

    const manifest = JSON.parse(readFileSync(resolve(options.manifest), 'utf8')) as Manifest;
    const modules = options.modules?.split(',').map((m) => m.trim()).filter((m) => m.length > 0);
    const source = await generateConfigDeclarations(manifest, { modules });

    const out = resolve(options.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, source);
    this.Log.info(`Wrote ${out}`);
  }
}
