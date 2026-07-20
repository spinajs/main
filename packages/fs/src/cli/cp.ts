import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _copy } from '../fp.js';
import { ensureProviders } from './fs.js';

interface CpOptions {
  dstFs?: string;
}

@Command('fs-cp', 'Copies a file or directory, optionally between filesystems')
@Argument('fs', true, 'Source filesystem name')
@Argument('src', true, 'Source path ( relative to source fs )')
@Argument('dst', true, 'Destination path')
@Option('-d, --dst-fs <dstFs>', false, 'Destination filesystem name ( defaults to source fs )')
export class FsCpCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, src: string, dst: string, options: CpOptions): Promise<void> {
    await ensureProviders();

    try {
      await _copy(src, dst, fsName, options.dstFs);
      this.Log.success(`Copied ${src} ( ${fsName} ) -> ${dst} ( ${options.dstFs ?? fsName} )`);
    } catch (err) {
      this.Log.error(`Cannot copy ${src}: ${err.message}`);
    }
  }
}
