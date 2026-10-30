import { dirname, resolve } from 'node:path';
import type { Manifest } from '@spinajs/manifest';
import { InvalidOperation } from '@spinajs/exceptions';
import { CliCommand, Command, Option } from '../index.js';

interface BuildOptions {
  tsconfig: string;
  out: string;
  schemas?: boolean;
  failOnWarning?: boolean;
}

type Compiler = typeof import('@spinajs/compiler');

@Command('build', 'Analyze the application and write app.manifest.json')
@Option('--tsconfig <path>', false, 'tsconfig of the application; its directory is the application root', 'tsconfig.json')
@Option('-o, --out <path>', false, 'manifest file to write', 'app.manifest.json')
@Option('--schemas', false, 'derive JSON Schemas from TypeScript types (default)', true)
@Option('--no-schemas', false, 'skip schema derivation')
@Option('--fail-on-warning', false, 'exit with code 1 when the analyzer reports a warning')
export class Build extends CliCommand {
  protected write(text: string): void {
    process.stdout.write(text);
  }

  // Optional peer, loaded lazily: the compiler pulls in the TypeScript compiler API.
  protected importCompiler(): Promise<Compiler> {
    return import('@spinajs/compiler');
  }

  private async loadCompiler(): Promise<Compiler> {
    try {
      return await this.importCompiler();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes('@spinajs/compiler')) {
        throw new InvalidOperation('install @spinajs/compiler to use build');
      }
      throw e;
    }
  }

  public async execute(options: BuildOptions): Promise<void> {
    const { buildAppManifest, summarize } = await this.loadCompiler();

    const tsconfig = resolve(options.tsconfig);
    const { manifest, written } = await buildAppManifest({
      tsconfig,
      appRoot: dirname(tsconfig),
      out: resolve(options.out),
      schemaDerivation: options.schemas !== false,
    });

    const lines = manifest.diagnostics.map((d) => `${d.severity} ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);
    const counts = summarize(manifest.diagnostics);
    this.write([...lines, ...this.summaryTable(manifest, counts), `manifest written to ${written}`, ''].join('\n'));

    if (counts.error > 0 || (options.failOnWarning === true && counts.warning > 0)) process.exitCode = 1;
  }

  private summaryTable(manifest: Manifest, counts: { error: number; warning: number; info: number }): string[] {
    const rows: [string, string | number][] = [
      ['services', manifest.services.length],
      ['controllers', manifest.controllers.length],
      ['routes', manifest.controllers.reduce((n, c) => n + c.routes.length, 0)],
      ['models', manifest.models.length],
      ['schemas', Object.keys(manifest.schemas).length],
      ['diagnostics', `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`],
    ];
    return rows.map(([name, value]) => `${name.padEnd(12)}${value}`);
  }
}
