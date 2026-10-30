import { dirname, resolve } from 'node:path';
import { Configuration, defaultMigrationDirs } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
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
  /** Absent only for a command built by hand, which filters nothing. */
  @Autoinject(Configuration)
  protected Config?: Configuration;

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
      effectiveDirs: this.effectiveDirs(),
    });

    const lines = manifest.diagnostics.map((d) => `${d.severity} ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);
    const counts = summarize(manifest.diagnostics);
    this.write([...lines, ...this.summaryTable(manifest, counts), `manifest written to ${written}`, ''].join('\n'));

    if (counts.error > 0 || (options.failOnWarning === true && counts.warning > 0)) process.exitCode = 1;
  }

  /**
   * What discovery scans in this process: the configuration already merged the app's config for this `APP_ENV` and added
   * the `RunApp` dirs. A scan reads a relative dir from the working directory and takes a single string as well.
   */
  private effectiveDirs(): Record<string, string[]> | undefined {
    if (!this.Config) return undefined;
    const dirs = this.Config.get<Record<string, unknown>>(['system', 'dirs'], {});
    const paths = (value: unknown): string[] => [value].flat().filter((d) => typeof d === 'string').map((d) => resolve(d));
    const effective = Object.fromEntries(Object.entries(dirs).map(([key, value]) => [key, paths(value)]));
    // FilesystemMigrationSource scans its defaults only while this key is empty: the configured value replaces them
    return { ...effective, migrations: effective.migrations?.length ? effective.migrations : defaultMigrationDirs() };
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
