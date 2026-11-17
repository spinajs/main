import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Configuration, defaultMigrationDirs } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { publishedManifest, validateManifest } from '@spinajs/manifest';
import type { Manifest } from '@spinajs/manifest';
import { InvalidOperation } from '@spinajs/exceptions';
import { CliCommand, Command, Option } from '../index.js';
import { loadIr } from './AuthzExport.js';
import type { AuthzIrModule } from './AuthzExport.js';

interface BuildOptions {
  tsconfig: string;
  out: string;
  schemas?: boolean;
  failOnWarning?: boolean;
  allowNoDirs?: boolean;
  authzIr?: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every((k) => Object.hasOwn(value, k)) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k));

const COMBINE_ALGORITHMS = ['deny-overrides', 'permit-overrides', 'first-applicable'];

function isCombineEntry(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['algorithm'], ['models'])) return false;
  const { algorithm, models } = value;
  const known = (typeof algorithm === 'string' && COMBINE_ALGORITHMS.includes(algorithm)) || (isRecord(algorithm) && hasExactKeys(algorithm, ['opaque']) && typeof algorithm.opaque === 'string');
  return known && (models === undefined || (Array.isArray(models) && models.every((m) => typeof m === 'string')));
}

const isCombine = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['default'], ['types']) && isCombineEntry(value.default) && (value.types === undefined || (isRecord(value.types) && Object.values(value.types).every(isCombineEntry)));

const isPrincipal = (value: unknown): boolean => isRecord(value) && hasExactKeys(value, ['ceiling', 'delegation', 'ancestry', 'roles']) && typeof value.ceiling === 'boolean' && typeof value.delegation === 'boolean' && typeof value.ancestry === 'string' && isRecord(value.roles);

/** The top level of `PolicyIR`, which `validateIR` assumes: it checks references only, so an extra key or a wrong `version` would be hashed and recorded. */
function isPolicyIRShape(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'types', 'permissions', 'caveats', 'combine', 'principal', 'opaque'])) return false;
  return value.version === 1 && isRecord(value.types) && isRecord(value.permissions) && isRecord(value.caveats) && Array.isArray(value.opaque) && isCombine(value.combine) && isPrincipal(value.principal);
}

type Compiler = typeof import('@spinajs/compiler');
type AppDirs = import('@spinajs/compiler').AppDirs;
type ManifestPolicy = import('@spinajs/compiler').ManifestPolicy;

@Command('build', 'Analyze the application and write app.manifest.json')
@Option('--tsconfig <path>', false, 'tsconfig of the application; its directory is the application root', 'tsconfig.json')
@Option('-o, --out <path>', false, 'manifest file to write', 'app.manifest.json')
@Option('--schemas', false, 'derive JSON Schemas from TypeScript types (default)', true)
@Option('--no-schemas', false, 'skip schema derivation')
@Option('--fail-on-warning', false, 'exit with code 1 when the analyzer reports a warning')
@Option('--allow-no-dirs', false, 'build an app whose system.dirs name none of its folders: nothing loads from the manifest, its classes run only if something registers them')
@Option('--authz-ir <path>', false, 'policy IR written by authz:compile, recorded in the authz section of the manifest; relative to the application root', 'authz.ir.json')
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

  // Optional peer, loaded only when the app has the file.
  protected importIr(): Promise<AuthzIrModule> {
    return loadIr();
  }

  private async loadIrForBuild(): Promise<AuthzIrModule> {
    try {
      return await this.importIr();
    } catch (e) {
      if (e instanceof Error && isRecord(e.cause) && e.cause.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/authz-ir so that spinajs build can record the policy IR', { cause: e });
      throw e;
    }
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
    const policyPath = resolve(appRoot, options.authzIr ?? 'authz.ir.json');
    const policy = await this.policy(policyPath);
    const policyFile = relative(appRoot, policyPath).replaceAll(sep, '/');
    let built: Awaited<ReturnType<Compiler['buildAppManifest']>>;
    try {
      built = await buildAppManifest({ tsconfig, appRoot, out: resolve(options.out), schemaDerivation: options.schemas !== false, buildEnv: this.Config?.get<string | undefined>('process.env.APP_ENV', undefined), globalRouteMiddlewares: this.Config?.get<unknown>('http.routes.middlewares', undefined), ...this.appDirs(options), ...(policy ? { policy } : {}), policyFile });
    } catch (e) {
      if (!(e instanceof NoAppDirs)) throw e;
      this.write([...cwdWarnings, `error CMP007 - ${e.message}. ${NO_DIRS_FIX}`, ''].join('\n'));
      process.exitCode = 1;
      return;
    }

    const { manifest, written } = built;
    // The runtime skips this check for a manifest whose hash matches, so a file that fails it must not be left behind.
    const invalid = validateManifest(JSON.parse(JSON.stringify(manifest)));
    if (invalid.length > 0) {
      rmSync(written, { force: true });
      this.write([...cwdWarnings, `error CLI002 - the manifest fails its JSON Schema and was not kept: ${invalid.join('; ')}`, ''].join('\n'));
      process.exitCode = 1;
      return;
    }

    const lines = manifest.diagnostics.map((d) => `${d.severity} ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);
    const summarized = summarize(manifest.diagnostics);
    const counts = { ...summarized, warning: summarized.warning + cwdWarnings.length };
    this.write([...cwdWarnings, ...lines, ...this.summaryTable(manifest, counts), `manifest written to ${written}`, ''].join('\n'));

    if (counts.error > 0 || (options.failOnWarning === true && counts.warning > 0)) process.exitCode = 1;
  }

  /** `authz.ir.json` as the manifest records it: recomputed from the file, never copied. Undefined when the app has none. */
  private async policy(file: string): Promise<ManifestPolicy | undefined> {
    if (!existsSync(file)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isPolicyIRShape(parsed)) return { problem: 'not a policy IR' };
      const ir = await this.loadIrForBuild();
      // Below the top level validateIR still expects schema-valid input: a malformed type or binding throws, and the catch reports it.
      const invalid = ir.validateIR(parsed);
      if (invalid.length > 0) return { problem: `invalid IR: ${invalid.map((d) => d.code).join(', ')}` };
      return { ir: ir.canonicalize(parsed), policyHash: ir.policyHash(parsed) };
    } catch (e) {
      return { problem: e instanceof Error ? e.message : String(e) };
    }
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
      ['hash', manifest.hash],
    ];
    return rows.map(([name, value]) => `${name.padEnd(12)}${value}`);
  }
}
