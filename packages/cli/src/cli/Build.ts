import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Configuration, defaultMigrationDirs } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { publishedManifest } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';
import { InvalidOperation } from '@spinajs/exceptions';
import { CliCommand, Command, Option } from '../index.js';

interface BuildOptions {
  tsconfig: string;
  out: string;
  schemas?: boolean;
  failOnWarning?: boolean;
  allowNoDirs?: boolean;
}

const NO_DIRS_FIX = "Compile the app's config, run the build from the folder the app runs from with the --app, --apppath, --config-path and --env it runs with, or pass --allow-no-dirs for an app that declares no dirs";

// A release folder behind a symlink gives a logical tsconfig and a physical working directory, or the other way round, and
// a dir may not exist yet: the deepest part that exists decides.
function physical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(physical(parent), basename(path));
}

// A linked package's real path no longer says node_modules, which is what marks it as not the app's.
const dirOf = (dir: string): string => (resolve(dir).split(sep).includes('node_modules') ? resolve(dir) : physical(resolve(dir)));

const entriesOf = (m: Manifest): number => m.controllers.length + m.socketControllers.length + m.schedules.length + m.commands.length + m.migrations.length;

type Compiler = typeof import('@spinajs/compiler');
type AppDirs = import('@spinajs/compiler').AppDirs;

@Command('build', 'Analyze the application and write app.manifest.json')
@Option('--tsconfig <path>', false, 'tsconfig of the application; its directory is the application root', 'tsconfig.json')
@Option('-o, --out <path>', false, 'manifest file to write', 'app.manifest.json')
@Option('--schemas', false, 'derive JSON Schemas from TypeScript types (default)', true)
@Option('--no-schemas', false, 'skip schema derivation')
@Option('--fail-on-warning', false, 'exit with code 1 when the analyzer reports a warning')
@Option('--allow-no-dirs', false, 'build an app whose system.dirs name none of its folders: nothing loads from the manifest, its classes run only if something registers them')
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
    const { buildAppManifest, summarize, NoAppDirs } = await this.loadCompiler();

    const tsconfig = physical(resolve(options.tsconfig));
    const appRoot = dirname(tsconfig);
    const cwdWarnings = this.cwdWarnings(appRoot);
    let built: Awaited<ReturnType<Compiler['buildAppManifest']>>;
    try {
      built = await buildAppManifest({ tsconfig, appRoot, out: resolve(options.out), schemaDerivation: options.schemas !== false, ...this.appDirs(options) });
    } catch (e) {
      if (!(e instanceof NoAppDirs)) throw e;
      this.write([...cwdWarnings, `error CMP007 - ${e.message}. ${NO_DIRS_FIX}`, ''].join('\n'));
      process.exitCode = 1;
      return;
    }

    const { manifest, written } = built;
    const lines = manifest.diagnostics.map((d) => `${d.severity} ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);
    const summarized = summarize(manifest.diagnostics);
    const counts = { ...summarized, warning: summarized.warning + cwdWarnings.length };
    this.write([...cwdWarnings, ...lines, ...this.summaryTable(manifest, counts), `manifest written to ${written}`, ''].join('\n'));

    if (counts.error > 0 || (options.failOnWarning === true && counts.warning > 0)) process.exitCode = 1;
  }

  // Not refused: an app that runs from its build folder gets the right dirs here, and only here.
  private cwdWarnings(appRoot: string): string[] {
    const cwd = physical(process.cwd());
    if (!this.Config || relative(cwd, appRoot) === '') return [];
    return [`warning CLI001 - the working directory ${cwd} is not the app root ${appRoot}: system.dirs and the default dirs were computed from the working directory, so run the build from the folder the app runs from`];
  }

  /**
   * What discovery scans in this process: the configuration already merged the app's config for this `APP_ENV` and added
   * the `RunApp` dirs. A scan reads a relative dir from the working directory and takes a single string as well.
   */
  private appDirs(options: BuildOptions): AppDirs | undefined {
    if (!this.Config) return undefined;
    const dirs = this.Config.get<Record<string, unknown>>(['system', 'dirs'], {});
    const paths = (value: unknown): string[] => [value].flat().filter((d) => typeof d === 'string').map(dirOf);
    const effectiveDirs = Object.fromEntries(Object.entries(dirs).map(([key, value]) => [key, paths(value)]));
    const { RunApp, AppBaseDir } = this.Config;
    const runAppRoot = RunApp ? dirOf(join(AppBaseDir, RunApp)) : undefined;
    return { effectiveDirs, defaultDirs: { migrations: defaultMigrationDirs().map(physical) }, requireAppDirs: options.allowNoDirs !== true, runAppRoot };
  }

  private summaryTable(manifest: Manifest, counts: { error: number; warning: number; info: number }): string[] {
    const loaded = publishedManifest(manifest);
    const rows: [string, string | number][] = [
      ['services', manifest.services.length],
      ['controllers', loaded.controllers.length],
      ['routes', loaded.controllers.reduce((n, c) => n + c.routes.length, 0)],
      ['not loaded', entriesOf(manifest) - entriesOf(loaded)],
      ['models', manifest.models.length],
      ['schemas', Object.keys(manifest.schemas).length],
      ['diagnostics', `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`],
    ];
    return rows.map(([name, value]) => `${name.padEnd(12)}${value}`);
  }
}
