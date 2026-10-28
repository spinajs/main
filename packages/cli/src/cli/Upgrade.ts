import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';

interface UpgradeOptions {
  to: string;
  dryRun?: boolean;
}

type Codemods = typeof import('@spinajs/codemods');

@Command('upgrade', 'Apply codemods for a major version')
@Option('--to <major>', true, 'target major version (supported: 4)')
@Option('--dry-run', false, 'list the files that would change, write nothing')
export class Upgrade extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  public async execute(options: UpgradeOptions): Promise<void> {
    if (options.to !== '4') {
      throw new Error(`Unsupported target major "${options.to}"; supported: 4`);
    }

    const { runTransforms, V4_TRANSFORMS } = await this.loadCodemods();
    const { changedFiles, failedFiles, warnings, scannedFiles } = await runTransforms({ cwd: process.cwd(), transforms: V4_TRANSFORMS, dryRun: options.dryRun === true });

    for (const file of changedFiles) {
      this.Log.info(`${options.dryRun ? 'would change' : 'changed'} ${file}`);
    }
    for (const w of warnings) {
      this.Log.warn(`${w.file}:${w.line} ${w.message}`);
    }
    for (const f of failedFiles) {
      this.Log.error(`${f.file} left untouched: ${f.transform} failed: ${f.error}`);
    }
    if (failedFiles.length > 0) {
      process.exitCode = 1;
    }
    if (scannedFiles === 0) {
      this.Log.warn('no source files found: only files matched by tsconfig.json (include/files) are visited, JS and CJS files included');
    }
    this.Log.info(`${changedFiles.length} file(s) ${options.dryRun ? 'would change' : 'changed'}, ${failedFiles.length} failed, ${warnings.length} to check by hand; see docs/upgrading/4.0.md for the manual steps`);
  }

  protected importCodemods(): Promise<Codemods> {
    return import('@spinajs/codemods');
  }

  protected async loadCodemods(): Promise<Codemods> {
    try {
      return await this.importCodemods();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes('@spinajs/codemods')) {
        throw new Error('Install @spinajs/codemods to use upgrade: npm i -D @spinajs/codemods', { cause: err });
      }
      throw err;
    }
  }
}
