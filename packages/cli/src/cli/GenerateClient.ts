import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Log, Logger } from '@spinajs/log-common';
import { CliCommand, Command, Option } from '../index.js';

interface GenerateClientOptions {
  manifest: string;
  out: string;
  module?: string;
  socket: boolean;
}

@Command('generate:client', 'Writes a typed client from app.manifest.json')
@Option('-m, --manifest <path>', false, 'application manifest file', 'app.manifest.json')
@Option('-o, --out <path>', false, 'output file', 'src/generated/client.ts')
@Option('--module <name>', false, 'import path of the client runtime', '@spinajs/client/runtime')
@Option('--no-socket', false, 'omit socket contracts')
export class GenerateClient extends CliCommand {
  @Logger('cli')
  protected Log: Log;

  public async execute(options: GenerateClientOptions): Promise<void> {
    // Loaded lazily: @spinajs/client is an optional peer, command discovery must not need it.
    const { readManifest } = await import('@spinajs/manifest');
    const { generateClient } = await import('@spinajs/client').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error('install @spinajs/client to use generate:client', { cause: err });
      throw err;
    });

    const manifest = await readManifest(options.manifest);
    const source = await generateClient({ manifest, moduleName: options.module, includeSocket: options.socket ? undefined : false });

    const out = resolve(options.out);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, source);
    this.Log.info(`Wrote ${out}`);
  }
}
