import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _fs } from '../fp.js';
import { IOFail } from '@spinajs/exceptions';
import { ensureProviders } from './fs.js';

interface UnzipOptions {
  dstFs?: string;
}

@Command('fs-unzip', 'Extracts a zip archive')
@Argument('fs', true, 'Filesystem that contains the archive')
@Argument('src', true, 'Path to the zip file ( relative to source fs )')
@Argument('dst', false, 'Destination directory ( relative to destination fs )')
@Option('-d, --dst-fs <dstFs>', false, 'Destination filesystem to extract into ( defaults to source fs )')
export class FsUnzipCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, src: string, dst: string | undefined, options: UnzipOptions): Promise<void> {
    await ensureProviders();

    try {
      const provider = _fs(fsName)();

      if (!provider) {
        throw new IOFail(`Filesystem ${fsName} not found`);
      }

      const dstFs = options.dstFs ? _fs(options.dstFs)() : undefined;
      const out = await provider.unzip(src, dst, dstFs);

      this.Log.success(`Extracted ${src} -> ${out} ( fs: ${options.dstFs ?? fsName} )`);
    } catch (err) {
      this.Log.error(`Cannot unzip ${src} on ${fsName}: ${err.message}`);
    }
  }
}
