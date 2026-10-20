import { CliCommand, Command, Argument, Option } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _move } from '../fp.js';
import { ensureProviders } from './fs.js';

interface MvOptions {
  dstFs?: string;
}

@Command('fs-mv', 'Moves a file or directory, optionally between filesystems')
@Argument('fs', true, 'Source filesystem name')
@Argument('src', true, 'Source path ( relative to source fs )')
@Argument('dst', true, 'Destination path')
@Option('-d, --dst-fs <dstFs>', false, 'Destination filesystem name ( defaults to source fs )')
export class FsMvCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, src: string, dst: string, options: MvOptions): Promise<void> {
    await ensureProviders();

    try {
      await _move(src, dst, fsName, options.dstFs);
      this.Log.success(
        { src, fsName, dst, dstFs: options.dstFs ?? fsName },
        'Moved ${src} ( ${fsName} ) -> ${dst} ( ${dstFs} )',
      );
    } catch (err) {
      this.Log.error({ error: err, src }, 'Cannot move ${src}');
      process.exitCode = 1;
    }
  }
}
