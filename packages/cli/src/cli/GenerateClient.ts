import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';
import { outputPaths, parseList, toFilesOptions, unavailableFlag, type GenerateClientFlags } from '../generateClientFlags.js';

@Command('generate:client', 'Writes a typed client from app.manifest.json')
@Option('-m, --manifest <path>', false, 'application manifest file', 'app.manifest.json')
@Option('-o, --out <path>', false, 'output file; companion files are written next to it', 'src/generated/client.ts')
@Option('--module <name>', false, 'import path of the client runtime', '@spinajs/client/runtime')
@Option('--no-socket', false, 'omit socket contracts')
@Option({ flags: '--hooks <list>', description: 'comma-separated hooks targets: react-query, swr', parser: parseList })
@Option('--zod', false, 'write zod schemas')
@Option('--zod-mini', false, 'use zod/mini (needs --zod)')
@Option('--zod-replies', false, 'also write lenient reply schemas (needs --zod)')
@Option({ flags: '--zod-unsupported <mode>', description: 'what to do with a keyword zod cannot express (needs --zod)', choices: ['warn', 'error'] })
@Option('--models', false, 'decode replies and encode requests into app types')
@Option('--socket-hooks', false, 'add socket hooks to the hooks files (needs --hooks)')
@Option('--key-prefix <name>', false, 'first element of every generated query key')
@Option('--server', false, 'write the server-safe client')
@Option('--next', false, 'write the Next.js adapter (implies --server)')
@Option('--mocks', false, 'write mock data and a fake client')
@Option('--msw', false, 'also write MSW handlers (needs --mocks)')
@Option('--check', false, 'write nothing; exit with code 1 and list the files that differ from disk')
export class GenerateClient extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  public async execute(options: GenerateClientFlags): Promise<void> {
    // Loaded lazily: @spinajs/client is an optional peer, command discovery must not need it.
    const { readManifest } = await import('@spinajs/manifest');
    const { generateClientFiles, GENERATOR_TARGETS } = await import('@spinajs/client').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/client to use generate:client', { cause: err });
      throw err;
    });

    const filesOptions = toFilesOptions(options);
    const refused = unavailableFlag(options, GENERATOR_TARGETS);
    if (refused) throw new Error(`${refused} is not available in this version`);

    const out = resolve(options.out);
    const files = await generateClientFiles({ ...filesOptions, manifest: await readManifest(options.manifest), basename: basename(out, extname(out)) });
    const targets = outputPaths(out, files);

    if (options.check) {
      await this.check(targets);
      return;
    }

    await mkdir(dirname(out), { recursive: true });
    for (const file of targets) {
      await writeFile(file.path, file.contents);
      this.Log.info(`Wrote ${file.path}`);
    }
  }

  private async check(targets: { path: string; contents: string }[]): Promise<void> {
    const stale: string[] = [];
    for (const { path, contents } of targets) {
      const onDisk = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      // A checkout with autocrlf rewrites line endings; that is not a stale file.
      if (onDisk === undefined) stale.push(`${path} (missing)`);
      else if (onDisk.replace(/\r\n/g, '\n') !== contents) stale.push(`${path} (differs)`);
    }
    if (stale.length === 0) return;

    process.stderr.write(`${stale.length} generated file(s) out of date; run generate:client without --check:\n${stale.map((s) => `  ${s}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}
