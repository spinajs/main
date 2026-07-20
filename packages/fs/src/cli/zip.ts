import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _fs } from '../fp.js';
import { IOFail } from '@spinajs/exceptions';
import { ensureProviders } from './fs.js';

interface ZipOptions {
  out?: string;
  dstFs?: string;
}

@Command('fs-zip', 'Compresses files / directories into a zip archive')
@Argument('fs', true, 'Source filesystem name')
@Argument('paths', true, 'Comma separated paths to compress ( relative to source fs )')
@Option('-o, --out <out>', false, 'Output zip file name ( relative to destination fs )')
@Option('-d, --dst-fs <dstFs>', false, 'Destination filesystem for the archive ( default fs-temp )')
export class FsZipCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, paths: string, options: ZipOptions): Promise<void> {
    await ensureProviders();

    try {
      const provider = _fs(fsName)();

      if (!provider) {
        throw new IOFail(`Filesystem ${fsName} not found`);
      }

      const list = paths
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const dstFs = options.dstFs ? _fs(options.dstFs)() : undefined;
      const result = await provider.zip(list, dstFs, options.out);

      this.Log.success(`Zipped ${list.length} path(s) -> ${result.asFilePath()} ( fs: ${result.fs.Name} )`);
    } catch (err) {
      this.Log.error(`Cannot zip on ${fsName}: ${err.message}`);
    }
  }
}
