import { resolve } from 'node:path';
import { Autoinject } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration-common';
import type { Diagnostic } from '@spinajs/manifest';
import { CliCommand, Command, Option } from '../index.js';

type DoctorFormat = 'text' | 'json' | 'github';

interface DoctorOptions {
  manifest: string;
  config?: boolean;
  format: DoctorFormat;
  failOn: 'warning' | 'error';
}

@Command('doctor', 'Checks app.manifest.json for registration, routing and configuration problems')
@Option('-m, --manifest <path>', false, 'manifest file written by spinajs build', 'app.manifest.json')
@Option('-c, --config', false, 'also validate system.dirs and conditional registrations against the loaded configuration')
@Option('-f, --format <format>', false, 'output format: text, json or github', 'text')
@Option('--fail-on <severity>', false, 'severity that sets a non-zero exit code: warning or error', 'error')
export class DoctorCommand extends CliCommand {
  @Autoinject()
  protected Config: Configuration;

  public async execute(options: DoctorOptions): Promise<void> {
    // Loaded lazily: @spinajs/compiler is an optional peer, command discovery must not need it.
    const { readManifest } = await import('@spinajs/manifest');
    const { runDoctor, createDoctorContext, formatDiagnostics, summarize } = await import('@spinajs/compiler').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/compiler to use doctor', { cause: err });
      throw err;
    });

    const path = resolve(process.cwd(), options.manifest);
    let diagnostics: Diagnostic[];
    try {
      const manifest = await readManifest(path);
      const config = options.config ? (this.Config.RootConfig as Record<string, unknown>) : undefined;
      diagnostics = runDoctor(manifest, createDoctorContext(manifest, { cwd: process.cwd(), config }));
    } catch {
      diagnostics = [{ code: 'DOCTOR', severity: 'error', message: `Cannot read manifest ${path}: run spinajs build first` }];
    }

    for (const line of formatDiagnostics(diagnostics, options.format)) this.Print(line);

    const s = summarize(diagnostics);
    if (options.failOn === 'warning' ? s.error + s.warning > 0 : s.error > 0) process.exitCode = 1;
  }

  // Machine-readable output must not go through the logger's layout.
  protected Print(line: string): void {
    process.stdout.write(`${line}\n`);
  }
}
